/** First-start preset seeding wired into the desktop workspace startup path. */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import {
  appendBundledPluginFailure,
  hasBundledPluginSeedMarker,
  seedBundledPluginsBatch,
  type BundledPluginManifestEntry,
} from './bundled-plugin-seed.ts'
import { BundledPluginInstaller, parseBundledPluginManifest, resolveBundledPluginResourcesDirectory } from './bundled-plugin-installer.ts'
import { BundledPluginStartupCooldown } from './bundled-plugin-cooldown.ts'
import { BundledPresetVersionGate } from './bundled-preset-version-gate.ts'
import { desktopNodeEnvironment } from './node-environment.ts'
import { DESKTOP_PROFILE_BUNDLES } from './project-manager.ts'
import { DEFAULT_PROFILE_BUNDLES, initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

/** Upper bound for one seeded preset installation, shared with the upstream mechanism. */
export const BUNDLED_PLUGIN_INSTALL_TIMEOUT_MS = 10 * 60_000
/** Total first-start pass budget for non-first starts; a first start attempts every entry. */
export const BUNDLED_PLUGIN_STARTUP_BUDGET_MS = 120_000
const DIAGNOSTIC_LIMIT = 4_000

/** One finished desktop-owned Harness CLI command. */
export interface DesktopHarnessCommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Resolved command line and environment for one desktop-owned Harness CLI command. */
export interface DesktopHarnessCommandInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly cwd: string
}

/** Executable form of one desktop-owned Harness CLI command. */
export type RunDesktopHarnessCommand = (
  invocation: DesktopHarnessCommandInvocation,
) => Promise<DesktopHarnessCommandResult>

/** One entry's seed outcome in the startup report. */
export interface DesktopBundledPluginStartupEntry {
  readonly entry: BundledPluginManifestEntry
  readonly result?: 'installed' | 'upgraded' | 'verified' | 'preserved-user-version' | 'removed' | 'unresolved'
}

/** Observable outcome of one desktop startup's bundled-plugin pass. */
export interface DesktopBundledPluginStartupReport {
  readonly firstStart: boolean
  readonly attempted: boolean
  readonly gateSkipped?: 'already-attempted' | 'marker-unavailable'
  readonly results?: readonly DesktopBundledPluginStartupEntry[]
  /** Diagnostic-only first-start batch failure; the workspace still starts. */
  readonly failure?: unknown
}

/** Inputs the desktop main process supplies to the startup seeding pass. */
export interface DesktopBundledPluginStartupOptions {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly sourceRoot: string
  readonly dshHome: string
  readonly appVersion: string
  readonly nodeExecutable: string
  /** Harness runtime tree containing `node_modules/@deepseek-ai/dsh/lib/bin.js`. */
  readonly dshDirectory: string
  /** Node launcher directory prepended to PATH for package-manager subprocesses. */
  readonly nodeBin: string
  readonly isQuitting?: () => boolean
  readonly now?: () => number
  readonly runCommand?: RunDesktopHarnessCommand
  /** Progress diagnostics; defaults to console.info. */
  readonly log?: (message: string) => void
}

/** Failure raised when one seeded command exits nonzero or misses its deadline. */
export class DesktopHarnessCommandError extends Error {
  constructor(
    message: string,
    readonly invocation: DesktopHarnessCommandInvocation,
    readonly result?: DesktopHarnessCommandResult,
  ) {
    super(message)
  }
}

/** Resolve the bundled CLI entry inside a Harness runtime tree. */
export function resolveHarnessCliEntry(dshDirectory: string): string {
  return join(dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function harnessLogPath(dshHome: string): string {
  return join(dshHome, 'logs', 'harness.log')
}

function tail(value: string): string {
  return value.length <= DIAGNOSTIC_LIMIT ? value : value.slice(-DIAGNOSTIC_LIMIT)
}

function commandDiagnostic(
  invocation: DesktopHarnessCommandInvocation,
  result?: DesktopHarnessCommandResult,
): string {
  const output = result === undefined ? '' : `\nstdout: ${tail(result.stdout)}\nstderr: ${tail(result.stderr)}`
  return `desktop: harness command failed: ${invocation.args.join(' ')}${output}`
}

/**
 * Run one desktop-owned Harness CLI command in Node mode with a hard deadline.
 * Package-manager process trees are terminated whole on timeout so profile
 * locks do not survive a hung installation.
 */
export async function runDesktopHarnessCommand(
  invocation: DesktopHarnessCommandInvocation,
): Promise<DesktopHarnessCommandResult> {
  if (!Number.isFinite(invocation.timeoutMs) || invocation.timeoutMs <= 0) {
    throw new TypeError('desktop: harness command timeout must be positive')
  }
  return await new Promise<DesktopHarnessCommandResult>((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-DIAGNOSTIC_LIMIT) })
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-DIAGNOSTIC_LIMIT) })
    const timer = setTimeout(() => {
      timedOut = true
      // pnpm runs its scripts as a process tree; killing only the direct child
      // leaves install scripts holding the profile lock past the deadline.
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          .once('close', () => { if (!settled && child.exitCode === null) child.kill('SIGKILL') })
        return
      }
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, invocation.timeoutMs)
    timer.unref()
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new DesktopHarnessCommandError(`desktop: harness command could not start: ${String(error)}`, invocation))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result: DesktopHarnessCommandResult = { exitCode: code, stdout, stderr }
      if (timedOut || code !== 0) {
        reject(new DesktopHarnessCommandError(
          timedOut ? `desktop: harness command timed out after ${String(invocation.timeoutMs)}ms${commandDiagnostic(invocation, result)}`
            : commandDiagnostic(invocation, result),
          invocation,
          result,
        ))
        return
      }
      resolve(result)
    })
  })
}

