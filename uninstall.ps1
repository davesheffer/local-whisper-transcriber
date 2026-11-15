# Removes what install.ps1 added: autostart, desktop shortcut, launchers, running server.
# Keeps your recordings (Documents\Meeting Recordings), the code, and installed packages.
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$AppName = 'Meeting Transcriber'

$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Startup')) "$AppName Server.lnk"),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk")
)
foreach ($t in $targets) {
    if (Test-Path $t) { Remove-Item $t; Write-Host "Removed $t" }
}

$listener = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)").CommandLine
    if ($cmdLine -like '*node*server.js*') {
        Stop-Process -Id $listener.OwningProcess -Force
        Write-Host "Stopped server (pid $($listener.OwningProcess))"
    }
}

$launcher = Join-Path $Root 'launcher'
if (Test-Path $launcher) { Remove-Item $launcher -Recurse; Write-Host "Removed $launcher" }

Write-Host "Done. Recordings were kept in Documents\Meeting Recordings."
