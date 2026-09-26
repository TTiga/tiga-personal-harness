; Data-directory selection: prefill resolution, validation and the DSH_HOME publication.
; The application resolves explicit configuration first, then DSH_HOME, then ~/.dsh, so publishing
; the user variable never overrides a process that carries an explicit setting.
!include "${__FILEDIR__}\path.nsh"
Var InstallerDataHome

; The registry value outlives every process; the installer environment covers a distribution that
; has never registered DSH_HOME; $PROFILE\.dsh matches the application default.
Function InstallerPrefillDataHome
    StrCpy $InstallerDataHome ""
    ReadRegStr $0 HKCU "Environment" "DSH_HOME"
    ${If} $0 != ""
        StrCpy $InstallerDataHome $0
        Return
    ${EndIf}
    ReadEnvStr $0 "DSH_HOME"
    ${If} $0 != ""
        StrCpy $InstallerDataHome $0
    ${Else}
        StrCpy $InstallerDataHome "$PROFILE\.dsh"
    ${EndIf}
FunctionEnd

; Geometry reuses the install-location rules: a full local fixed-disk folder that is not a root,
; system folder, device name, reparse point or overlong path. The data folder may already hold
; user data, so the empty-directory ownership rule does not apply.
Function InstallerValidateDataHome
    Push $InstallerPath
    StrCpy $InstallerPath $InstallerDataHome
    Call InstallerValidatePath
    StrCpy $InstallerDataHome $InstallerPath
    Pop $InstallerPath
    ${If} $InstallerError != ""
        Return
    ${EndIf}
    ; GetFullPathName keeps trailing separators, and a root cannot reach this point.
    ${Do}
        StrCpy $0 $InstallerDataHome 1 -1
        ${If} $0 != "\"
            ${ExitDo}
        ${EndIf}
        StrCpy $InstallerDataHome $InstallerDataHome -1
    ${Loop}
    ; Creation rights are proven against the closest existing ancestor, which is where the
    ; operating system checks write access when the deeper folders do not exist yet.
    StrCpy $2 $InstallerDataHome
    Call InstallerProbeWritable
    ${If} $0 == 0
        StrCpy $InstallerError "$(INSTALLER_DATA_WRITABLE)"
        Return
    ${EndIf}
FunctionEnd

; Publication runs after a successful installation. A directory that cannot be validated or
; created leaves the environment untouched instead of failing the finished installation; the
; application then keeps whatever resolution it had before this installer ran.
Function InstallerApplyDataHome
    ${If} ${isUpdated}
        ; An update keeps the published value and whatever DSH_HOME this process was started
        ; with; republishing would overwrite a process-level override before Launch inherits it.
        Return
    ${EndIf}
    Call InstallerValidateDataHome
    ${If} $InstallerError != ""
        Return
    ${EndIf}
    ; CreateDirectory builds a single level; publish only a folder that exists afterwards.
    StrCpy $1 3
    ${Do}
        StrCpy $2 $InstallerDataHome 1 $1
        ${If} $2 == ""
            ${ExitDo}
        ${EndIf}
        ${If} $2 == "\"
            StrCpy $3 $InstallerDataHome $1
            CreateDirectory $3
        ${EndIf}
        IntOp $1 $1 + 1
    ${Loop}
    CreateDirectory $InstallerDataHome
    ${IfNot} ${FileExists} "$InstallerDataHome\*.*"
        Return
    ${EndIf}
    WriteRegStr HKCU "Environment" "DSH_HOME" $InstallerDataHome
    ; The shell reloads user variables only after the setting-change broadcast, so shortcuts
    ; launched later resolve the new location.
    SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
    ; Processes launched by this installer inherit its startup environment block, which still
    ; holds the pre-install value; rebase it so Launch now starts on the new data directory.
    System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_HOME", w "$InstallerDataHome") i.r0'
FunctionEnd
