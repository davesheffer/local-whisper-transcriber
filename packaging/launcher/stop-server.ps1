# Stops the bundled server and its Whisper workers: only processes running the bundled
# runtime\node\node.exe / runtime\python\python.exe (a dev copy of the app, other Node
# apps and other Pythons are untouched). Exit 1 if one is still running afterwards.
$ErrorActionPreference = 'SilentlyContinue'
$runtime = Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime'
if (-not (Test-Path -LiteralPath $runtime)) { exit 0 }
$prefix = (Resolve-Path -LiteralPath $runtime).Path.TrimEnd('\') + '\'
function Get-Bundled {
    Get-Process -Name node, python | Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }
}
foreach ($p in @(Get-Bundled)) { Stop-Process -Id $p.Id -Force; $p.WaitForExit(5000) | Out-Null }
if (@(Get-Bundled).Count) { exit 1 }
exit 0
