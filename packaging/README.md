# Windows installer

`build-installer.ps1` produces `packaging\dist\MeetingTranscriber-Setup-<version>.exe`, a
per-user installer (no admin rights) for people who should not have to install Python,
Node or run scripts. It bundles:

| Folder (under `%LOCALAPPDATA%\Programs\Meeting Transcriber`) | Contents |
|---|---|
| `runtime\node` | `node.exe` copied from the build machine |
| `runtime\python` | embeddable CPython + faster-whisper (CPU build, no CUDA libraries) |
| `app\server`, `app\build` | the server and the prebuilt web app |
| `models\base` | Whisper `base`, loads offline; other models download here on first use |
| `launcher` | `open-app.vbs`, `start-server.vbs`, `stop-server.ps1` |
| `logs` | `server.log` (rotated at 5 MB) |

The install folder is fixed (no folder page), because upgrades and uninstall replace
`runtime\` and `app\` wholesale. The installer adds a Start menu entry (opens the app in a Chrome/Edge app window), an
optional desktop shortcut, and an optional sign-in autostart for the server. Uninstalling
stops the server and removes the program; recordings in `Documents\Meeting Recordings`
are kept.

## Target PC

- Windows 10/11 x64, Google Chrome (recording uses tab-audio sharing; AI notes use
  Chrome's on-device model: Chrome 138+, 16 GB RAM or a GPU, ~22 GB free disk).
- No GPU needed: transcription runs on the CPU with int8. The CUDA libraries are not
  bundled, so on a PC with an NVIDIA GPU the worker tries CUDA and falls back to the CPU
  before reporting ready if cuBLAS/cuDNN can't load.
- The installer is unsigned, so SmartScreen shows "Windows protected your PC":
  click **More info → Run anyway**.

## Building

Needs Node + npm, Python 3 with pip, and [Inno Setup 6](https://jrsoftware.org/isinfo.php)
(`winget install JRSoftware.InnoSetup --scope user`).

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build-installer.ps1
```

Options: `-StageOnly` (skip Inno Setup), `-SkipAppBuild` (reuse `build\`),
`-SkipSmokeTest`, `-PythonVersion 3.12.10`, `-PythonEmbedSha256 <hash>`, `-NodeExe <path>`.

Downloads are cached in `packaging\.cache`. Before writing the installer the script runs
two smoke tests with a minimal PATH and `HF_HUB_OFFLINE=1`: the bundled Python loads the
bundled model and transcribes a tone on the CPU, and the staged server (on port 5057 via
`TRANSCRIBER_PORT`, so a running copy on 5000 is untouched) reports the `base` worker
ready and serves the web app.
`packaging\stage\versions.txt` lists the bundled versions.
