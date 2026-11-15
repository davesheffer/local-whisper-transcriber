import React, { useCallback, useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
  StopIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import './Recorder.css';

import { API } from './api';

const MODELS = [
  { value: 'tiny', label: 'Fastest' },
  { value: 'base', label: 'Balanced' },
  { value: 'small', label: 'More accurate' },
  { value: 'medium', label: 'Most accurate (slow)' },
  { value: 'large-v3-turbo', label: 'Turbo (fast + best)' },
  { value: 'large-v3', label: 'Large (best, slow)' },
];
const LANGUAGES = [
  { value: 'he', label: 'Hebrew' },
  { value: 'en', label: 'English' },
  { value: 'auto', label: 'Auto-detect' },
];

// ---------------------------------------------------------------------------
// IndexedDB crash buffer. Every second of audio is written here while
// recording; after a stop (or a crash) pending sessions are uploaded to the
// server and removed. Nothing here is the long-term copy — the server is.
// ---------------------------------------------------------------------------
const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open('meeting-recorder-app', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('sessions', { keyPath: 'id' });
    req.result.createObjectStore('parts');
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function idb(store, mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const putSession = (s) => idb('sessions', 'readwrite', (st) => st.put(s));
const allSessions = () => idb('sessions', 'readonly', (st) => st.getAll());
const putPart = (id, seq, blob) => idb('parts', 'readwrite', (st) => st.put(blob, [id, seq]));
const partsRange = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);
const getParts = (id) => idb('parts', 'readonly', (st) => st.getAll(partsRange(id)));
const allPartKeys = () => idb('parts', 'readonly', (st) => st.getAllKeys());
async function dropSession(id) {
  await idb('parts', 'readwrite', (st) => st.delete(partsRange(id)));
  await idb('sessions', 'readwrite', (st) => st.delete(id));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  return `${h ? h + ':' : ''}${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
}
const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const pickMime = () =>
  ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
async function api(path, opts = {}) {
  const res = await fetch(API + path, opts);
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error((isJson && body.error) || `HTTP ${res.status}`);
  return body;
}
const sessionLock = (id) => `meeting-recorder-session-${id}`;

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------
export default function Recorder() {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState({ text: 'Ready', error: false });
  const [useMic, setUseMic] = useState(load('rec.useMic', '1') === '1');
  const [micId, setMicId] = useState(load('rec.micId', ''));
  const [mics, setMics] = useState([]);
  const [model, setModel] = useState(load('rec.model', 'base'));
  const [language, setLanguage] = useState(load('rec.language', 'he'));
  const [autoTranscribe, setAutoTranscribe] = useState(load('rec.auto', '1') === '1');
  const [recordings, setRecordings] = useState([]);
  const [folder, setFolder] = useState('');
  const [progress, setProgress] = useState({});
  const [serverDown, setServerDown] = useState(false);
  const [source, setSource] = useState(load('rec.source', 'desktop'));
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);

  const recRef = useRef(null);
  const sysBar = useRef(null);
  const micBar = useRef(null);
  const settingsRef = useRef({ model, language, autoTranscribe });
  settingsRef.current = { model, language, autoTranscribe };

  useEffect(() => save('rec.useMic', useMic ? '1' : '0'), [useMic]);
  useEffect(() => save('rec.micId', micId), [micId]);
  useEffect(() => save('rec.model', model), [model]);
  useEffect(() => save('rec.language', language), [language]);
  useEffect(() => save('rec.source', source), [source]);
  useEffect(() => save('rec.auto', autoTranscribe ? '1' : '0'), [autoTranscribe]);

  const say = (text, error = false) => setStatus({ text, error });

  const refresh = useCallback(async () => {
    try {
      const data = await api('/api/recordings');
      setRecordings(data.recordings);
      setFolder(data.dir);
      setServerDown(false);
      setLoadFailed(false);
    } catch {
      setServerDown(true);
      setLoadFailed(true);
    }
    setLoaded(true);
  }, []);

  const transcribe = useCallback(async (id) => {
    const { model: m, language: l } = settingsRef.current;
    try {
      await api(`/api/recordings/${encodeURIComponent(id)}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, language: l }),
      });
    } catch (e) {
      say(`Could not start transcription: ${e.message}`, true);
    }
  }, []);

  // Upload every finished or orphaned session in the crash buffer.
  // A Web Lock keeps two windows from uploading the same session twice, and
  // sessions still being recorded (they hold their own lock) are skipped.
  const flushPending = useCallback(async () => {
    const run = async () => {
      const held = navigator.locks ? (await navigator.locks.query()).held.map((l) => l.name) : [];
      const sessions = new Map((await allSessions()).map((s) => [s.id, s]));
      for (const [id] of await allPartKeys()) if (!sessions.has(id)) sessions.set(id, { id });
      let uploaded = 0;
      for (const s of sessions.values()) {
        if (held.includes(sessionLock(s.id))) continue;
        const parts = await getParts(s.id);
        const blob = new Blob(parts, { type: s.mime || parts[0]?.type || 'audio/webm' });
        if (!blob.size) { await dropSession(s.id); continue; }
        const recovered = !s.stopped;
        const form = new FormData();
        form.append('file', blob, `recording.${blob.type.includes('ogg') ? 'ogg' : 'webm'}`);
        form.append('created', String(s.id));
        form.append('duration', String(s.duration || parts.length * 1000));
        form.append('name', `${recovered ? 'Recovered' : 'Meeting'} ${fmtDate(s.id)}`);
        const meta = await api('/api/recordings', { method: 'POST', body: form });
        await dropSession(s.id);
        uploaded++;
        if (settingsRef.current.autoTranscribe) await transcribe(meta.id);
      }
      return uploaded;
    };
    return navigator.locks ? navigator.locks.request('meeting-recorder-flush', run) : run();
  }, [transcribe]);

  // initial load + live updates
  useEffect(() => {
    refresh();
    flushPending()
      .then((n) => { if (n) { say(`Uploaded ${n} unsaved recording${n > 1 ? 's' : ''} from last time.`); refresh(); } })
      .catch(() => say('Server offline — unsaved recordings stay in this browser until it is back.', true));

    const socket = io(API);
    let timer;
    socket.on('connect', () => { setServerDown(false); refresh(); });
    socket.on('disconnect', () => setServerDown(true));
    socket.on('recording-updated', () => { clearTimeout(timer); timer = setTimeout(refresh, 150); });
    socket.on('recording-progress', (p) => setProgress((prev) => ({ ...prev, [p.id]: p })));
    return () => { clearTimeout(timer); socket.disconnect(); };
  }, [refresh, flushPending]);

  const loadMics = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMics(devices.filter((d) => d.kind === 'audioinput' && d.deviceId && !['default', 'communications'].includes(d.deviceId)));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadMics(); }, [loadMics]);

  // ---------------- recording ----------------
  async function start() {
    if (recRef.current) return;
    say('Choose what to share…');
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
      });
    } catch {
      say('Cancelled');
      return;
    }
    const sysTrack = display.getAudioTracks()[0];
    if (!sysTrack) {
      display.getTracks().forEach((t) => t.stop());
      say('No audio was shared. Pick "Entire screen" and tick "Share system audio" (or a tab + "Share tab audio").', true);
      return;
    }

    let mic = null;
    if (useMic) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true },
        });
        loadMics();
      } catch {
        say('Mic unavailable — recording meeting audio only.', true);
      }
    }

    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const meters = [];
    const addSource = (stream, bar) => {
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(dest);
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      meters.push(() => {
        an.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        if (bar.current) bar.current.style.width = Math.min(100, Math.sqrt(peak) * 100) + '%';
      });
    };
    addSource(new MediaStream([sysTrack]), sysBar);
    if (mic) addSource(mic, micBar);

    const mime = pickMime();
    const mr = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : {});
    const id = Date.now();
    const rec = {
      id, mr, ctx, seq: 0, writes: [], startedAt: performance.now(),
      mime: mr.mimeType || mime || 'audio/webm',
      tracks: [...display.getTracks(), ...(mic ? mic.getTracks() : [])],
    };
    recRef.current = rec;

    // Hold a lock for this session so other windows don't treat it as orphaned.
    if (navigator.locks) {
      navigator.locks.request(sessionLock(id), () => new Promise((release) => { rec.releaseLock = release; }));
    }
    await putSession({ id, mime: rec.mime, stopped: false });

    // The video track is kept alive (stopping it can end the share) but never recorded.
    display.getVideoTracks().forEach((t) => { t.enabled = false; });
    sysTrack.addEventListener('ended', () => stop());

    mr.ondataavailable = (e) => {
      if (e.data.size) rec.writes.push(putPart(id, rec.seq++, e.data).catch(() => {}));
    };
    mr.onstop = () => finish(rec);
    mr.start(1000);

    // Load the model now so transcription starts the moment recording ends.
    if (settingsRef.current.autoTranscribe) {
      fetch(`${API}/api/warmup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settingsRef.current.model }),
      }).catch(() => {});
    }

    setRecording(true);
    say('Recording…');
    rec.timer = setInterval(() => setElapsed(performance.now() - rec.startedAt), 250);
    const loop = () => {
      meters.forEach((m) => m());
      if (recRef.current === rec) rec.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function stop() {
    const rec = recRef.current;
    if (!rec || rec.mr.state === 'inactive') return;
    say('Saving…');
    rec.mr.stop();
  }

  async function finish(rec) {
    clearInterval(rec.timer);
    cancelAnimationFrame(rec.raf);
    rec.tracks.forEach((t) => t.stop());
    rec.ctx.close().catch(() => {});
    recRef.current = null;
    setRecording(false);
    setElapsed(0);
    [sysBar, micBar].forEach((b) => { if (b.current) b.current.style.width = '0'; });

    const duration = performance.now() - rec.startedAt;
    await Promise.all(rec.writes);
    await putSession({ id: rec.id, mime: rec.mime, stopped: true, duration });
    if (rec.releaseLock) rec.releaseLock();

    try {
      await flushPending();
      say(`Saved · ${fmtDuration(duration)}${settingsRef.current.autoTranscribe ? ' · transcribing in Recordings below' : ''}`);
      refresh();
    } catch (e) {
      say(`Recording kept in this browser — upload failed (${e.message}). It will upload automatically when the server is running.`, true);
    }
  }

  useEffect(() => {
    const warn = (e) => { if (recRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    const key = (e) => {
      if (e.code === 'Space' && !e.target.closest('input, select, textarea, button, a, audio')) {
        e.preventDefault();
        recRef.current ? stop() : start();
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('keydown', key); };
  });

  const saving = status.text === 'Saving…';
  const micLabel = !useMic ? 'Off' : (mics.find((m) => m.deviceId === micId)?.label || 'Default');
  const modelLabel = MODELS.find((m) => m.value === model)?.label || model;
  const langLabel = LANGUAGES.find((l) => l.value === language)?.label || language;
  const btnState = saving ? 'saving' : recording ? 'on' : 'idle';
  const btnLabel = saving ? 'Saving…' : recording ? 'Stop and save' : 'Start recording';

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(folder);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    } catch { /* clipboard unavailable */ }
  }

  const onKeySource = (e) => {
    if (recording) return;
    if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      const next = source === 'desktop' ? 'tab' : 'desktop';
      setSource(next);
      const el = e.currentTarget.parentElement.querySelector(`[data-source="${next}"]`);
      if (el) el.focus();
    }
  };

  // ---------------- render ----------------
  return (
    <div className="recorder">
      <div className={`rec-panel ${recording ? 'is-recording' : ''}`}>
        <div className="rec-source">
          <span className="rec-source-title" id="rec-source-title">What are you recording?</span>
          <div className="rec-seg" role="radiogroup" aria-labelledby="rec-source-title">
            {[
              { v: 'desktop', t: 'Desktop app', s: 'Zoom, Teams' },
              { v: 'tab', t: 'Browser tab', s: 'Google Meet' },
            ].map((o) => (
              <button
                key={o.v}
                type="button"
                role="radio"
                aria-checked={source === o.v}
                tabIndex={source === o.v ? 0 : -1}
                data-source={o.v}
                disabled={recording}
                className={`rec-seg-btn ${source === o.v ? 'active' : ''}`}
                onClick={() => setSource(o.v)}
                onKeyDown={onKeySource}
              >
                <span className="seg-main">{o.t}</span>
                <span className="seg-sub">{o.s}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="rec-main">
          <div className="rec-btn-wrap">
            <button
              type="button"
              className={`rec-button ${btnState}`}
              onClick={() => (recording ? stop() : start())}
              disabled={btnState === 'saving'}
              aria-labelledby="rec-button-label"
              title="Start / stop (Space)"
            >
              {btnState === 'saving' ? <span className="spinner" aria-hidden="true" /> : recording ? <StopIcon aria-hidden="true" /> : <span className="rec-dot" aria-hidden="true" />}
            </button>
          </div>
          <span className="rec-button-label" id="rec-button-label">{btnLabel}</span>
          {recording && <div className="rec-timer" aria-hidden="true">{fmtDuration(elapsed)}</div>}
        </div>

        {!recording && (
          <p className="rec-hint">
            {source === 'desktop'
              ? <>Chrome will ask what to share — pick <b>Entire screen</b> and turn on <b>Share system audio</b>.</>
              : <>Chrome will ask what to share — pick the <b>meeting tab</b> and turn on <b>Share tab audio</b>.</>}
          </p>
        )}

        <div className="rec-meters">
          <div className="rec-meter"><span>Meeting audio</span><div className="rec-bar"><b ref={sysBar} /></div></div>
          <div className="rec-meter"><span>Your mic</span><div className="rec-bar"><b ref={micBar} /></div></div>
        </div>

        <div className={`rec-status ${status.error ? 'err' : ''}`} role="status" aria-live="polite">
          {status.error && <ExclamationCircleIcon className="rec-status-icon" aria-hidden="true" />}
          <span>{status.text}</span>
        </div>
      </div>

      {serverDown && (
        <div className="rec-banner">
          <ExclamationTriangleIcon className="rec-banner-icon" aria-hidden="true" />
          <span>Server offline. Recording still works; uploads and transcripts resume when it's back.</span>
        </div>
      )}

      <details className="rec-settings">
        <summary>Settings · Mic: {micLabel} · {langLabel} · {modelLabel}</summary>
        <div className="rec-fields">
          <div className="field field-toggle">
            <input id="set-usemic" type="checkbox" role="switch" className="toggle" checked={useMic} disabled={recording} onChange={(e) => setUseMic(e.target.checked)} />
            <label htmlFor="set-usemic">Record my microphone</label>
          </div>
          <div className="field">
            <label htmlFor="set-mic">Microphone</label>
            <select id="set-mic" value={micId} disabled={recording || !useMic} onChange={(e) => setMicId(e.target.value)}>
              <option value="">Default</option>
              {mics.map((m, i) => <option key={m.deviceId} value={m.deviceId}>{m.label || `Mic ${i + 1}`}</option>)}
            </select>
          </div>
          <div className="field field-toggle">
            <input id="set-auto" type="checkbox" role="switch" className="toggle" checked={autoTranscribe} onChange={(e) => setAutoTranscribe(e.target.checked)} />
            <label htmlFor="set-auto">Transcribe automatically when I stop</label>
          </div>
          <div className="field">
            <label htmlFor="set-lang">Language</label>
            <select id="set-lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="set-model">Accuracy</label>
            <select id="set-model" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
        </div>
      </details>

      <section className="rec-history" aria-labelledby="rec-history-title">
        <div className="rec-history-head">
          <h2 id="rec-history-title">Recordings</h2>
          <span className="rec-count">{recordings.length}</span>
        </div>
        {folder && (
          <p className="rec-folder">
            <span>Saved in <code>{folder}</code></span>
            <button type="button" className="ghost-btn small" onClick={copyPath}>{copiedPath ? 'Copied ✓' : 'Copy path'}</button>
          </p>
        )}

        {!loaded ? (
          <div className="rec-empty">Loading recordings…</div>
        ) : loadFailed && recordings.length === 0 ? (
          <div className="rec-empty">
            <p>Couldn't load recordings.</p>
            <button type="button" className="ghost-btn" onClick={refresh}>Try again</button>
          </div>
        ) : recordings.length === 0 ? (
          <div className="rec-empty">No recordings yet. Press Start recording during a meeting — the transcript will appear here.</div>
        ) : (
          <ul className="rec-list">
            {recordings.map((r) => (
              <RecordingItem key={r.id} rec={r} progress={progress[r.id]} onTranscribe={transcribe} onError={(m) => say(m, true)} onNotice={(m) => say(m)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const langName = (code) => (LANGUAGES.find((l) => l.value === code)?.label) || null;

function RecordingItem({ rec, progress, onTranscribe, onError, onNotice }) {
  const [name, setName] = useState(rec.name);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const id = encodeURIComponent(rec.id);
  const t = rec.transcript;
  const running = t && ['queued', 'running'].includes(t.status);

  useEffect(() => setName(rec.name), [rec.name]);

  // Re-fetch the full transcript when it is expanded or changes (finishedAt moves on every new run).
  useEffect(() => {
    if (!open || !t || t.status !== 'done') return;
    let alive = true;
    fetch(`${API}/api/recordings/${id}/transcript`).then((r) => r.text()).then((s) => alive && setText(s)).catch(() => {});
    return () => { alive = false; };
  }, [open, id, t?.status, t?.finishedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  async function rename() {
    setEditing(false);
    const clean = name.trim();
    if (!clean || clean === rec.name) { setName(rec.name); return; }
    try {
      await api(`/api/recordings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: clean }) });
    } catch (e) { onError(`Rename failed: ${e.message}`); setName(rec.name); }
  }
  async function remove() {
    try {
      await api(`/api/recordings/${id}`, { method: 'DELETE' });
      onNotice('Moved to the _deleted folder.');
    } catch (e) { onError(`Delete failed: ${e.message}`); }
  }
  async function cancel() {
    try { await api(`/api/recordings/${id}/cancel`, { method: 'POST' }); } catch (e) { onError(`Cancel failed: ${e.message}`); }
  }
  async function copy() {
    try {
      let value = text;
      if (value == null) value = await (await fetch(`${API}/api/recordings/${id}/transcript`)).text();
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) { onError(`Copy failed: ${e.message}`); }
  }

  // MediaRecorder WebM has no duration header; make the browser scan it so seeking works.
  const fixDuration = (e) => {
    const a = e.currentTarget;
    if (a.duration === Infinity) {
      a.currentTime = 1e101;
      a.addEventListener('timeupdate', () => { a.currentTime = 0; }, { once: true });
    }
  };

  const pct = progress?.percent;
  let chip;
  if (running) chip = <span className="chip chip-run"><ArrowPathIcon className="chip-icon spin" aria-hidden="true" />{pct != null ? `Transcribing ${pct}%` : (progress?.message || 'Transcribing…')}</span>;
  else if (t?.status === 'done') chip = <span className="chip chip-done"><CheckCircleIcon className="chip-icon" aria-hidden="true" />Transcribed</span>;
  else if (t?.status === 'error') chip = <span className="chip chip-err"><ExclamationCircleIcon className="chip-icon" aria-hidden="true" />Failed</span>;
  else if (t?.status === 'interrupted') chip = <span className="chip chip-warn"><ExclamationTriangleIcon className="chip-icon" aria-hidden="true" />Interrupted</span>;
  else if (t?.status === 'cancelled') chip = <span className="chip chip-warn"><XMarkIcon className="chip-icon" aria-hidden="true" />Cancelled</span>;
  else chip = <span className="chip"><ClockIcon className="chip-icon" aria-hidden="true" />Not transcribed</span>;

  const retry = ['error', 'interrupted', 'cancelled'].includes(t?.status);
  const lang = langName(t?.language);
  const preview = open ? (text == null ? 'Loading…' : (text || '(no speech detected)')) : (t?.preview ? `${t.preview}${t.chars > t.preview.length ? '…' : ''}` : '');

  return (
    <li className="rec-item">
      <div className="rec-item-top">
        {editing ? (
          <input
            className="rec-name"
            value={name}
            dir="auto"
            autoFocus
            aria-label="Recording name"
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(rec.name); setEditing(false); } }}
          />
        ) : (
          <>
            <h3 className="rec-title" dir="auto">{rec.name}</h3>
            <button type="button" className="icon-btn" aria-label="Rename" title="Rename" onClick={() => setEditing(true)}><PencilSquareIcon aria-hidden="true" /></button>
          </>
        )}
      </div>
      <div className="rec-meta">{fmtDate(rec.created)} · {fmtDuration(rec.duration)}{lang ? ` · ${lang}` : ''}</div>
      <div className="rec-chip-row">
        {chip}
        {running && (
          <>
            <div className="rec-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct || 0} aria-label="Transcription progress"><b style={{ width: `${pct || 0}%` }} /></div>
            <button type="button" className="ghost-btn small" onClick={cancel}>Stop</button>
          </>
        )}
        {retry && <button type="button" className="ghost-btn small" onClick={() => onTranscribe(rec.id)}>Try again</button>}
        {!t && <button type="button" className="ghost-btn small" onClick={() => onTranscribe(rec.id)}>Transcribe</button>}
      </div>
      {t?.status === 'error' && t.error && <p className="rec-error">{t.error}</p>}
      <audio className="rec-audio" controls preload="none" src={`${API}/api/recordings/${id}/audio`} onLoadedMetadata={fixDuration} />
      {t?.status === 'done' && preview && (
        <>
          <p className={`rec-preview ${open ? 'open' : ''}`} dir="auto">{preview}</p>
          <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Show less' : 'Show full transcript'}</button>
        </>
      )}
      <div className="rec-actions">
        {t?.status === 'done' && (
          <>
            <button type="button" className="primary-btn" onClick={copy}>{copied ? 'Copied ✓' : 'Copy text'}</button>
            <a className="ghost-btn" href={`${API}/api/recordings/${id}/transcript?download=1`}><ArrowDownTrayIcon aria-hidden="true" />Download .txt</a>
          </>
        )}
        <a className="ghost-btn" href={`${API}/api/recordings/${id}/audio?download=1`}><ArrowDownTrayIcon aria-hidden="true" />Download audio</a>
        {t && !running && !retry && <button type="button" className="ghost-btn" onClick={() => onTranscribe(rec.id)}><ArrowPathIcon aria-hidden="true" />Transcribe again</button>}
        <button type="button" className="ghost-btn danger" onClick={remove} disabled={running}><TrashIcon aria-hidden="true" />Delete</button>
      </div>
    </li>
  );
}
