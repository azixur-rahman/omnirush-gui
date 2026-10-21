; The app writes its own Start menu shortcut and records the path in
; windows-brand-shortcut.txt. An update runs the old uninstaller with
; --updated and then keeps shortcuts as they are, so removing that shortcut
; during an update left the app without a Start menu entry until it was
; opened from somewhere else.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $1 ""
    FileOpen $0 "$APPDATA\ai.omnirush.desktop\windows-brand-shortcut.txt" r
    IfErrors +3
      FileRead $0 $1
      FileClose $0
    ${If} $1 != ""
      Delete "$1"
    ${EndIf}
    Delete "$APPDATA\ai.omnirush.desktop\windows-brand-shortcut.txt"
  ${endIf}
!macroend

; Updates from versions whose uninstaller removed the Start menu shortcut:
; put it back unless the app's own shortcut is still in place.
!macro customInstall
  Push $0
  Push $1
  StrCpy $1 ""
  ClearErrors
  FileOpen $0 "$APPDATA\ai.omnirush.desktop\windows-brand-shortcut.txt" r
  ${ifNot} ${Errors}
    FileRead $0 $1
    FileClose $0
  ${endIf}
  ClearErrors
  ${if} $1 == ""
  ${orIfNot} ${FileExists} "$1"
    ${ifNot} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${endIf}
  ${endIf}
  Pop $1
  Pop $0
!macroend
