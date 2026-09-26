/** End-to-end trace of one real archive through first start, uninstall, and restart. */
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
  trace('installs the real archive on first start, then never resurrects an uninstall', async () => {
    const { dshHome } = await traceHome()

    // First start: the fresh home installs the real dsh-mermaid archive
    // offline through the plugin CLI.
    const first = await startDesktopBundledPlugins(startupOptions(dshHome))
    expect(first).toMatchObject({ firstStart: true, attempted: true })
    expect(first.failure).toBeUndefined()
    const installed = JSON.parse(await readFile(
      join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-mermaid', 'package.json'), 'utf8',
    )) as { name?: string; version?: string }
    expect(installed).toMatchObject({ name: 'dsh-mermaid', version: '0.4.1' })
    expect(JSON.parse(await readFile(join(dshHome, 'bundled-plugins', 'dsh-mermaid.seeded.json'), 'utf8')))
      .toMatchObject({ schema: 4, state: 'installed', installedVersion: '0.4.1' })

    // The user uninstalls it through the same CLI surface the market uses.
    const environment = { ...process.env, DSH_HOME: dshHome }
    await runDesktopHarnessCommand({
      command: process.execPath,
      args: ['--expose-internals', cliEntry, 'plugin', '--profile', 'web', 'remove', 'dsh-mermaid'],
      env: environment,
      timeoutMs: 5 * 60_000,
      cwd: dshHome,
    })
    expect(existsSync(join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-mermaid'))).toBe(false)

    // Second start: the pass observes the uninstall and records the tombstone.
    const second = await startDesktopBundledPlugins(startupOptions(dshHome))
    expect(second.attempted).toBe(true)
    expect(second.results?.find(item => item.entry.seedId === 'dsh-mermaid')?.result).toBe('removed')
    expect(existsSync(join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-mermaid'))).toBe(false)
    expect(JSON.parse(await readFile(join(dshHome, 'bundled-plugins', 'dsh-mermaid.seeded.json'), 'utf8')))
      .toMatchObject({ state: 'removed' })

    // Third start (a later application version reopens the gate): the
    // tombstone is settled, so nothing installs again.
    const third = await startDesktopBundledPlugins(startupOptions(dshHome, '0.1.7-trace.2'))
    expect(third.attempted).toBe(true)
    expect(third.results?.find(item => item.entry.seedId === 'dsh-mermaid')?.result).toBe('verified')
    expect(existsSync(join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-mermaid'))).toBe(false)
  }, 15 * 60_000)
})
