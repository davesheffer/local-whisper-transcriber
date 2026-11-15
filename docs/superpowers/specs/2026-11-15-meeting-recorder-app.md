# Meeting Recorder + Transcriber app — spec

**Goal:** one locally installed app that records Zoom / Google Meet audio (system audio + mic) and
transcribes each recording with the existing local Whisper worker, with a persistent history.

## Decisions (approved 2026-11-15)
- **Packaging:** installable PWA served by the existing Node server on `http://localhost:5000`.
  The server autostarts hidden at Windows login; installer adds a desktop shortcut. (Electron rejected for now: slower to ship.)
- **Storage:** files on disk, `%USERPROFILE%\Documents\Meeting Recordings` (override `RECORDINGS_DIR`):
  `<id>.webm` audio, `<id>.json` metadata, `<id>.txt` transcript. Delete moves files to `_deleted\` (recoverable).
- **Auto-transcribe:** when a recording stops it is uploaded and transcribed with the selected model + language.

## Behaviour
- React app gets two tabs: **Record** (new) and **Transcribe file** (existing UI, unchanged).
- Record: Chrome `getDisplayMedia` (system/tab audio) mixed with mic via Web Audio → `MediaRecorder` (Opus/WebM).
  Chunks are mirrored to IndexedDB every second; interrupted recordings are recovered and uploaded on next launch.
- History lists recordings from the server: play, rename, download audio, copy/download transcript, (re)transcribe, delete.
- Transcription runs as a background job (not tied to an HTTP request) and keeps the source file.
  Live progress streams over the existing socket; transcript is written to disk on completion.
  Jobs left `running` when the server stops are marked `interrupted` on startup.
- Language select: Hebrew (default), English, Auto-detect (`auto` → worker passes `None`).

## API (new)
| Method | Path | |
|---|---|---|
| GET | `/api/recordings` | list metadata, newest first |
| POST | `/api/recordings` | multipart `file`, `name`, `duration`, `created` → metadata |
| GET | `/api/recordings/:id/audio` | audio (Range support) |
| GET | `/api/recordings/:id/transcript` | `.txt` download |
| PATCH | `/api/recordings/:id` | `{ name }` |
| DELETE | `/api/recordings/:id` | move to `_deleted\` |
| POST | `/api/recordings/:id/transcribe` | `{ model, language, clientId }` → `202 { jobId }` |

Socket: server broadcasts `recording-updated { id }` whenever metadata changes.

## Out of scope
Electron packaging, speaker diarization, cloud sync, non-Windows install scripts.
