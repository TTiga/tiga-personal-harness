import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mergeProfileBuildApprovals,
  resolveHarnessCliEntry,
  startDesktopBundledPlugins,
  type DesktopBundledPluginStartupOptions,
  type DesktopHarnessCommandInvocation,
  type DesktopHarnessCommandResult,
} from '../src/bundled-plugin-startup.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  readonly root: string
  readonly dshHome: string
  readonly resources: string
  readonly options: (overrides?: Partial<DesktopBundledPluginStartupOptions>) => DesktopBundledPluginStartupOptions
  readonly runCommand: (invocation: DesktopHarnessCommandInvocation) => Promise<DesktopHarnessCommandResult>
  readonly installInvocations: () => DesktopHarnessCommandInvocation[]
}

interface FixtureEntry extends Record<string, unknown> {
  readonly seedId: string
  readonly packageName: string
  readonly version: string
  readonly profile: string
  readonly archive: string
}

// The reserved Desktop profile is the one the packaged Host boots (paths.ts),
// so the bundled preset targets it; 'web' is only meaningful to `dsh web`.
const PRESET_PROFILE = 'desktop'

/** One entry from a completed prior seed; gate-path tests settle it first. */
const priorSettledEntry = {
  seedId: 'settled', packageName: 'settled', version: '1.0.0', profile: PRESET_PROFILE,
  installPolicy: 'startup', registrySpec: 'settled@1.0.0', archive: 'settled-1.0.0.tgz',
}

async function fixture(plugins: readonly FixtureEntry[] = [
  {
    seedId: 'dsh-mermaid', packageName: 'dsh-mermaid', version: '0.4.1', profile: PRESET_PROFILE,
    installPolicy: 'startup', registrySpec: 'dsh-mermaid@0.4.1',
    archive: 'dsh-mermaid-0.4.1.tgz',
  },
]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bundled-startup-'))
  roots.push(root)
  const dshHome = join(root, 'home')
  const resources = join(root, 'bundled-plugins')
  const dshDirectory = join(root, 'runtime')
  await mkdir(resources, { recursive: true })
  await mkdir(join(dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  await writeFile(join(dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')
  const entries: FixtureEntry[] = []
  for (const plugin of plugins) {
    const bytes = Buffer.from(`archive ${plugin.seedId}`)
    await writeFile(join(resources, plugin.archive), bytes)
    entries.push({
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      ...plugin,
    })
  }
  await writeFile(join(resources, 'manifest.json'), `${JSON.stringify({ schema: 2, plugins: entries }, null, 2)}\n`)
  const runCommand = vi.fn(async (invocation: DesktopHarnessCommandInvocation) => {
    // Materialize the requested packages like the real CLI would.
    const saveExact = invocation.args.indexOf('--save-exact')
    const specs = saveExact >= 0 ? invocation.args.slice(saveExact + 1) : []
    const profile = invocation.args[invocation.args.indexOf('--profile') + 1] ?? ''
    for (const spec of specs) {
      const archive = spec.split(/[\\/]/).pop() ?? ''
      const entry = entries.find(candidate => candidate.archive === archive)
      if (entry === undefined) continue
      const profileDirectory = join(dshHome, 'profiles', profile)
      const installed = join(profileDirectory, 'node_modules', entry.packageName)
      await mkdir(installed, { recursive: true })
      await writeFile(join(installed, 'package.json'), JSON.stringify({
        name: entry.packageName, version: entry.version,
      }))
      let current: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } } = {}
      try {
        current = JSON.parse(await readFile(join(profileDirectory, 'package.json'), 'utf8')) as typeof current
      } catch { /* first package in this profile */ }
      await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
        dependencies: { ...current.dependencies, [entry.packageName]: `file:${spec}` },
        dsh: { profile: { bundles: [...new Set([...current.dsh?.profile?.bundles ?? [], entry.packageName])] } },
      }))
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  })
  const options = (overrides: Partial<DesktopBundledPluginStartupOptions> = {}): DesktopBundledPluginStartupOptions => ({
    packaged: true,
    resourcesPath: root,
    sourceRoot: root,
    dshHome,
    appVersion: '0.1.7-test.1',
    nodeExecutable: process.execPath,
    dshDirectory,
    nodeBin: join(root, 'bin'),
    runCommand,
    log: () => {},
    ...overrides,
  })
  return {
    root, dshHome, resources, options, runCommand,
    installInvocations: () => runCommand.mock.calls
      .map(([invocation]) => invocation)
      .filter(invocation => invocation.args.includes('add')),
  }
}

