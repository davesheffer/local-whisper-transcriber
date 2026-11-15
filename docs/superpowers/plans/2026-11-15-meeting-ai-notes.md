# Meeting AI notes — plan

Spec: `docs/superpowers/specs/2026-11-15-meeting-ai-notes.md`. Tasks 1 and 2 run in parallel (disjoint files), joined by the spec's API contract.

## Task 1 — server (server/ only) → `feat(server): segments, transcript edits and summary storage`
- Capture segments per recording job; write `<id>.segments.json`; `meta.transcript.segments/edited`.
- `<id>.prev.txt` backup before re-transcribe overwrite.
- Routes: GET segments; PUT transcript; GET/PUT/DELETE summary; list fields; delete moves all files.
- Route-level 5 MB JSON parser.
- Tests in `server/recordings.test.js` (store level) for every new store function, validation failures (400), 404s, 409 while transcribing, delete moving all files, prev.txt backup.
- Check: `cd server && npx jest recordings.test.js`, `node --check server.js`.
- Gate: critic review (security: input validation, path handling, size limits, Host/Origin coverage of new routes).

## Task 2 — client AI module (src/ai/) → `feat(client): on-device AI engine`
- `src/ai/builtin.js`: availability (per language), download with progress, sessions, LanguageDetector, Translator (chunked ≤ ~1500 chars at segment/sentence boundaries), LanguageModel prompt with `responseConstraint` JSON schema, map-reduce for long text, Q&A with chunk retrieval, sha256 helper, markdown export builder.
- No React in this module; pure async functions + an AbortSignal everywhere.

## Task 3 — client UI → `feat(client): AI notes, Q&A, timestamps and transcript editing`
- Recording detail gets sub-tabs: Notes | Transcript | Ask.
- Notes: enable-AI / download state, Generate/Regenerate, sections, stale banner, copy, Export .md; auto-title; auto-summarize setting.
- Transcript: segments with click-to-seek + playing highlight; translate toggle; edit mode + save.
- Ask: chat, history persisted via PUT summary.
- Search covers summary title/TL;DR.
- Check: `CI=true npm run build`.

## Task 4 — verify
Chrome on :5000 (installed server, rebuild): download model, Hebrew + English recordings (TTS wav uploads), summary, auto-title, ask, export, translate, seek, edit/save, stale banner. Then `ff.py check` all, PR body update.
