; Custom NSIS steps for Music Control.
;
; The app folders are named from the npm package name ("music-control" since 0.1.14; older builds
; used the scoped "@music-control-v2desktop"). electron-updater keeps a download cache at
; %LOCALAPPDATA%\<name>-updater that the standard uninstaller does NOT remove (deleteAppDataOnUninstall
; only covers %APPDATA% userData). We remove it on uninstall, and we also clear leftovers from the
; old wrongly-named builds on install so an upgrade lands clean (acceptance: zero stale files).

!macro customInstall
  ; Tidy up folders left by older, scope-named builds (<= 0.1.13).
  RMDir /r "$LOCALAPPDATA\@music-control-v2desktop-updater"
  RMDir /r "$LOCALAPPDATA\Programs\@music-control-v2desktop"
!macroend

!macro customUnInstall
  ; Remove the electron-updater cache (current name + any legacy name).
  RMDir /r "$LOCALAPPDATA\music-control-updater"
  RMDir /r "$LOCALAPPDATA\@music-control-v2desktop-updater"
!macroend
