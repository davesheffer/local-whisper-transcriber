# Meeting Recorder + Transcriber app — plan

Spec: `docs/superpowers/specs/2026-11-15-meeting-recorder-app.md`

1. **Server: recordings API + static build** (`server/recordings.js`, `server/server.js`)
   - Recordings store module (list/save/rename/delete, safe ids, path containment).
   - Background transcribe jobs that keep the source file and persist the transcript.
   - Serve `build/` with SPA fallback; keep the plain welcome page when no build exists.
   - Worker: `language == "auto"` → auto-detect.
   - Tests: `server/recordings.test.js` (store, no running server needed).
2. **Client: Record tab** (`src/Recorder.js`, `src/Recorder.css`, `src/App.js`)
   - Capture + mix + meters, IndexedDB crash buffer, upload on stop, auto-transcribe, history UI.
3. **PWA** (`public/manifest.json`, `public/sw.js`, icons, `src/index.js`)
   - Manifest + network-first service worker that never touches `/api` or `/socket.io`.
4. **Windows installer** (`install.ps1`, `install.bat`, `uninstall.ps1`, `scripts/start-hidden.vbs`)
   - Deps (pip, optional GPU, npm), build, Startup-folder autostart, desktop shortcut, start now.
5. **Docs**: README install section.

Checks: `cd server && npx jest recordings.test.js`, `npm run build`, manual record → transcribe in Chrome.
