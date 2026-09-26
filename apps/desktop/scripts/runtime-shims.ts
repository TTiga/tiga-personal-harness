/** Package-manager launchers for the packaged runtime's private bin directory. */
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// CRLF matches node.cmd; %~dp0 keeps the shim valid wherever the runtime is installed.
const WINDOWS_SHIM = '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals "%~dp0..\\pnpm\\bin\\pnpm.mjs" %*\r\n'
const POSIX_SHIM = '#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "$DSH_DESKTOP_NODE_EXECUTABLE" --expose-internals "$(dirname "$0")/../pnpm/bin/pnpm.mjs" "$@"\n'

/**
 * Write the pinned pnpm launchers the bundled-plugin CLI path resolves through PATH.
 * The launcher directory heads that PATH, so a machine without a global pnpm still
 * seeds the first-start preset; the host's own installs inject pnpm explicitly and
 * never read these files.
 * @param binDirectory Packaged runtime bin directory that already holds the node launchers.
 */
export function writeRuntimePnpmLaunchers(binDirectory: string): void {
  writeFileSync(join(binDirectory, 'pnpm.cmd'), WINDOWS_SHIM)
  writeFileSync(join(binDirectory, 'pnpm'), POSIX_SHIM)
  chmodSync(join(binDirectory, 'pnpm'), 0o755)
}