/** Seed markers are namespaced per target profile under bundled-plugins/profiles/. */
async function readMarker(dshHome: string, profile: string, seedId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    join(dshHome, 'bundled-plugins', 'profiles', profile, `${seedId}.seeded.json`), 'utf8',
  )) as Record<string, unknown>
}

/** Materialize one settled entry like a completed prior seed, without running the CLI. */
async function settleEntry(f: Awaited<ReturnType<typeof fixture>>, entry: FixtureEntry): Promise<void> {
  await mkdir(join(f.dshHome, 'bundled-plugins'), { recursive: true })
  await copyFile(join(f.resources, entry.archive), join(f.dshHome, 'bundled-plugins', entry.archive))
  const profileDirectory = join(f.dshHome, 'profiles', entry.profile)
  const installed = join(profileDirectory, 'node_modules', entry.packageName)
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: entry.packageName, version: entry.version }))
  await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
    dependencies: { [entry.packageName]: `file:${join(f.dshHome, 'bundled-plugins', entry.archive)}` },
    dsh: { profile: { bundles: [entry.packageName] } },
  }))
  await mkdir(join(f.dshHome, 'bundled-plugins', 'profiles', entry.profile), { recursive: true })
  await writeFile(
    join(f.dshHome, 'bundled-plugins', 'profiles', entry.profile, `${entry.seedId}.seeded.json`),
    `${JSON.stringify({
      schema: 4, seedId: entry.seedId, packageName: entry.packageName, dependencyName: entry.packageName,
      handledBundledVersion: entry.version, installedVersion: entry.version, state: 'installed',
      ownership: 'desktop-archive', sourceIdentity: `desktop-archive:${entry.archive}`,
    })}\n`,
  )
}

