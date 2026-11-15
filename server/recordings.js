// Recording store: audio + metadata + transcript as plain files in one folder.
//   <id>.<ext>   audio (webm/ogg/m4a/...)
//   <id>.json    metadata { id, name, created, duration, size, ext, file, transcript }
//   <id>.txt     transcript text (written when a transcription completes)
// Deleting moves the files into `_deleted/` so nothing is lost by a misclick.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const AUDIO_EXTS = ['webm', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'mp3', 'wav'];
const ACTIVE = ['queued', 'running'];

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

  async function writeMeta(meta) {
    const tmp = `${metaPath(meta.id)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
    await fsp.rename(tmp, metaPath(meta.id));
    return meta;
  }

  async function list() {
    await ensure();
    const names = await fsp.readdir(dir);
    const metas = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const m = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
        if (!validMeta(m, n.slice(0, -5))) throw new Error('not recording metadata');
        metas.push(m);
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
      const trash = path.join(dir, '_deleted');
      await fsp.mkdir(trash, { recursive: true });
      for (const f of [meta.file, `${id}.txt`, `${id}.json`]) {
        const src = path.join(dir, f);
        if (!(await exists(src))) continue;
        let dest = path.join(trash, f);
        if (await exists(dest)) dest = path.join(trash, `${Date.now()}-${f}`); // never overwrite trash
        await moveFile(src, dest);
      }
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
        await fsp.writeFile(textPath(id), patch.text, 'utf8');
        next.chars = patch.text.length;
        next.preview = patch.text.slice(0, 280);
      }
      delete next.text;
      meta.transcript = next;
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

  return { dir, get, list, save, rename, remove, setTranscript, readTranscript, audioPath, markInterrupted, ACTIVE };
}

module.exports = { createStore, httpError, pickExt };