/**
 * Bundles for a profile the bundled preset may initialize itself: the reserved
 * Desktop profile carries the web template's bundles (DESKTOP_PROFILE_BUNDLES,
 * the same source createPluginProfile initializes it from), while the generic
 * fallback would omit the web app and leave a profile the Host cannot boot as
 * the application.
 */
function presetProfileBundles(profile: string): readonly string[] {
  return PROFILE_TEMPLATES[profile]?.bundles
    ?? (profile === 'desktop' ? DESKTOP_PROFILE_BUNDLES : undefined)
    ?? DEFAULT_PROFILE_BUNDLES
}

/** Merge reviewed lifecycle-script approvals into a profile's workspace settings. */
export async function mergeProfileBuildApprovals(
  dshHome: string,
  profile: string,
  packageNames: readonly string[],
): Promise<void> {
  if (packageNames.length === 0) return
  const profileDirectory = join(dshHome, 'profiles', profile)
  // A pre-install approval can run before the plugin CLI first creates the
  // profile; initialize it the same way the CLI would (runPluginCommand's
  // own guarded init) so the approval cannot leave the profile with pnpm's
  // default (auto-installed peer) behavior. initProfile only creates missing
  // files, and the startup pass owns this profile until the CLI runs.
  initProfile(profileDirectory, presetProfileBundles(profile))
  const path = join(profileDirectory, 'pnpm-workspace.yaml')
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '{}\n'
  }
  const document = parseDocument(text)
  const [parseError] = document.errors
  if (parseError !== undefined) throw parseError
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error('desktop: pnpm-workspace.yaml must be a YAML mapping')
  }
  const builds = document.get('allowBuilds', true)
  if (builds !== undefined && !isMap(builds)) throw new Error('desktop: allowBuilds must be a YAML mapping')
  if (isMap(builds)) {
    for (const name of packageNames) builds.set(name, true)
  } else {
    document.set('allowBuilds', new Map(packageNames.map(name => [name, true])))
  }
  await writeAtomically(path, `${String(document)}\n`)
}

/** Exclusive-create plus rename, matching the seed marker writes. */
async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function harnessEnvironment(options: DesktopBundledPluginStartupOptions): NodeJS.ProcessEnv {
  const environment = desktopNodeEnvironment(options.nodeExecutable, options.nodeBin, { ...process.env })
  return {
    ...environment,
    DSH_HOME: options.dshHome,
    // The launcher reserves the desktop profile for this application; the
    // seeding pass is that owner managing the profile through the same CLI
    // humans use (see rejectElectronProfile in apps/cli/src/args.ts).
    DSH_DESKTOP_PROFILE_MANAGEMENT: '1',
    PATH: `${options.nodeBin}${delimiter}${environment.PATH ?? ''}`,
  }
}

function cliInvocation(
  options: DesktopBundledPluginStartupOptions,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
  timeoutMs: number,
): DesktopHarnessCommandInvocation {
  const entry = resolveHarnessCliEntry(options.dshDirectory)
  if (!existsSync(entry)) {
    throw new Error(`desktop: harness CLI entry not found at ${entry}; build the runtime first`)
  }
  return {
    command: options.nodeExecutable,
    args: ['--expose-internals', entry, ...args],
    env: environment,
    timeoutMs,
    cwd: options.dshHome,
  }
}

/**
 * Whether no startup entry has a seed marker in its target profile yet. The
 * application pre-creates the reserved Desktop profile before the Host boots,
 * so profile files cannot signal a fresh preset; the profile-scoped marker
 * namespace is the first-start signal.
 */
async function firstStartPending(dshHome: string, entries: readonly BundledPluginManifestEntry[]): Promise<boolean> {
  if (entries.length === 0) return false
  for (const entry of entries) {
    if (await hasBundledPluginSeedMarker(dshHome, entry)) return false
  }
  return true
}

/**
 * Seed the bundled preset plugins once per fresh data directory or application
 * version, before the workspace backend starts. Entry-level failures are
 * diagnosed without blocking the rest; the durable markers (schema 4) keep a
 * user uninstall from ever being reinstalled automatically.
 */
