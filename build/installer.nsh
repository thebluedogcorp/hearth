; Custom NSIS hooks for the Hearth installer.
; Included by electron-builder (`nsis.include`), which generates the installer
; pages, shortcuts and version info from electron-builder.yml. This file adds
; only Hearth-specific behavior.

!macro customUnInstall
  ; Stop and uninstall the optional Windows service if it was installed. Ignore failures.
  nsExec::Exec 'net stop HearthMediaServer'
  nsExec::Exec '"$INSTDIR\resources\service\HearthService.exe" uninstall'
  DeleteRegKey HKLM "SYSTEM\CurrentControlSet\Services\HearthMediaServer"
  DeleteRegKey HKCU "Software\Hearth"
!macroEnd
