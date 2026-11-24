Unicode true
ManifestDPIAware true
RequestExecutionLevel user
AllowSkipFiles off
SetOverwrite ifnewer
SetCompressor /SOLID lzma
SetDatablockOptimize on
CRCCheck force

!define APPNAME "Hearth"
!define APPVERSION "1.0.1"
!define APPPUBLISHER "Hearth Media"
!define APPSOURCE "/home/z/my-project/hearth/dist/win-unpacked"
!define APPICON "/home/z/my-project/hearth/build/icon.ico"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
!define HEARTHKEY "Software\Hearth"

Name "${APPNAME} ${APPVERSION}"
OutFile "/home/z/my-project/hearth/dist/Hearth-Setup-1.0.1-x64.exe"
InstallDir "$LOCALAPPDATA\Programs\Hearth"
InstallDirRegKey HKCU "${HEARTHKEY}" "InstallPath"

VIProductVersion "1.0.1.0"
VIAddVersionKey /LANG=1033 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APPVERSION}"
VIAddVersionKey /LANG=1033 "CompanyName" "${APPPUBLISHER}"
VIAddVersionKey /LANG=1033 "FileDescription" "${APPNAME} installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${APPVERSION}.0"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) 2026 ${APPPUBLISHER}"
VIAddVersionKey /LANG=1033 "OriginalFilename" "Hearth-Setup-1.0.1-x64.exe"

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${APPICON}"
!define MUI_UNICON "${APPICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Hearth.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Hearth"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Hearth Media Server" SEC_MAIN
  SectionIn RO
  SetShellVarContext current
  SetOutPath "$INSTDIR"

  ; Packaged app built by electron-builder in dist/win-unpacked.
  File /r "${APPSOURCE}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall Hearth.exe"

  CreateDirectory "$SMPROGRAMS\Hearth"
  CreateShortCut "$SMPROGRAMS\Hearth\Hearth.lnk" "$INSTDIR\Hearth.exe" "" "$INSTDIR\Hearth.exe" 0
  CreateShortCut "$SMPROGRAMS\Hearth\Uninstall Hearth.lnk" "$INSTDIR\Uninstall Hearth.exe" "" "$INSTDIR\Uninstall Hearth.exe" 0
  CreateShortCut "$DESKTOP\Hearth.lnk" "$INSTDIR\Hearth.exe" "" "$INSTDIR\Hearth.exe" 0

  WriteRegStr HKCU "${HEARTHKEY}" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "${HEARTHKEY}" "InstalledVersion" "${APPVERSION}"

  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME} ${APPVERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${APPVERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${APPPUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\Hearth.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" "$INSTDIR\Uninstall Hearth.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Hearth.exe" /S _?=$INSTDIR'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntOp $0 $0 / 1000
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Hearth.lnk"
  Delete "$SMPROGRAMS\Hearth\Hearth.lnk"
  Delete "$SMPROGRAMS\Hearth\Uninstall Hearth.lnk"
  RMDir "$SMPROGRAMS\Hearth"

  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${HEARTHKEY}"

  ; Stop and uninstall the optional Windows service if it was installed. Ignore failures.
  nsExec::Exec 'net stop HearthMediaServer'
  nsExec::Exec '"$INSTDIR\resources\service\HearthService.exe" uninstall'
  DeleteRegKey HKLM "SYSTEM\CurrentControlSet\Services\HearthMediaServer"

  ; Remove only Hearth's known installed files/directories. Preserve any unrelated
  ; files if the user selected a non-default installation folder, and always preserve
  ; %LOCALAPPDATA%\Hearth server data and backups.
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\Hearth.exe"
  Delete "$INSTDIR\Uninstall Hearth.exe"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\electron_wer.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vulkan-1.dll"
  RMDir "$INSTDIR"
  RMDir "$LOCALAPPDATA\Programs"
SectionEnd

Function .onInit
  ReadRegStr $INSTDIR HKCU "${HEARTHKEY}" "InstallPath"
  StrCmp $INSTDIR "" 0 +2
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Hearth"
FunctionEnd

Function un.onInit
  MessageBox MB_OKCANCEL|MB_ICONQUESTION "Remove Hearth? Your media library, users and backups in %LOCALAPPDATA%\Hearth will be preserved." IDOK +2
  Abort
FunctionEnd
