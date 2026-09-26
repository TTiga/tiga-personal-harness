/** The packaged runtime bin directory carries a PATH-resolvable pnpm launcher. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { writeRuntimePnpmLaunchers } from '../scripts/runtime-shims.ts'

const directory = mkdtempSync(join(tmpdir(), 'dsh-runtime-shims-'))
afterAll(() => { rmSync(directory, { recursive: true, force: true }) })

it('writes launchers that resolve the pinned pnpm package beside the bin directory', () => {
  // The pinned package prepare-runtime copies to <runtime>/pnpm must keep shipping
  // bin/pnpm.mjs, or every installed launcher stops resolving.
  const pnpmPackage = join(createRequire(import.meta.url).resolve('pnpm'), '..')
  expect(existsSync(join(pnpmPackage, 'bin', 'pnpm.mjs'))).toBe(true)

  writeRuntimePnpmLaunchers(directory)
  const windows = readFileSync(join(directory, 'pnpm.cmd'), 'utf8')
  expect(windows).toContain('"%~dp0..\\pnpm\\bin\\pnpm.mjs"')
  expect(windows).toContain('"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals')
  expect(windows).toContain('\r\n')
  expect(readFileSync(join(directory, 'pnpm'), 'utf8')).toContain('"$(dirname "$0")/../pnpm/bin/pnpm.mjs"')
})

it('marks the POSIX launcher executable past the process umask', () => {
  writeRuntimePnpmLaunchers(directory)
  // Windows maps chmod to the read-only bit only, so the forced bits are observable
  // on the POSIX lanes that build the darwin runtime.
  const mode = statSync(join(directory, 'pnpm')).mode & 0o777
  expect(mode).toBe(process.platform === 'win32' ? 0o666 : 0o755)
})
