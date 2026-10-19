; Custom NSIS uninstall step for Music Control.
;
; electron-updater keeps a download cache at %LOCALAPPDATA%\<appName>-updater. The standard
; electron-builder uninstaller does NOT remove it (deleteAppDataOnUninstall only covers the app's
; userData under %APPDATA%). Without this, a clean install -> uninstall cycle leaves that folder
; behind (caught by CI as a false success). Remove it so uninstall leaves zero Music Control data.
;
; NOTE: the folder name is the Electron app name ("@music-control-v2desktop" for the current
; scoped package name). If the desktop app is ever renamed to a clean productName, update this path.
!macro customUnInstall
  RMDir /r "$LOCALAPPDATA\@music-control-v2desktop-updater"
!macroend