describe('desktop bundled plugin startup', () => {
  it('resolves the CLI entry inside a Harness runtime tree', () => {
    expect(resolveHarnessCliEntry(join('x', 'dsh'))).toBe(
      join('x', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    )
  })

  it('installs the whole first-start preset in one CLI invocation', async () => {
    const f = await fixture()
    const report = await startDesktopBundledPlugins(f.options())
    expect(report).toMatchObject({ firstStart: true, attempted: true })
    const invocations = f.installInvocations()
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.args).toEqual(expect.arrayContaining(['plugin', '--profile', PRESET_PROFILE, 'add', '--save-exact']))
    // One batch invocation carries every archive together.
    expect(invocations[0]?.args.filter(argument => argument.endsWith('.tgz'))).toHaveLength(1)
    expect(invocations[0]?.env.DSH_HOME).toBe(f.dshHome)
    expect(invocations[0]?.env.ELECTRON_RUN_AS_NODE).toBe('1')
    // The CLI reserves the desktop profile for this application; the seeding
    // pass identifies itself as that owner (see rejectElectronProfile).
    expect(invocations[0]?.env.DSH_DESKTOP_PROFILE_MANAGEMENT).toBe('1')
    expect(await readMarker(f.dshHome, PRESET_PROFILE, 'dsh-mermaid')).toMatchObject({
      schema: 4, state: 'installed', ownership: 'desktop-archive', installedVersion: '0.4.1',
    })
    // The archive was copied into the home state directory before installation.
    expect(await readdir(join(f.dshHome, 'bundled-plugins'))).toContain('dsh-mermaid-0.4.1.tgz')
  })

  it('treats a pre-created Host profile as a first start', async () => {
    // The application creates profiles/desktop (web-template bundles) before the
    // Host boots, so "profile package.json exists" can no longer detect a fresh
    // preset; the marker namespace is the first-start signal.
    const f = await fixture()
    const profile = join(f.dshHome, 'profiles', PRESET_PROFILE)
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }))
    const report = await startDesktopBundledPlugins(f.options())
    expect(report).toMatchObject({ firstStart: true, attempted: true })
    expect(f.installInvocations()[0]?.args).toEqual(expect.arrayContaining(['--profile', PRESET_PROFILE]))
    expect(await readMarker(f.dshHome, PRESET_PROFILE, 'dsh-mermaid')).toMatchObject({ state: 'installed' })
  })

  it('reseeds into the Host profile regardless of legacy web-profile markers', async () => {
    // Data directories seeded by the pre-retarget build carry top-level markers
    // (state=installed) plus a populated web profile. The desktop pass must not
    // read those markers as its own: it seeds the desktop profile fresh and
    // leaves the legacy records untouched instead of writing tombstones.
    const f = await fixture()
    const webProfile = join(f.dshHome, 'profiles', 'web')
    await mkdir(join(f.dshHome, 'bundled-plugins'), { recursive: true })
    await copyFile(join(f.resources, 'dsh-mermaid-0.4.1.tgz'), join(f.dshHome, 'bundled-plugins', 'dsh-mermaid-0.4.1.tgz'))
    await mkdir(webProfile, { recursive: true })
    await writeFile(join(webProfile, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-mermaid': `file:${join(f.dshHome, 'bundled-plugins', 'dsh-mermaid-0.4.1.tgz')}` },
      dsh: { profile: { bundles: ['dsh-mermaid'] } },
    }))
    const legacyMarker = join(f.dshHome, 'bundled-plugins', 'dsh-mermaid.seeded.json')
    await writeFile(legacyMarker, JSON.stringify({
      schema: 4, seedId: 'dsh-mermaid', packageName: 'dsh-mermaid',
      handledBundledVersion: '0.4.1', installedVersion: '0.4.1', state: 'installed', ownership: 'desktop-archive',
    }))
    const desktopProfile = join(f.dshHome, 'profiles', PRESET_PROFILE)
    await mkdir(desktopProfile, { recursive: true })
    await writeFile(join(desktopProfile, 'package.json'), '{}')
    const report = await startDesktopBundledPlugins(f.options())
    expect(report).toMatchObject({ firstStart: true, attempted: true })
    expect(f.installInvocations()[0]?.args).toEqual(expect.arrayContaining(['--profile', PRESET_PROFILE]))
    expect(await readMarker(f.dshHome, PRESET_PROFILE, 'dsh-mermaid')).toMatchObject({ state: 'installed' })
    expect(await readFile(legacyMarker, 'utf8')).toContain('"state":"installed"')
  })

  it('diagnoses a failed first-start batch without throwing', async () => {
    const f = await fixture()
    const failing = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'pnpm exploded' }))
    const report = await startDesktopBundledPlugins(f.options({ runCommand: failing }))
    expect(report.firstStart).toBe(true)
    expect(report.failure).toBeInstanceOf(Error)
    const log = await readFile(join(f.dshHome, 'logs', 'harness.log'), 'utf8')
    expect(log).toMatch(/\[bundled-plugin\] \[error\]/u)
    expect(log).toContain('pnpm exploded')
    // The failed batch left no marker behind, so the next start still counts
    // as a first start and retries the batch instead of the gate path.
    const retried = await startDesktopBundledPlugins(f.options())
    expect(retried).toMatchObject({ firstStart: true, attempted: true })
    expect(retried.failure).toBeUndefined()
    expect(await readMarker(f.dshHome, PRESET_PROFILE, 'dsh-mermaid')).toMatchObject({ state: 'installed' })
  })

  it('attempts a per-entry pass once per application version', async () => {
    const settled = priorSettledEntry
    const f = await fixture([
      settled,
      {
        seedId: 'added-later', packageName: 'added-later', version: '2.0.0', profile: PRESET_PROFILE,
        installPolicy: 'startup', registrySpec: 'added-later@2.0.0', archive: 'added-later-2.0.0.tgz',
      },
    ])
    // One settled entry defeats first-start; the entry a later version added
    // reaches the gate pass and installs per-entry.
    await settleEntry(f, settled)
    const report = await startDesktopBundledPlugins(f.options())
    expect(report).toMatchObject({ firstStart: false, attempted: true })
    expect(report.results?.find(item => item.entry.seedId === 'settled')?.result).toBe('verified')
    expect(report.results?.find(item => item.entry.seedId === 'added-later')?.result).toBe('installed')
    expect(await readFile(join(f.dshHome, 'bundled-plugins', 'desktop-preset-attempt.v2.json'), 'utf8'))
      .toContain('"attemptedVersion":"0.1.7-test.1"')
    // The same version never retries; settled entries stay verified.
    const again = await startDesktopBundledPlugins(f.options())
    expect(again).toMatchObject({ attempted: false, gateSkipped: 'already-attempted' })
  })

  it('skips the pass when the version marker is damaged', async () => {
    const settled = priorSettledEntry
    const f = await fixture([settled])
    // One marker keeps this off the first-start path so the damaged gate is reached.
    await settleEntry(f, settled)
    await writeFile(join(f.dshHome, 'bundled-plugins', 'desktop-preset-attempt.v2.json'), '{ damaged')
    const report = await startDesktopBundledPlugins(f.options())
    expect(report).toMatchObject({ attempted: false, gateSkipped: 'marker-unavailable' })
    expect(f.runCommand).not.toHaveBeenCalled()
  })

  it('never reinstalls an entry whose uninstall left a tombstone', async () => {
    const f = await fixture()
    // A prior release installed it, then the user uninstalled it.
    const profile = join(f.dshHome, 'profiles', PRESET_PROFILE)
    await mkdir(join(f.dshHome, 'bundled-plugins', 'profiles', PRESET_PROFILE), { recursive: true })
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), '{}')
    await writeFile(
      join(f.dshHome, 'bundled-plugins', 'profiles', PRESET_PROFILE, 'dsh-mermaid.seeded.json'),
      JSON.stringify({
        schema: 4, seedId: 'dsh-mermaid', packageName: 'dsh-mermaid',
        handledBundledVersion: '0.4.1', state: 'removed', ownership: 'desktop-archive',
      }),
    )
    const report = await startDesktopBundledPlugins(f.options())
    expect(report.attempted).toBe(true)
    // A settled tombstone takes the startup fast path; no install runs and
    // the durable marker keeps recording the user's uninstall.
    expect(report.results?.[0]?.result).toBe('verified')
    expect(f.installInvocations()).toHaveLength(0)
    expect(await readFile(
      join(f.dshHome, 'bundled-plugins', 'profiles', PRESET_PROFILE, 'dsh-mermaid.seeded.json'), 'utf8',
    )).toContain('"state":"removed"')
  })

  it('records a failure for cooldown and continues with the remaining entries', async () => {
    const settled = priorSettledEntry
    const f = await fixture([
      settled,
      {
        seedId: 'first', packageName: 'first', version: '1.0.0', profile: PRESET_PROFILE,
        installPolicy: 'startup', registrySpec: 'first@1.0.0', archive: 'first-1.0.0.tgz',
      },
      {
        seedId: 'second', packageName: 'second', version: '2.0.0', profile: PRESET_PROFILE,
        installPolicy: 'startup', registrySpec: 'second@2.0.0', archive: 'second-2.0.0.tgz',
      },
    ])
    await settleEntry(f, settled)
    const delegate = f.runCommand
    const mixed = vi.fn(async (invocation: DesktopHarnessCommandInvocation) => {
      if (invocation.args.some(argument => argument.includes('first-1.0.0.tgz'))) {
        return { exitCode: 1, stdout: '', stderr: 'first plugin is broken' }
      }
      return delegate(invocation)
    })
    const report = await startDesktopBundledPlugins(f.options({ runCommand: mixed }))
    expect(report.results?.find(item => item.entry.seedId === 'settled')?.result).toBe('verified')
    expect(report.results?.find(item => item.entry.seedId === 'first')?.result).toBeUndefined()
    expect(report.results?.find(item => item.entry.seedId === 'second')?.result).toBe('installed')
    const failures = JSON.parse(await readFile(
      join(f.dshHome, 'bundled-plugins', 'startup-failures.v1.json'), 'utf8',
    )) as { failures: Array<{ packageName: string }> }
    expect(failures.failures.map(failure => failure.packageName)).toContain('first')
    expect(mixed).toHaveBeenCalledTimes(2)
  })

  it('merges reviewed build approvals into the profile workspace settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bundled-approvals-'))
    roots.push(root)
    const home = join(root, 'home')
    const profile = join(home, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    await mergeProfileBuildApprovals(home, 'web', ['node-pty'])
    const text = await readFile(join(profile, 'pnpm-workspace.yaml'), 'utf8')
    expect(text).toContain('packages:')
    expect(text).toContain('allowBuilds:')
    expect(text).toContain('node-pty: true')
  })

  it('creates missing workspace settings for approvals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bundled-approvals-'))
    roots.push(root)
    const home = join(root, 'home')
    await mergeProfileBuildApprovals(home, PRESET_PROFILE, ['node-pty'])
    const settings = await readFile(join(home, 'profiles', PRESET_PROFILE, 'pnpm-workspace.yaml'), 'utf8')
    // A file created before the plugin CLI initializes the profile must carry
    // the same workspace template, not pnpm-default settings.
    expect(settings).toContain('node-pty: true')
    expect(settings).toContain('autoInstallPeers: false')
    expect(settings).toContain('nodeLinker: hoisted')
    // The reserved Desktop profile carries the web template's bundles: seeding
    // can run before applyRelease creates the profile, and the generic fallback
    // (base bundle only) would leave a profile the Host cannot boot as the app.
    expect(JSON.parse(await readFile(join(home, 'profiles', PRESET_PROFILE, 'package.json'), 'utf8')))
      .toMatchObject({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })
  })
})
