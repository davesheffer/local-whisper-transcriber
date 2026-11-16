# Builds MeetingTranscriber-Setup-<version>.exe: a per-user (no admin) Windows installer
# that bundles everything the app needs, so the target PC needs nothing but Chrome/Edge:
#   runtime\node\node.exe          portable Node (copied from this machine's node.exe)
#   runtime\python\                embeddable CPython + faster-whisper (CPU; no CUDA libs)
#   app\server, app\build          the server and the prebuilt web app
#   models\base                    Whisper "base", loads offline; bigger models download on demand
#   launcher\*.vbs, stop-server.ps1
# Transcription runs on the CPU unless the target PC has an NVIDIA GPU *and* CUDA libraries;
# whisper_worker.py falls back to CPU automatically, so no GPU is needed.
#
# Usage:  powershell -ExecutionPolicy Bypass -File packaging\build-installer.ps1
#   -SkipAppBuild    reuse the existing build\ folder
#   -SkipSmokeTest   don't load the model / start the staged server
#   -StageOnly       stop after staging (no Inno Setup needed)
# Needs: Node + npm and Python 3 with pip on PATH; Inno Setup 6 (ISCC.exe) for the final step.
# Downloads (cached in packaging\.cache): the Python embeddable zip, PyPI wheels, the base model.
param(
    [string]$PythonVersion = '3.12.10',
    [string]$PythonEmbedSha256 = '',
    [string]$NodeExe = '',
    [string]$Iscc = '',
    [int]$SmokePort = 5057,
    [switch]$SkipAppBuild,
    [switch]$SkipSmokeTest,
    [switch]$StageOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Pkg = $PSScriptRoot
$Root = Split-Path $Pkg -Parent
$Cache = Join-Path $Pkg '.cache'
$Stage = Join-Path $Pkg 'stage'
$Dist = Join-Path $Pkg 'dist'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Invoke-Checked([string]$what, [scriptblock]$cmd) {
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}
function Find-Exe($name) {
    $c = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { throw "$name not found on PATH." }
    $c.Source
}

$Version = (Get-Content "$Root\package.json" -Raw | ConvertFrom-Json).version
$Npm = Find-Exe 'npm.cmd'
$HostPython = Find-Exe 'python'
if (-not $NodeExe) { $NodeExe = Find-Exe 'node' }
$pyTag = ($PythonVersion -split '\.')[0..1] -join ''   # 3.12.10 -> 312
Ok "version $Version | node $NodeExe ($(& $NodeExe --version)) | embeddable Python $PythonVersion"

# --- clean stage ----------------------------------------------------------------
Step 'Preparing stage folder'
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Cache, $Stage, $Dist | Out-Null
$S = @{
    App = "$Stage\app"; Server = "$Stage\app\server"; Node = "$Stage\runtime\node"
    Py = "$Stage\runtime\python"; Models = "$Stage\models"; Launcher = "$Stage\launcher"
}
$S.Values | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

# --- web app ----------------------------------------------------------------------
if (-not $SkipAppBuild) {
    Step 'Building the web app'
    Push-Location $Root
    $oldCi = $env:CI
    try {
        if (-not (Test-Path "$Root\node_modules")) { Invoke-Checked 'npm ci (app)' { & $Npm ci --no-audit --no-fund } }
        $env:CI = 'true'
        Invoke-Checked 'npm run build' { & $Npm run build }
    } finally { $env:CI = $oldCi; Pop-Location }
}
if (-not (Test-Path "$Root\build\index.html")) { throw "build\index.html missing - run without -SkipAppBuild." }
Copy-Item "$Root\build" "$($S.App)\build" -Recurse
Copy-Item "$Root\public\app.ico" "$($S.App)\app.ico"

# --- server -------------------------------------------------------------------------
Step 'Staging the server (production dependencies only)'
foreach ($f in 'server.js', 'recordings.js', 'whisper_worker.py', 'package.json', 'package-lock.json') {
    Copy-Item "$Root\server\$f" $S.Server
}
Push-Location $S.Server
try { Invoke-Checked 'npm ci --omit=dev (server)' { & $Npm ci --omit=dev --no-audit --no-fund } } finally { Pop-Location }
Copy-Item $NodeExe "$($S.Node)\node.exe"

# --- python -------------------------------------------------------------------------
Step "Staging embeddable Python $PythonVersion"
$zipName = "python-$PythonVersion-embed-amd64.zip"
$zip = Join-Path $Cache $zipName
if (-not (Test-Path $zip)) {
    $url = "https://www.python.org/ftp/python/$PythonVersion/$zipName"
    Ok "downloading $url"
    Invoke-WebRequest -Uri $url -OutFile "$zip.part" -UseBasicParsing
    Move-Item "$zip.part" $zip
}
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
if ($PythonEmbedSha256 -and $hash -ne $PythonEmbedSha256.ToUpper()) { throw "$zipName SHA256 $hash does not match -PythonEmbedSha256." }
Ok "$zipName SHA256 $hash"
Expand-Archive $zip -DestinationPath $S.Py
# The ._pth file pins sys.path (no PYTHONPATH, no script dir). Add site-packages.
$pth = "$($S.Py)\python$pyTag._pth"
@("python$pyTag.zip", '.', 'Lib\site-packages', 'import site') | Set-Content $pth -Encoding ASCII
$Site = "$($S.Py)\Lib\site-packages"

Step 'Installing faster-whisper (CPU) into the bundled Python'
Invoke-Checked 'pip install --target' {
    # --no-compile: Python writes __pycache__ on first run instead; bundled .pyc paths are
    # the deepest in the tree and can exceed MAX_PATH under a long install folder.
    & $HostPython -m pip install --disable-pip-version-check --no-warn-script-location --no-compile `
        --cache-dir "$Cache\pip" --target $Site `
        --platform win_amd64 --python-version $PythonVersion --implementation cp --only-binary=:all: `
        -r "$Root\server\requirements.txt"
}
# App-local MSVC runtime (onnxruntime/ctranslate2 need msvcp140) for PCs without the VC++ redistributable.
foreach ($dll in 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll') {
    $src = Join-Path $env:SystemRoot "System32\$dll"
    if ((Test-Path $src) -and -not (Test-Path "$($S.Py)\$dll")) { Copy-Item $src $S.Py }
}
$StagedPython = "$($S.Py)\python.exe"

# --- model --------------------------------------------------------------------------
Step 'Staging the Whisper base model'
$modelCache = "$Cache\models\base"
if (-not (Test-Path "$modelCache\model.bin")) {
    Invoke-Checked 'download base model' {
        & $StagedPython -c "from faster_whisper.utils import download_model; download_model('base', output_dir=r'$modelCache')"
    }
}
Copy-Item $modelCache "$($S.Models)\base" -Recurse
Remove-Item "$($S.Models)\base\.cache" -Recurse -Force -ErrorAction SilentlyContinue

# --- launchers + manifest -------------------------------------------------------------
Copy-Item "$Pkg\launcher\*" $S.Launcher
$commit = 'unknown'
try { $c = & git -C $Root rev-parse --short HEAD 2>$null; if ($LASTEXITCODE -eq 0 -and $c) { $commit = "$c" } } catch { }
$packages = Get-ChildItem $Site -Directory -Filter '*.dist-info' | ForEach-Object { $_.Name -replace '\.dist-info$', '' }
@("Meeting Transcriber $Version (commit $commit), built $(Get-Date -Format s)",
  "node $(& $NodeExe --version)", "python $PythonVersion embeddable (SHA256 $hash)", 'packages:') + ($packages | ForEach-Object { "  $_" }) |
    Set-Content "$Stage\versions.txt" -Encoding UTF8

# --- smoke test (bundled runtime only, offline, minimal PATH) ---------------------------
function New-CleanStartInfo($file, $arguments, $cwd) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo $file, $arguments
    $psi.UseShellExecute = $false
    $psi.WorkingDirectory = $cwd
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $keep = 'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'
    foreach ($k in @($psi.EnvironmentVariables.Keys)) { if ($keep -notcontains $k) { $psi.EnvironmentVariables.Remove($k) } }
    $psi.EnvironmentVariables['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot"
    $psi.EnvironmentVariables['PYTHONNOUSERSITE'] = '1'
    $psi.EnvironmentVariables['HF_HUB_OFFLINE'] = '1'
    $psi.EnvironmentVariables['WHISPER_MODELS_DIR'] = $S.Models
    $psi
}
if (-not $SkipSmokeTest) {
    Step 'Smoke test: bundled Python transcribes with the bundled model (offline, CPU)'
    $probe = Join-Path $Cache 'smoke_probe.py'
    @'
import sys, numpy as np
sys.path.insert(0, sys.argv[1])
import whisper_worker as w
model, device = w.load_model("base")
t = np.arange(16000 * 3, dtype=np.float32) / 16000
segments, info = model.transcribe((0.1 * np.sin(2 * np.pi * 440 * t)).astype(np.float32), vad_filter=True)
list(segments)
print("SMOKE_OK device=%s duration=%.1f" % (device, info.duration))
'@ | Set-Content $probe -Encoding ASCII
    $psi = New-CleanStartInfo $StagedPython "-u `"$probe`" `"$($S.Server)`"" $S.Server
    $psi.EnvironmentVariables['WHISPER_DEVICE'] = 'cpu'
    $p = [System.Diagnostics.Process]::Start($psi)
    $errTask = $p.StandardError.ReadToEndAsync()   # drain both pipes: a full stderr would block the probe
    $out = $p.StandardOutput.ReadToEnd(); $p.WaitForExit(); $err = $errTask.Result
    if ($p.ExitCode -ne 0 -or $out -notmatch 'SMOKE_OK') { throw "Python smoke test failed (exit $($p.ExitCode)):`n$out`n$err" }
    Ok ($out.Trim() -split "`n" | Select-Object -Last 1)

    Step "Smoke test: staged server on :$SmokePort loads the base worker"
    $rec = Join-Path $Cache 'smoke-recordings'
    if (Test-Path $rec) { Remove-Item $rec -Recurse -Force }
    $psi = New-CleanStartInfo "$($S.Node)\node.exe" 'server.js' $S.Server
    $psi.EnvironmentVariables['TRANSCRIBER_PORT'] = "$SmokePort"
    $psi.EnvironmentVariables['PYTHON_BIN'] = $StagedPython
    $psi.EnvironmentVariables['RECORDINGS_DIR'] = $rec
    $psi.RedirectStandardOutput = $false; $psi.RedirectStandardError = $false
    $srv = [System.Diagnostics.Process]::Start($psi)
    try {
        $ready = $null
        for ($i = 0; $i -lt 120 -and -not $ready; $i++) {
            Start-Sleep -Milliseconds 1000
            if ($srv.HasExited) { throw "staged server exited (code $($srv.ExitCode))" }
            try {
                $h = Invoke-RestMethod "http://127.0.0.1:$SmokePort/api/health" -TimeoutSec 2
                if ($h.workers.base.ready) { $ready = $h.workers.base }
            } catch { }
        }
        if (-not $ready) { throw 'staged server never reported the base worker ready (120 s).' }
        $page = Invoke-WebRequest "http://127.0.0.1:$SmokePort/" -UseBasicParsing -TimeoutSec 5
        if ($page.Content -notmatch '<div id="root">') { throw 'staged server did not serve the web app.' }
        Ok "server ok: base ready on $($ready.device) ($($ready.compute_type)); web app served"
    } finally {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($srv.Id)" -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        if (-not $srv.HasExited) { $srv.Kill(); $srv.WaitForExit(5000) | Out-Null }
    }
}
# Leftovers from running the staged Python/server (model download, smoke tests).
Get-ChildItem $Stage -Directory -Filter '__pycache__' -Recurse | Remove-Item -Recurse -Force
Remove-Item "$($S.Server)\uploads" -Recurse -Force -ErrorAction SilentlyContinue

# Inno Setup can't write paths over 260 chars; the default install root
# (%LOCALAPPDATA%\Programs\Meeting Transcriber\) needs ~60 + user-name length.
$maxRel = 160
$long = Get-ChildItem $Stage -Recurse -File | Where-Object { $_.FullName.Length - $Stage.Length - 1 -gt $maxRel }
if ($long) { throw "staged paths longer than $maxRel chars (would break under a long install folder):`n$(($long | Select-Object -First 5).FullName -join "`n")" }

$sizeMb = [math]::Round(((Get-ChildItem $Stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 0)
Ok "stage ready: $Stage ($sizeMb MB)"
if ($StageOnly) { return }

# --- installer ------------------------------------------------------------------------
Step 'Compiling the installer (Inno Setup)'
if (-not $Iscc) {
    $Iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
              "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $Iscc) { $Iscc = (Get-Command iscc -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
}
if (-not $Iscc) { throw 'ISCC.exe (Inno Setup 6) not found. Install it (winget install JRSoftware.InnoSetup) or pass -Iscc <path>. The stage folder is ready.' }
Invoke-Checked 'ISCC' { & $Iscc /Q "/DAppVersion=$Version" "/DStageDir=$Stage" "/O$Dist" "$Pkg\installer.iss" }
$exe = Join-Path $Dist "MeetingTranscriber-Setup-$Version.exe"
Ok "installer: $exe ($([math]::Round((Get-Item $exe).Length / 1MB, 0)) MB)"
