# Meeting AI notes (on-device) — spec

Date: 2026-11-15. Branch: `feat/meeting-recorder-app` (PR #1). Owner approved scope via Q&A on 2026-11-15.

## Goal
Every recording gets AI meeting notes produced **entirely in Chrome** (built-in AI: Gemini Nano via Prompt API, Translator, LanguageDetector). No Ollama, no cloud, no extra installs. Notes and transcript edits are saved next to the recording in `Documents\Meeting Recordings`.

## Facts measured on the owner's machine (Chrome 157, 2026-11-15)
- `LanguageModel` en→en: `downloadable`; he: `unavailable`.
- `Summarizer` en: `downloadable`; he: `unavailable`.
- `Translator` he→en and en→he: `downloadable`.
- `LanguageDetector`: `available`.
=> Hebrew pipeline: detect → translate to English → prompt in English → translate results back to the transcript language. English transcripts skip translation.
- First model download needs a user gesture (transient activation): call `LanguageModel.create()` / `Translator.create()` from the click handler before any long await.

## Features
1. **Summary** (per recording): title, TL;DR, key points, decisions, action items (task + owner if said). In the transcript's language (Hebrew → Hebrew). Generate / Regenerate button, progress (download %, "Translating…", "Summarizing part 2/5…"). Long transcripts: map-reduce over chunks sized from `session.inputQuota` / `measureInputUsage`.
2. **Auto-summarize** new recordings when transcription completes while the app is open (setting, default on once the model is downloaded).
3. **Auto-title**: if the recording still has its default name (`Meeting <date>`), rename it to the summary title (PATCH name). Never overwrite a user-chosen name.
4. **Ask the meeting**: chat on each recording; question answered from the transcript (translated context when Hebrew; if the transcript exceeds the quota, pick the most relevant chunks by keyword overlap). Q&A history saved in the summary file.
5. **Export notes**: download `<name>.md` = title, date, duration, summary sections, action items as `- [ ]`, full transcript with `[mm:ss]` timestamps.
6. **Translate transcript**: toggle to show the transcript translated (he↔en) side by side; translation cached in the summary file.
7. **Timestamps + click-to-seek**: transcript shown as segments `[mm:ss] text`; click jumps the audio; the playing segment is highlighted and auto-scrolled (pausable).
8. **Edit transcript**: edit mode edits per segment (keeps timestamps) or one textarea when there are no segments; Save writes to disk. Summary shows "Transcript changed — Regenerate" when its stored `sourceHash` (SHA-256 of transcript text) no longer matches.
9. **Search** also matches summary title / TL;DR.
10. If built-in AI is unavailable (other browser / unsupported device): AI sections show a clear explanation; everything else works.

## Server API contract (new; same Host/Origin protection as existing routes)
Files per recording id: `<id>.<ext>` audio, `<id>.json` meta, `<id>.txt` transcript, **new** `<id>.segments.json`, `<id>.summary.json`, `<id>.summary.md`, `<id>.prev.txt`.

- **Segments capture**: for recording transcription jobs, collect worker `segment` messages `{start_time,end_time,text}`; on `complete` write `<id>.segments.json` = `[{ "start": number, "end": number, "text": string }]` atomically (tmp + rename), and set `meta.transcript.segments = true`, `meta.transcript.edited = false`.
- **Re-transcribe backup**: before a new transcription overwrites `<id>.txt`, copy the existing one to `<id>.prev.txt` (one backup, overwritten each time).
- `GET /api/recordings/:id/segments` → 200 JSON array, 404 if none.
- `PUT /api/recordings/:id/transcript` JSON `{ "text": string, "segments"?: [{start,end,text}] }`, limit 5 MB. Validation: text string ≤ 5 MB; segments array ≤ 50 000, each start/end finite ≥ 0, text string. 409 while a transcription job runs for this id. Writes `.txt` (and `.segments.json` if given) atomically; `meta.transcript.edited = true`; announces `recording-updated`. → 200 `{ ok: true }`.
- `GET /api/recordings/:id/summary` → 200 JSON (as stored), 404 if none.
- `PUT /api/recordings/:id/summary` JSON `{ "summary": object, "markdown": string }`, limit 5 MB. `summary` must be a plain object; `markdown` a string. Writes `<id>.summary.json` and `<id>.summary.md` atomically; sets `meta.summary = { updatedAt, title (string ≤ 200, from summary.title), tldr (string ≤ 500) }`; announces `recording-updated`. → 200 `{ ok: true }`.
- `DELETE /api/recordings/:id/summary` → moves summary files to `_deleted`.
- `GET /api/recordings` items gain `summary: {updatedAt,title,tldr} | null` and `transcript.segments`, `transcript.edited` (from meta; no extra file reads).
- Delete recording moves **all** `<id>.*` files above into `_deleted`.
- The global `express.json()` limit (100 kb) must not reject these routes (route-specific `express.json({ limit: '5mb' })` mounted before / instead of the global parser for them).

### Summary JSON shape (client-owned, server stores as-is)
```json
{
  "version": 1,
  "lang": "he",
  "title": "…", "tldr": "…",
  "keyPoints": ["…"], "decisions": ["…"],
  "actionItems": [{ "task": "…", "owner": "…" }],
  "qa": [{ "q": "…", "a": "…", "at": 1731670000000 }],
  "translations": { "en": "…" },
  "sourceHash": "sha256 hex", "createdAt": 1731670000000, "engine": "chrome-builtin"
}
```

## Out of scope
Speaker diarization (no browser API), cloud models, mobile.
