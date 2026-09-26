/** The packaged runtime bin directory carries a PATH-resolvable pnpm launcher. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { writeRuntimePackageManagerShims } from '../scripts/runtime-shims.ts'

const directory = mkdtempSync(join(tmpdir(), 'dsh-runtime-shims-'))
afterAll(() => { rmSync(directory, { recursive: true, force: true }) })

it('writes a Windows launcher that reaches the pinned pnpm beside the bin directory', () => {
  writeRuntimePackageManagerShims(directory)
  // CRLF matches node.cmd; %~dp0 keeps the launcher valid wherever the runtime installs.
  expect(readFileSync(join(directory, 'pnpm.cmd'), 'utf8')).toBe(
    '@echo off\r\n'
    + 'set ELECTRON_RUN_AS_NODE=1\r\n'
    + '"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals "%~dp0..\\pnpm\\bin\\pnpm.mjs" %*\r\n',
  )
})

it('writes a POSIX launcher with the executable bit forced past the process umask', () => {
  // Windows maps chmod to the read-only bit only, so the forced bits are observable
  // on the POSIX lanes that build the darwin runtime.
  const mode = statSync(join(directory, 'pnpm')).mode & 0o777
  expect(mode).toBe(process.platform === 'win32' ? 0o666 : 0o755)
  expect(readFileSync(join(directory, 'pnpm'), 'utf8')).toContain('--expose-internals "$(dirname "$0")/../pnpm/bin/pnpm.mjs"')
})
