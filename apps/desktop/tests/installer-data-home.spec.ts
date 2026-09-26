/** The data-directory page publishes DSH_HOME only after the directory transaction commits. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const dataHome = read('../installer/data-home.nsh')
const lifecycle = read('../installer/lifecycle.nsh')
const pages = read('../installer/pages.nsh')
const installer = read('../scripts/installer.nsh')
const strings = read('../installer/strings.nsh')

function macro(source: string, name: string) {
  const match = source.match(new RegExp(`!macro ${name}\\s`))
  expect(match, `missing macro ${name}`).not.toBeNull()
  const start = match.index!
  return source.slice(start, source.indexOf('!macroend', start))
}

it('prefills from the published registry value, then the process environment, then the profile default', () => {
  const registry = dataHome.indexOf('ReadRegStr $0 HKCU "Environment" "DSH_HOME"')
  const environment = dataHome.indexOf('ReadEnvStr $0 "DSH_HOME"')
  const fallback = dataHome.indexOf('"$PROFILE\\.dsh"')
  expect(registry).toBeGreaterThanOrEqual(0)
  expect(environment).toBeGreaterThan(registry)
  expect(fallback).toBeGreaterThan(environment)
})

it('creates and validates the directory before publishing the user variable', () => {
  const validate = dataHome.indexOf('Call InstallerValidateDataHome')
  const create = dataHome.indexOf('CreateDirectory $InstallerDataHome')
  const publish = dataHome.indexOf('WriteRegStr HKCU "Environment" "DSH_HOME" $InstallerDataHome')
  expect(validate).toBeGreaterThanOrEqual(0)
  expect(create).toBeGreaterThan(validate)
  expect(publish).toBeGreaterThan(create)
  // An invalid or uncreatable directory leaves the environment untouched instead of failing the install.
  const skip = dataHome.indexOf('${If} $InstallerError != ""', validate)
  expect(skip).toBeGreaterThan(validate)
})

it('refreshes both the shell and the environment that Launch now inherits', () => {
  expect(dataHome).toContain('SendMessage 0xFFFF 0x1A 0 "STR:Environment"')
  expect(dataHome.indexOf('SendMessage 0xFFFF 0x1A 0 "STR:Environment"')).toBeGreaterThan(
    dataHome.indexOf('WriteRegStr HKCU "Environment" "DSH_HOME"'))
  expect(dataHome).toContain('kernel32::SetEnvironmentVariableW(w "DSH_HOME", w "$InstallerDataHome")')
})

it('shows the data page after the welcome page and skips updates', () => {
  const welcome = macro(installer, 'customWelcomePage')
  expect(welcome.indexOf('Page custom InstallerWelcome InstallerWelcomeLeave')).toBeGreaterThanOrEqual(0)
  expect(welcome.indexOf('Page custom InstallerDataDirectory InstallerDataDirectoryLeave'))
    .toBeGreaterThan(welcome.indexOf('Page custom InstallerWelcome InstallerWelcomeLeave'))
  const create = lifecycle.indexOf('Function InstallerDataDirectory')
  expect(create).toBeGreaterThanOrEqual(0)
  expect(lifecycle.slice(create, lifecycle.indexOf('FunctionEnd', create))).toContain('${isUpdated}')
})

it('applies the data home after the directory transaction commits', () => {
  const install = macro(installer, 'customInstall')
  const apply = install.indexOf('Call InstallerApplyDataHome')
  expect(apply).toBeGreaterThan(install.indexOf('!insertmacro dshFinishDirectories'))
  // The publication joins the standard uninstall-entry metadata block, which only the
  // successful installation path reaches.
  expect(apply).toBeGreaterThan(install.indexOf('WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" InstallLocation'))
})

it('skips publication entirely on updates to keep a process-level DSH_HOME override', () => {
  const apply = dataHome.indexOf('Function InstallerApplyDataHome')
  const body = dataHome.slice(apply, dataHome.indexOf('FunctionEnd', apply))
  const guard = body.indexOf('${If} ${isUpdated}')
  expect(guard).toBeGreaterThanOrEqual(0)
  expect(guard).toBeLessThan(body.indexOf('Call InstallerValidateDataHome'))
})

it('keeps the page leave and the prefill on the installer lifecycle', () => {
  expect(installer).toContain('Call InstallerPrefillDataHome')
  const leave = pages.indexOf('Function InstallerDataDirectoryLeave')
  expect(leave).toBeGreaterThanOrEqual(0)
  const body = pages.slice(leave, pages.indexOf('FunctionEnd', leave))
  expect(body).toContain('${NSD_GetText} $InstallerEdit $InstallerDataHome')
  expect(body).toContain('Call InstallerValidateDataHome')
})

it('localizes every data-page string for both installer languages', () => {
  for (const name of ['INSTALLER_CHOOSE_DATA', 'INSTALLER_DATA_LABEL', 'INSTALLER_DATA_WRITABLE']) {
    const lines = strings.split('\n').filter(line => line.startsWith(`LangString ${name} `))
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).toMatch(/^LangString \w+ \$\{LANG_(ENGLISH|SIMPCHINESE)\} ".*"$/)
  }
})
