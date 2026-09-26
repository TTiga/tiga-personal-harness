# Exercise the production NSIS data-directory selection with a private scratch tree and registry slot.
param(
  [Parameter(Mandatory)][string]$Makensis
)
$ErrorActionPreference = 'Stop'
$Makensis = [System.IO.Path]::GetFullPath($Makensis)
# Windows PowerShell 5.1 has no Directory.CreateTempSubdirectory; keep the script runnable there.
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-data-home-smoke-' + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($scratch) | Out-Null
$fixture = Join-Path $PSScriptRoot '../tests/fixtures/installer-data-home-smoke.nsi'
$environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
# The fixture loads English first and SimpChinese second, so $(...) copy resolves in Chinese.
$localized = @{}
Get-Content (Join-Path $PSScriptRoot '../installer/strings.nsh') -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^LangString (INSTALLER_\w+) \$\{LANG_SIMPCHINESE\} "(.*)"$') { $localized[$Matches[1]] = $Matches[2] }
}
Add-Type -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);' -Name EnvironmentBroadcast -Namespace DshSmoke
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$Executable exited with $LASTEXITCODE" }
}
function Invoke-DataCase([string]$Case, [string]$CaseInput = '') {
  $exe = Join-Path $scratch "$Case.exe"
  $result = Join-Path $scratch "$Case.txt"
  $compileArgs = @('/V2', "/DDSH_OUTPUT_FILE=$exe", "/DDSH_RESULT_FILE=$result", "/DDSH_CASE=$Case")
  if ($CaseInput) { $compileArgs += "/DDSH_CASE_INPUT=$CaseInput" }
  Invoke-Checked $Makensis ($compileArgs + $fixture)
  $process = Start-Process -FilePath $exe -ArgumentList '/S' -WindowStyle Hidden -PassThru
  try {
    if (-not $process.WaitForExit(60000)) { throw "Data home smoke $Case did not exit within 60 seconds" }
    if ($process.ExitCode -ne 0) { throw "Data home smoke $Case exited with $($process.ExitCode)" }
  } finally { $process.Dispose() }
  (Get-Content -LiteralPath $result -Raw).Replace("`r`n", "`n").TrimEnd()
}
function Get-DataHomeValue {
  $environmentKey.GetValue('DSH_HOME', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}
function Assert-DataCase([string]$Case, [string[]]$ExpectedLines, [string]$CaseInput = '') {
  $actual = (Invoke-DataCase $Case $CaseInput) -split '\n'
  if (Compare-Object $ExpectedLines $actual) { throw "Data home smoke $Case returned [$($actual -join ' | ')], expected [$($ExpectedLines -join ' | ')]" }
  Write-Output "Data directory smoke passed: $Case"
}

$original = Get-DataHomeValue
$originalKind = if ($null -ne $original) { $environmentKey.GetValueKind('DSH_HOME') } else { $null }
$savedProcessValue = $env:DSH_HOME
$denyUser = $env:USERNAME
$readonly = Join-Path $scratch 'readonly'
try {
  $registryPrefill = Join-Path $scratch 'from-registry'
  $environmentKey.SetValue('DSH_HOME', $registryPrefill, [Microsoft.Win32.RegistryValueKind]::String)

  Assert-DataCase prefill @("prefill=$registryPrefill")

  $environmentKey.DeleteValue('DSH_HOME')
  $env:DSH_HOME = $null
  Assert-DataCase prefill @("prefill=$([IO.Path]::Combine($env:USERPROFILE, '.dsh'))")

  Assert-DataCase reject-root @("error=$($localized.INSTALLER_PATH_INVALID)") 'C:\'
  # A doubled trailing separator normalizes back to the drive root and must stay rejected.
  Assert-DataCase reject-root @("error=$($localized.INSTALLER_PATH_INVALID)") 'C:\\'
  Assert-DataCase reject-length @("error=$($localized.INSTALLER_PATH_INVALID)") ('C:\data\' + ('d' * 190))
  Assert-DataCase reject-characters @("error=$($localized.INSTALLER_PATH_INVALID)") 'C:\data<home'

  $junctionTarget = Join-Path $scratch 'junction-target'
  [IO.Directory]::CreateDirectory($junctionTarget) | Out-Null
  $junction = Join-Path $scratch 'junction'
  New-Item -ItemType Junction -Path $junction -Target $junctionTarget | Out-Null
  Assert-DataCase reject-reparse @("error=$($localized.INSTALLER_PATH_INVALID)") $junction

  [IO.Directory]::CreateDirectory($readonly) | Out-Null
  Invoke-Checked icacls @($readonly, '/deny', "${denyUser}:(W)")
  try {
    Assert-DataCase reject-readonly @("error=$($localized.INSTALLER_DATA_WRITABLE)") $readonly
  } finally {
    Invoke-Checked icacls @($readonly, '/remove:d', $denyUser)
  }

  $applyHome = Join-Path $scratch 'apply\deep\new'
  Assert-DataCase apply @('error=', "normalized=$applyHome", "process=$applyHome") "$applyHome\"
  if (-not (Test-Path -LiteralPath $applyHome -PathType Container)) { throw 'Data home smoke apply did not create the directory' }
  if ((Get-DataHomeValue) -ne $applyHome) { throw 'Data home smoke apply did not publish DSH_HOME' }

  Assert-DataCase apply-invalid @("error=$($localized.INSTALLER_PATH_INVALID)") 'C:\'
  if ((Get-DataHomeValue) -ne $applyHome) { throw 'Data home smoke apply-invalid changed the published DSH_HOME' }
} finally {
  if (Test-Path -LiteralPath $readonly) { & icacls $readonly '/remove:d' $denyUser | Out-Null }
  if ($null -eq $original) {
    $environmentKey.DeleteValue('DSH_HOME', $false)
  } else {
    $environmentKey.SetValue('DSH_HOME', $original, $originalKind)
  }
  if ($null -eq $savedProcessValue) { $env:DSH_HOME = $null } else { $env:DSH_HOME = $savedProcessValue }
  [void][DshSmoke.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]([UIntPtr]::Zero))
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $resolvedScratch = [System.IO.Path]::GetFullPath($scratch)
  if (-not $resolvedScratch.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing cleanup outside the temporary root: $resolvedScratch"
  }
  Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
}
