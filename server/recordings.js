// Recording store: audio + metadata + transcript as plain files in one folder.
//   <id>.<ext>   audio (webm/ogg/m4a/...)
//   <id>.json    metadata { id, name, created, duration, size, ext, file, transcript }
//   <id>.txt     transcript text (written when a transcription completes)
//   <id>.segments.json  [{ start, end, text }] timed transcript segments
//   <id>.prev.txt       previous transcript, kept when a re-transcription overwrites <id>.txt
//   <id>.summary.json / <id>.summary.md  AI notes (client-owned shape, stored as-is)
// Deleting moves the files into `_deleted/` so nothing is lost by a misclick.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const AUDIO_EXTS = ['webm', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'mp3', 'wav'];
const ACTIVE = ['queued', 'running'];
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_SEGMENTS = 50000;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function pickExt(mimetype = '', originalName = '') {
  const fromName = path.extname(originalName).slice(1).toLowerCase();
  if (AUDIO_EXTS.includes(fromName)) return fromName;
  if (/ogg/.test(mimetype)) return 'ogg';
  if (/mp4|m4a|aac/.test(mimetype)) return 'm4a';
  if (/mpeg|mp3/.test(mimetype)) return 'mp3';
  if (/wav/.test(mimetype)) return 'wav';
  return 'webm';
}

function stamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    try {
      await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    } catch (copyErr) {
      if (copyErr.code !== 'EEXIST') await fsp.unlink(to).catch(() => {}); // drop a partial copy, keep the source
      throw copyErr;
    }
    await fsp.unlink(from);
  }
}