export async function startDesktopBundledPlugins(
  options: DesktopBundledPluginStartupOptions,
): Promise<DesktopBundledPluginStartupReport> {
  const log = options.log ?? ((message: string) => { console.info(message) })
  const runCommand = options.runCommand ?? runDesktopHarnessCommand
  // The spawned CLI adopts this directory as its working directory.
  await mkdir(options.dshHome, { recursive: true })
  const resourcesDirectory = resolveBundledPluginResourcesDirectory(
    options.packaged, options.resourcesPath, options.sourceRoot,
  )
  const manifestSource = await readFile(join(resourcesDirectory, 'manifest.json'), 'utf8')
  const manifest = parseBundledPluginManifest(JSON.parse(manifestSource))
  const entries = manifest.plugins.filter(entry => entry.installPolicy === 'startup')
  if (entries.length === 0) return { firstStart: false, attempted: false }

  const environment = harnessEnvironment(options)
  // A resolved command means success; a nonzero exit surfaces as a rejection
  // so one failed entry is diagnosed without blocking the rest.
  const invoke = async (args: readonly string[]): Promise<void> => {
    const invocation = cliInvocation(options, environment, args, BUNDLED_PLUGIN_INSTALL_TIMEOUT_MS)
    const result = await runCommand(invocation)
    if (result.exitCode !== 0) {
      throw new DesktopHarnessCommandError(commandDiagnostic(invocation, result), invocation, result)
    }
  }
  const prepare = async (entry: BundledPluginManifestEntry): Promise<void> => {
    await mergeProfileBuildApprovals(options.dshHome, entry.profile, [...entry.approvedBuilds ?? []])
  }
  const installOne = async (archivePath: string, entry: BundledPluginManifestEntry): Promise<void> => {
    await invoke(['plugin', '--profile', entry.profile, 'add', '--save-exact', archivePath])
  }

  if (await firstStartPending(options.dshHome, entries)) {
    try {
      // One package-manager invocation installs the complete first-start preset
      // set; markers land only after every installed version matches.
      await seedBundledPluginsBatch(entries, resourcesDirectory, options.dshHome, prepare,
        async (archives) => {
          const profiles = [...new Set(entries.map(entry => entry.profile))]
          if (profiles.length !== 1) throw new Error('desktop: first-start batch requires one profile')
          await invoke(['plugin', '--profile', profiles[0] ?? '', 'add', '--save-exact', ...archives])
        })
      log(`Bundled first-start preset installed ${String(entries.length)} plugin(s).`)
      // Unlike the fork's first-start commit, the version gate stays unmarked
      // here: the next start runs one observation pass that records a user's
      // uninstall as a tombstone, then marks the gate itself.
      return { firstStart: true, attempted: true }
    } catch (error) {
      // A failed first-start batch keeps the workspace usable; diagnostics go to
      // the durable harness log and the next start retries through the gate.
      await appendBundledPluginFailure(harnessLogPath(options.dshHome), error)
      log(`Bundled first-start preset failed: ${error instanceof Error ? error.message : String(error)}`)
      return { firstStart: true, attempted: true, failure: error }
    }
  }

  const gate = new BundledPresetVersionGate(options.dshHome)
  let upgradeAllowed: boolean
  try {
    upgradeAllowed = await gate.shouldAttempt(options.appVersion)
  } catch (error) {
    log(`Bundled preset version marker is unavailable; skipping automatic preparation: ${String(error)}`)
    return { firstStart: false, attempted: false, gateSkipped: 'marker-unavailable' }
  }
  if (!upgradeAllowed) {
    return { firstStart: false, attempted: false, gateSkipped: 'already-attempted' }
  }
  // Record the attempt before running: an interrupted upgrade is not retried
  // for the same application version.
  await gate.markAttempted(options.appVersion)
  const cooldown = new BundledPluginStartupCooldown(options.dshHome, options.now)
  const installer = new BundledPluginInstaller({
    manifest,
    resourcesDirectory,
    dshHome: options.dshHome,
    install: installOne,
    prepare,
    startupBudgetMs: BUNDLED_PLUGIN_STARTUP_BUDGET_MS,
    ...(options.isQuitting === undefined ? {} : { isStartupCancelled: options.isQuitting }),
    shouldAttemptStartup: entry => cooldown.shouldAttempt(entry.packageName, entry.version),
    onStartupSuccess: entry => cooldown.clear(entry.packageName),
    onFailure: async (error, entry) => {
      await appendBundledPluginFailure(harnessLogPath(options.dshHome), error)
      await cooldown.record(entry.packageName, entry.version)
      console.error(error)
    },
  })
  const results = await installer.seedStartup()
  log(`Bundled preset pass for desktop ${options.appVersion}: ${results
    .map(item => `${item.entry.packageName}=${item.result ?? 'failed-or-deferred'}`).join(', ')}.`)
  return { firstStart: false, attempted: true, results }
}
