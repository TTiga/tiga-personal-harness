; Compile against the production data-directory selection using a private scratch tree.
; The driver controls the HKCU Environment slot and the process environment around each case.
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Desktop data directory smoke"
OutFile "${DSH_OUTPUT_FILE}"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
; The builder-generated script defines this flag; the fixture never runs as an update.
!define isUpdated `0 == 1`
!include "..\..\installer\strings.nsh"
!include "..\..\installer\data-home.nsh"

; The production functions treat $0-$9 and $R0-$R9 as scratch, so the handle and scratch text need their own variables.
Var SmokeResult
Var SmokeValue

Section
  FileOpen $SmokeResult "${DSH_RESULT_FILE}" w
  !if "${DSH_CASE}" == prefill
    Call InstallerPrefillDataHome
    FileWrite $SmokeResult "prefill=$InstallerDataHome$\r$\n"
  !else
    StrCpy $InstallerDataHome "${DSH_CASE_INPUT}"
    Call InstallerValidateDataHome
    FileWrite $SmokeResult "error=$InstallerError$\r$\n"
    ${If} $InstallerError == ""
      FileWrite $SmokeResult "normalized=$InstallerDataHome$\r$\n"
    ${EndIf}
  !endif
  !if "${DSH_CASE}" == apply
    Call InstallerApplyDataHome
    ExpandEnvStrings $SmokeValue "%DSH_HOME%"
    FileWrite $SmokeResult "process=$SmokeValue$\r$\n"
  !endif
  FileClose $SmokeResult
  SetErrorLevel 0
SectionEnd
