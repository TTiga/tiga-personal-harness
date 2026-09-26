/** End-to-end trace of the real preset through first start, uninstall, and restart. */
import { existsSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { runDesktopHarnessCommand, startDesktopBundledPlugins } from '../src/bundled-plugin-startup.ts'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'lib', 'bin.js')

// The trace drives the real CLI build and the real package manager; a checkout
// without `pnpm run build` output or a reachable pnpm skips rather than fails.
const cliBuilt = existsSync(cliEntry)
const pnpmAvailable = (() => {
  try {
    // Node's non-shell spawn cannot execute Windows command shims directly.
    execFileSync('pnpm --version', { stdio: 'ignore', shell: true })
    return true
  } catch {
    return false
  }
})()
const trace = cliBuilt && pnpmAvailable ? it : it.skip

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Startup entries the shipped manifest pins: seedId, packageName, version. */
async function presetEntries(): Promise<Array<{ packageName: string; version: string; seedId: string }>> {
  const manifest = JSON.parse(await readFile(
    join(repositoryRoot, 'apps', 'desktop', 'bundled-plugins', 'manifest.json'), 'utf8',
  )) as { plugins: Array<{ seedId: string; packageName: string; version: string; installPolicy: string }> }
  return manifest.plugins.filter(entry => entry.installPolicy === 'startup')
}

/** One seeded home with the real CLI reachable through a runtime-tree layout. */
async function traceHome(): Promise<{ dshHome: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-seed-trace-'))
  roots.push(root)
  const dshHome = join(root, 'home')
  const runtime = join(root, 'runtime')
  const linkDirectory = join(runtime, 'node_modules', '@deepseek-ai')
  await mkdir(linkDirectory, { recursive: true })
  // The CLI resolves its own dependencies from its real location, so the
  // junction only shapes the runtime tree the startup wiring expects.
  symlinkSync(join(repositoryRoot, 'apps', 'cli'), join(linkDirectory, 'dsh'), 'junction')
  return { dshHome }
}

function startupOptions(dshHome: string, appVersion = '0.1.7-trace.1') {
  return {
    packaged: false,
    resourcesPath: '',
    // Development launches read the checked-in manifest and archives.
    sourceRoot: repositoryRoot,
    dshHome,
    appVersion,
    nodeExecutable: process.execPath,
    dshDirectory: join(dshHome, '..', 'runtime'),
    nodeBin: dirname(process.execPath),
  }
}

describe('bundled plugin first-start trace', () => {
  trace('installs the complete real preset on first start, then never resurrects an uninstall', async () => {
    const { dshHome } = await traceHome()
    const entries = await presetEntries()
    expect(entries).toHaveLength(8)

    // First start: the fresh home installs every real preset archive offline
    // through the plugin CLI in one batch invocation.
    const first = await startDesktopBundledPlugins(startupOptions(dshHome))
    expect(first).toMatchObject({ firstStart: true, attempted: true })
    expect(first.failure).toBeUndefined()
    for (const entry of entries) {
      const installed = JSON.parse(await readFile(
        join(dshHome, 'profiles', 'desktop', 'node_modules', ...entry.packageName.split('/'), 'package.json'), 'utf8',
      )) as { name?: string; version?: string }
      expect(installed, entry.packageName).toMatchObject({ name: entry.packageName, version: entry.version })
      expect(JSON.parse(await readFile(
        join(dshHome, 'bundled-plugins', 'profiles', 'desktop', `${entry.seedId}.seeded.json`), 'utf8',
      )))
        .toMatchObject({ schema: 4, state: 'installed', installedVersion: entry.version })
    }

    // Reviewed native build: the sidebar entry pre-approves node-pty. The
    // profile tree itself never contains node-pty — the harness core carries
    // it — so the observable approval is the merged workspace setting.
    const workspaceSettings = await readFile(join(dshHome, 'profiles', 'desktop', 'pnpm-workspace.yaml'), 'utf8')
    expect(workspaceSettings).toMatch(/(^|\n)\s*node-pty: true/u)

    // The user uninstalls one plugin through the same CLI surface the market uses.
    // The escape env mirrors what the application's own wiring sends: the CLI
    // reserves the desktop profile for the Electron application.
    const environment = { ...process.env, DSH_HOME: dshHome, DSH_DESKTOP_PROFILE_MANAGEMENT: '1' }
    await runDesktopHarnessCommand({
      command: process.execPath,
      args: ['--expose-internals', cliEntry, 'plugin', '--profile', 'desktop', 'remove', 'dsh-mermaid'],
      env: environment,
      timeoutMs: 5 * 60_000,
      cwd: dshHome,
    })
    expect(existsSync(join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-mermaid'))).toBe(false)

    // Second start: the pass observes the uninstall and records the tombstone
    // while every retained preset entry stays verified. The sidebar's
    // 'verified' also exercises the settled check's approvedBuilds branch,
    // which reads the node-pty approval merged above.
    const second = await startDesktopBundledPlugins(startupOptions(dshHome))
    expect(second.attempted).toBe(true)
    expect(second.results?.find(item => item.entry.seedId === 'dsh-mermaid')?.result).toBe('removed')
    for (const entry of entries.filter(candidate => candidate.seedId !== 'dsh-mermaid')) {
      expect(second.results?.find(item => item.entry.seedId === entry.seedId)?.result, entry.packageName)
        .toBe('verified')
    }
    expect(existsSync(join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-mermaid'))).toBe(false)
    expect(JSON.parse(await readFile(
      join(dshHome, 'bundled-plugins', 'profiles', 'desktop', 'dsh-mermaid.seeded.json'), 'utf8',
    )))
      .toMatchObject({ state: 'removed' })

    // Third start (a later application version reopens the gate): the
    // tombstone is settled, so nothing installs again.
    const third = await startDesktopBundledPlugins(startupOptions(dshHome, '0.1.7-trace.2'))
    expect(third.attempted).toBe(true)
    expect(third.results?.find(item => item.entry.seedId === 'dsh-mermaid')?.result).toBe('verified')
    expect(existsSync(join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-mermaid'))).toBe(false)
  }, 30 * 60_000)
})
