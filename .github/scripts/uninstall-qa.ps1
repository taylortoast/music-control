<#
  Music Control desktop uninstaller QA.

  Runs the exact lifecycle a user does on a per-user Windows install:
    install silently  ->  confirm it really installed  ->  uninstall via the registry's
    QuietUninstallString  ->  confirm EVERYTHING is gone and the exit code is honest.

  The install location and uninstall command are read FROM THE REGISTRY (not guessed), because
  electron-builder's install folder name is derived from the app name, not always the productName.

  Exits non-zero (fails the CI job) if any acceptance item fails. This is the release gate that
  previous Linux-built uninstallers (0.1.6 hung, 0.1.8 exit-0-removed-nothing, 0.1.9 exit-2) trip.
#>

$ErrorActionPreference = 'Stop'

$installer = Get-ChildItem 'apps\desktop\release\Music Control Setup *.exe' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { Write-Host '::error::No installer .exe found in apps/desktop/release'; exit 1 }
Write-Host "Installer under test: $($installer.FullName)"

$key     = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\94c70cc2-4cd1-5799-8571-e04348f0e736'
$appData = Join-Path $env:APPDATA '@music-control-v2'
$updater = Join-Path $env:LOCALAPPDATA '@music-control-v2desktop-updater'
$smLnk   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Music Control.lnk'
$dtLnk   = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Music Control.lnk'

$failures = New-Object System.Collections.Generic.List[string]

# ---------------------------------------------------------------- INSTALL
Write-Host '== Silent install (/S) =='
$ip = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
Write-Host "installer exit code: $($ip.ExitCode)"

# A oneClick installer auto-launches the app; stop it so a running exe cannot block uninstall.
Start-Sleep -Seconds 8
Get-Process -Name 'Music Control' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

if (-not (Test-Path $key)) {
  Write-Host '::error::install did not create the uninstall registry key - cannot continue'
  exit 1
}

# Read the REAL install location + uninstall commands straight from the registry.
$props = Get-ItemProperty -Path $key
$dir   = $props.InstallLocation
$quiet = $props.QuietUninstallString
if (-not $quiet) { $quiet = $props.UninstallString }
Write-Host "registry DisplayName         : $($props.DisplayName)"
Write-Host "registry InstallLocation     : $dir"
Write-Host "registry QuietUninstallString: $quiet"

if (-not $dir)   { $failures.Add('registry has no InstallLocation value') }
if (-not $quiet) { $failures.Add('registry has no (Quiet)UninstallString') }

$installedFiles = if ($dir -and (Test-Path $dir)) { (Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 }
Write-Host "post-install -> dir:$([bool]($dir -and (Test-Path $dir))) files:$installedFiles"
if (-not $dir -or -not (Test-Path $dir) -or $installedFiles -eq 0) { $failures.Add("install produced no files in '$dir'") }

if ($failures.Count -gt 0) {
  Write-Host '::error::Install step failed, cannot test uninstall:'
  $failures | ForEach-Object { Write-Host "::error:: - $_" }
  exit 1
}

# ---------------------------------------------------------------- UNINSTALL
Write-Host '== Silent uninstall via the registry command =='
if ($quiet -match '^\s*"([^"]+)"\s*(.*)$') { $uexe = $matches[1]; $uargs = $matches[2].Trim() }
else { $p = $quiet -split ' ', 2; $uexe = $p[0]; $uargs = if ($p.Count -gt 1) { $p[1] } else { '' } }
# Ensure a silent uninstall even if only the non-quiet UninstallString was available.
if ($uargs -notmatch '(?i)/S(\s|$)') { $uargs = ($uargs + ' /S').Trim() }
Write-Host "uninstaller exe : $uexe"
Write-Host "uninstaller args: $uargs"

$up = if ($uargs) { Start-Process -FilePath $uexe -ArgumentList $uargs -Wait -PassThru }
      else        { Start-Process -FilePath $uexe -Wait -PassThru }
$uninstExit = $up.ExitCode
Write-Host "uninstaller immediate exit code: $uninstExit"

# NSIS uninstallers typically relaunch from %TEMP% and return immediately, so poll until the
# install directory actually disappears (or 90s elapse) before judging the result.
$deadline = (Get-Date).AddSeconds(90)
while ((Test-Path $dir) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
Start-Sleep -Seconds 3

# ---------------------------------------------------------------- VERIFY CLEAN
$leftDir     = Test-Path $dir
$leftKey     = Test-Path $key
$leftAppData = Test-Path $appData
$leftUpdater = Test-Path $updater
$leftSm      = Test-Path $smLnk
$leftDt      = Test-Path $dtLnk
$hung        = (Get-Process -Name 'Uninstall Music Control', 'Music Control' -ErrorAction SilentlyContinue | Measure-Object).Count

Write-Host "post-uninstall leftovers -> dir:$leftDir key:$leftKey appData:$leftAppData updater:$leftUpdater startMenu:$leftSm desktop:$leftDt hungProcs:$hung"

if ($leftDir)     { $failures.Add("install directory still present: $dir") }
if ($leftKey)     { $failures.Add('uninstall registry key still present') }
if ($leftAppData) { $failures.Add("$appData still present") }
if ($leftUpdater) { $failures.Add("$updater still present") }
if ($leftSm)      { $failures.Add('Start Menu shortcut still present') }
if ($leftDt)      { $failures.Add('Desktop shortcut still present') }
if ($hung -gt 0)  { $failures.Add("$hung uninstaller/app process(es) left running (hung)") }

# False-success guard (the 0.1.8 failure mode): exit 0 while things remain.
$removedEverything = -not ($leftDir -or $leftKey -or $leftAppData -or $leftUpdater -or $leftSm -or $leftDt)
if ($uninstExit -eq 0 -and -not $removedEverything) {
  $failures.Add('FALSE SUCCESS: uninstaller returned exit code 0 but left files/keys/shortcuts behind')
}
if ($uninstExit -ne 0 -and $removedEverything) {
  Write-Host "::warning::uninstaller removed everything but returned non-zero exit code $uninstExit"
}

if ($failures.Count -gt 0) {
  Write-Host '::error::UNINSTALLER QA FAILED:'
  $failures | ForEach-Object { Write-Host "::error:: - $_" }
  exit 1
}

Write-Host "UNINSTALLER QA PASSED: clean install/uninstall cycle, exit code $uninstExit, zero leftovers."