function createStore(dir) {
  const locks = new Map(); // id -> promise chain, serialises read-modify-write per recording

  const ensure = () => fsp.mkdir(dir, { recursive: true });
  const metaPath = (id) => path.join(dir, `${id}.json`);
  const textPath = (id) => path.join(dir, `${id}.txt`);
  const segmentsPath = (id) => path.join(dir, `${id}.segments.json`);
  const prevTextPath = (id) => path.join(dir, `${id}.prev.txt`);
  const summaryPath = (id) => path.join(dir, `${id}.summary.json`);
  const summaryMdPath = (id) => path.join(dir, `${id}.summary.md`);

  function checkId(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw httpError(400, 'Invalid recording id');
  }

  function withLock(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return next;
  }

  // Metadata is trusted only if it describes its own id and points at <id>.<ext> in dir,
  // so a hand-edited JSON can't make transcribe/remove touch a file outside the store.
  function validMeta(m, id) {
    return !!m && typeof m === 'object' && ID_RE.test(m.id) && (id === undefined || m.id === id)
      && typeof m.name === 'string' && typeof m.file === 'string'
      && m.file === path.basename(m.file) && m.file.startsWith(`${m.id}.`);
  }

  async function get(id) {
    checkId(id);
    let m;
    try {
      m = JSON.parse(await fsp.readFile(metaPath(id), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') throw httpError(404, 'Recording not found');
      throw e;
    }
    if (!validMeta(m, id)) throw httpError(500, 'Recording metadata is invalid');
    return m;
  }

  // Callers hold the recording's lock, so one fixed tmp name per target is enough.
  async function writeAtomic(p, data) {
    const tmp = `${p}.tmp`;
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, p);
  }

  async function writeMeta(meta) {
    await writeAtomic(metaPath(meta.id), JSON.stringify(meta, null, 2));
    return meta;
  }

  async function readJson(p, missing) {
    try {
      return JSON.parse(await fsp.readFile(p, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') throw httpError(404, missing);
      throw e;
    }
  }

  // Moves whichever of `files` exist into _deleted/, never overwriting earlier trash.
  async function trashFiles(files) {
    const trash = path.join(dir, '_deleted');
    await fsp.mkdir(trash, { recursive: true });
    for (const f of files) {
      const src = path.join(dir, f);
      if (!(await exists(src))) continue;
      let dest = path.join(trash, f);
      if (await exists(dest)) dest = path.join(trash, `${Date.now()}-${f}`);
      await moveFile(src, dest);
    }
  }

  // The list exposes summary/segments/edited flags straight from meta (no extra file reads).
  function listItem(m) {
    const t = m.transcript && typeof m.transcript === 'object'
      ? { ...m.transcript, segments: m.transcript.segments === true, edited: m.transcript.edited === true }
      : null;
    return { ...m, transcript: t, summary: m.summary && typeof m.summary === 'object' ? m.summary : null };
  }

  async function list() {
    await ensure();
    const names = await fsp.readdir(dir);
    const metas = [];
    for (const n of names) {
      // <id>.segments.json / <id>.summary.json are not metadata; their stem fails ID_RE.
      if (!n.endsWith('.json') || !ID_RE.test(n.slice(0, -5))) continue;
      try {
        const m = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
        if (!validMeta(m, n.slice(0, -5))) throw new Error('not recording metadata');
        metas.push(listItem(m));
      } catch (e) {
        console.warn(`[recordings] skipping unreadable ${n}: ${e.message}`);
      }
    }
    return metas.sort((a, b) => (b.created || 0) - (a.created || 0));
  }

  // Serialised store-wide so two uploads from the same second can't claim one id.
  // On failure the source upload is left in place for the caller to keep.
  function save(args) {
    return withLock('__save__', () => saveUnlocked(args));
  }

  async function idTaken(id, ext) {
    const trash = path.join(dir, '_deleted');
    for (const p of [metaPath(id), path.join(dir, `${id}.${ext}`), path.join(trash, `${id}.json`), path.join(trash, `${id}.${ext}`)]) {
      if (await exists(p)) return true;
    }
    return false;
  }

  async function saveUnlocked({ tmpPath, originalName, mimetype, name, duration, created }) {
    await ensure();
    const c = Number(created);
    const createdTs = c > 946684800000 && c < 4102444800000 ? c : Date.now(); // 2000..2100, else now
    const ext = pickExt(mimetype, originalName);
    const base = stamp(createdTs);
    let id = base;
    for (let i = 2; await idTaken(id, ext); i++) id = `${base}-${i}`;
    const file = `${id}.${ext}`;
    await moveFile(tmpPath, path.join(dir, file));
    const { size } = await fsp.stat(path.join(dir, file));
    const dur = Number(duration);
    const meta = {
      id,
      name: (typeof name === 'string' && name.trim().slice(0, 200)) || `Meeting ${new Date(createdTs).toLocaleString()}`,
      created: createdTs,
      duration: Number.isFinite(dur) && dur > 0 ? dur : null,
      size,
      ext,
      file,
      transcript: null,
      summary: null,
    };
    return writeMeta(meta);
  }

  function rename(id, name) {
    checkId(id);
    return withLock(id, async () => {
      const meta = await get(id);
      const clean = typeof name === 'string' ? name.trim().slice(0, 200) : '';
      if (!clean) throw httpError(400, 'Name required');
      meta.name = clean;
      return writeMeta(meta);
    });
  }

  function remove(id) {
    checkId(id);
    return withLock(id, async () => {
      const meta = await get(id);
      // Metadata last, so a failure part-way leaves the recording listed.
      await trashFiles([meta.file, `${id}.txt`, `${id}.segments.json`, `${id}.summary.json`,
        `${id}.summary.md`, `${id}.prev.txt`, `${id}.json`]);
      return { id };
    });
  }

  // Merge `patch` into meta.transcript. A `text` field is written to <id>.txt, not kept in the JSON.
  function setTranscript(id, patch) {
    checkId(id);
    return withLock(id, async () => {
      const meta = await get(id);
      const next = { ...(meta.transcript || {}), ...patch };
      if (typeof patch.text === 'string') {
        await writeAtomic(textPath(id), patch.text);
        next.chars = patch.text.length;
        next.preview = patch.text.slice(0, 280);
      }
      delete next.text;
      meta.transcript = next;
      return writeMeta(meta);
    });
  }

  // Removes <id>.segments.json; a user-edited one goes to _deleted/ rather than being unlinked.
  async function dropSegments(id, toTrash) {
    if (toTrash) return trashFiles([`${id}.segments.json`]);
    await fsp.unlink(segmentsPath(id)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }

  // A finished transcription. The new .txt is what matters: the .prev.txt backup of the old text
  // and the segments file are best-effort, so failing them never loses the transcript.
  // A run without segments drops stale ones so they can't contradict the text.
  function completeTranscript(id, patch, segments) {
    checkId(id);
    return withLock(id, async () => {
      const meta = await get(id);
      const edited = !!(meta.transcript && meta.transcript.edited);
      const text = typeof patch.text === 'string' ? patch.text : '';
      if (await exists(textPath(id))) {
        try {
          const tmp = `${prevTextPath(id)}.tmp`;
          await fsp.copyFile(textPath(id), tmp);
          await fsp.rename(tmp, prevTextPath(id));
        } catch (e) {
          console.warn(`[recordings] ${id}: could not back up the previous transcript: ${e.message}`);
        }
      }
      await writeAtomic(textPath(id), text);
      const segs = (Array.isArray(segments) ? segments : [])
        .map((s) => ({ start: Number(s.start), end: Number(s.end), text: typeof s.text === 'string' ? s.text : '' }))
        .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
        .sort((a, b) => a.start - b.start);
      let hasSegments = false;
      try {
        if (edited) await dropSegments(id, true);
        if (segs.length) {
          await writeAtomic(segmentsPath(id), JSON.stringify(segs));
          hasSegments = true;
        } else {
          await dropSegments(id, false);
        }
      } catch (e) {
        console.warn(`[recordings] ${id}: could not save segments: ${e.message}`);
        await dropSegments(id, edited).catch(() => {}); // don't leave stale segments behind the new text
      }
      const next = {
        ...(meta.transcript || {}), ...patch,
        chars: text.length, preview: text.slice(0, 280), segments: hasSegments, edited: false,
      };
      delete next.text;
      meta.transcript = next;
      return writeMeta(meta);
    });
  }

  function validSegments(segments) {
    if (!Array.isArray(segments)) throw httpError(400, 'segments must be an array');
    if (segments.length > MAX_SEGMENTS) throw httpError(400, `At most ${MAX_SEGMENTS} segments`);
    return segments.map((s, i) => {
      const ok = !!s && typeof s === 'object' && typeof s.text === 'string'
        && Number.isFinite(s.start) && s.start >= 0 && Number.isFinite(s.end) && s.end >= 0;
      if (!ok) throw httpError(400, `Invalid segment ${i}`);
      return { start: s.start, end: s.end, text: s.text };
    });
  }

  // A user edit of a finished transcript. Without segments (or with `[]`) the old segments
  // no longer match the text, so they move to _deleted/.
  function editTranscript(id, body) {
    checkId(id);
    const { text, segments } = body && typeof body === 'object' ? body : {};
    if (typeof text !== 'string') return Promise.reject(httpError(400, 'text must be a string'));
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return Promise.reject(httpError(400, 'text is larger than 5 MB'));
    let segs;
    try {
      segs = segments === undefined ? undefined : validSegments(segments);
    } catch (e) {
      return Promise.reject(e);
    }
    return withLock(id, async () => {
      const meta = await get(id);
      if (!meta.transcript || meta.transcript.status !== 'done') throw httpError(409, 'Only a finished transcript can be edited');
      await writeAtomic(textPath(id), text);
      const hasSegments = !!(segs && segs.length);
      if (hasSegments) await writeAtomic(segmentsPath(id), JSON.stringify(segs));
      else await dropSegments(id, true);
      meta.transcript = { ...meta.transcript, chars: text.length, preview: text.slice(0, 280), segments: hasSegments, edited: true };
      return writeMeta(meta);
    });
  }

  function readSegments(id) {
    checkId(id);
    return readJson(segmentsPath(id), 'No segments');
  }

  function readSummary(id) {
    checkId(id);
    return readJson(summaryPath(id), 'No summary');
  }

  const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

  function putSummary(id, body) {
    checkId(id);
    const { summary, markdown } = body && typeof body === 'object' ? body : {};
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(summary))) {
      return Promise.reject(httpError(400, 'summary must be an object'));
    }
    if (typeof markdown !== 'string') return Promise.reject(httpError(400, 'markdown must be a string'));
    if (Buffer.byteLength(markdown, 'utf8') > MAX_TEXT_BYTES) return Promise.reject(httpError(400, 'markdown is larger than 5 MB'));
    return withLock(id, async () => {
      const meta = await get(id);
      await writeAtomic(summaryPath(id), JSON.stringify(summary, null, 2));
      await writeAtomic(summaryMdPath(id), markdown);
      meta.summary = { updatedAt: Date.now(), title: clip(summary.title, 200), tldr: clip(summary.tldr, 500) };
      return writeMeta(meta);
    });
  }

  function deleteSummary(id) {
    checkId(id);
    return withLock(id, async () => {
      const meta = await get(id);
      await trashFiles([`${id}.summary.json`, `${id}.summary.md`]);
      meta.summary = null;
      return writeMeta(meta);
    });
  }

  async function readTranscript(id) {
    checkId(id);
    try {
      return await fsp.readFile(textPath(id), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw httpError(404, 'No transcript yet');
      throw e;
    }
  }

  function audioPath(meta) {
    return path.join(dir, meta.file);
  }

  // Jobs that were in flight when the server stopped can never finish.
  async function markInterrupted() {
    const metas = await list();
    let n = 0;
    for (const m of metas) {
      if (m.transcript && ACTIVE.includes(m.transcript.status)) {
        try {
          await setTranscript(m.id, { status: 'interrupted' });
          n++;
        } catch (e) {
          console.warn(`[recordings] could not mark ${m.id} interrupted: ${e.message}`);
        }
      }
    }
    return n;
  }

  return {
    dir, get, list, save, rename, remove, setTranscript, completeTranscript, editTranscript, readTranscript,
    readSegments, readSummary, putSummary, deleteSummary, audioPath, markInterrupted, ACTIVE,
  };
}

module.exports = { createStore, httpError, pickExt };
