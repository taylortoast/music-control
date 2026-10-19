; Custom NSIS uninstall step for Music Control.
;
; electron-updater keeps a download cache at %LOCALAPPDATA%\<name>-updater that the standard
; uninstaller does NOT remove (deleteAppDataOnUninstall only covers %APPDATA% userData). Remove it
; (current name + the legacy scope-name) so uninstall leaves zero Music Control data.
;
; IMPORTANT: do NOT add a customInstall macro that deletes any Programs install folder. customInstall
; runs AFTER the payload is extracted into $INSTDIR, and on an in-place upgrade $INSTDIR can BE the
; old-named folder — deleting it there wipes the freshly installed app (the 0.1.14 empty-install bug).
!macro customUnInstall
  RMDir /r "$LOCALAPPDATA\music-control-updater"
  RMDir /r "$LOCALAPPDATA\@music-control-v2desktop-updater"
!macroend
