import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import './Recorder.css';

import { API } from './api';
import { useI18n } from './i18n';
import { LANGUAGES, api, fmtDateForName, fmtDuration } from './useRecordings';

// Labels are the locale keys `model.<value>`.
const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3'];

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
const pickMime = () =>
  ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
const sessionLock = (id) => `meeting-recorder-session-${id}`;

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------
export default function Recorder({ active = true, serverDown, refresh, transcribe: startTranscription, onOpenRecording, onLiveChange }) {
  const { t, rich } = useI18n();
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState({ key: 'rec.status.ready', vars: null, error: false });
  const [useMic, setUseMic] = useState(load('rec.useMic', '1') === '1');
  const [micId, setMicId] = useState(load('rec.micId', ''));
  const [mics, setMics] = useState([]);
  const [model, setModel] = useState(load('rec.model', 'base'));
  const [language, setLanguage] = useState(load('rec.language', 'he'));
  const [autoTranscribe, setAutoTranscribe] = useState(load('rec.auto', '1') === '1');
  const [source, setSource] = useState(load('rec.source', 'desktop'));
  const [savedId, setSavedId] = useState(null);

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

  // Statuses are kept as locale keys so they follow a language switch.
  const say = (key, error = false, vars = null) => setStatus({ key, vars, error });

  const transcribe = useCallback(async (id) => {
    const { model: m, language: l } = settingsRef.current;
    try {
      await startTranscription(id, { model: m, language: l });
    } catch (e) {
      say('rec.status.transcribeFailed', true, { error: e.message });
    }
  }, [startTranscription]);

  // Upload every finished or orphaned session in the crash buffer.
  // A Web Lock keeps two windows from uploading the same session twice, and
  // sessions still being recorded (they hold their own lock) are skipped.
  // Resolves to the uploads as [{ session, id }] (crash-buffer id -> server id).
  const flushPending = useCallback(async () => {
    const run = async () => {
      const held = navigator.locks ? (await navigator.locks.query()).held.map((l) => l.name) : [];
      const sessions = new Map((await allSessions()).map((s) => [s.id, s]));
      for (const [id] of await allPartKeys()) if (!sessions.has(id)) sessions.set(id, { id });
      const uploaded = [];
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
        form.append('name', `${recovered ? 'Recovered' : 'Meeting'} ${fmtDateForName(s.id)}`);
        const meta = await api('/api/recordings', { method: 'POST', body: form });
        await dropSession(s.id);
        uploaded.push({ session: s.id, id: meta.id });
        if (settingsRef.current.autoTranscribe) await transcribe(meta.id);
      }
      return uploaded;
    };
    return navigator.locks ? navigator.locks.request('meeting-recorder-flush', run) : run();
  }, [transcribe]);

  // Upload anything left in the crash buffer from last time.
  // (The recordings list and live updates come from useRecordings.)
  useEffect(() => {
    flushPending()
      .then(({ length: n }) => { if (n) { say('rec.status.uploadedPending', false, { count: n }); refresh(); } })
      .catch(() => say('rec.status.serverOffline', true));
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
    setSavedId(null);
    say('rec.status.choose');
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
      });
    } catch {
      say('rec.status.cancelled');
      return;
    }
    const sysTrack = display.getAudioTracks()[0];
    if (!sysTrack) {
      display.getTracks().forEach((t) => t.stop());
      say('rec.status.noAudio', true);
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
        say('rec.status.micUnavailable', true);
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
    say('rec.status.recording');
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
    say('rec.status.saving');
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
      const uploaded = await flushPending();
      await refresh();
      setSavedId(uploaded.find((u) => u.session === rec.id)?.id ?? null);
      say(settingsRef.current.autoTranscribe ? 'rec.status.savedTranscribing' : 'rec.status.saved', false, { duration: fmtDuration(duration) });
    } catch (e) {
      say('rec.status.uploadFailed', true, { error: e.message });
    }
  }

  useEffect(() => {
    const warn = (e) => { if (recRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    const key = (e) => {
      if (active && e.code === 'Space' && !e.target.closest('input, select, textarea, button, a, audio')) {
        e.preventDefault();
        recRef.current ? stop() : start();
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('keydown', key); };
  });

  const saving = status.key === 'rec.status.saving';
  const micLabel = !useMic ? t('rec.settings.micOff') : (mics.find((m) => m.deviceId === micId)?.label || t('rec.settings.micDefault'));
  const modelLabel = MODELS.includes(model) ? t(`model.${model}`) : model;
  const langLabel = LANGUAGES.find((l) => l.value === language)?.label || language;
  const btnState = saving ? 'saving' : recording ? 'on' : 'idle';
  const btnLabel = t(saving ? 'rec.btn.saving' : recording ? 'rec.btn.stop' : 'rec.btn.start');
  const idle = status.key === 'rec.status.ready';

  const live = saving ? 'uploading' : recording ? 'recording' : null;
  useEffect(() => { if (onLiveChange) onLiveChange(live); }, [live, onLiveChange]);

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
        <div className="rec-seg" role="radiogroup" aria-label={t('rec.source.label')}>
          {[
            { v: 'desktop', main: 'rec.source.desktop', sub: 'rec.source.desktopSub' },
            { v: 'tab', main: 'rec.source.tab', sub: 'rec.source.tabSub' },
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
              <span className="seg-main">{t(o.main)}</span>
              <span className="seg-sub">{t(o.sub)}</span>
            </button>
          ))}
        </div>

        <div className="rec-main">
          <div className="rec-btn-wrap">
            <button
              type="button"
              className={`rec-button ${btnState}`}
              onClick={() => (recording ? stop() : start())}
              disabled={btnState === 'saving'}
              aria-labelledby="rec-button-label"
              title={t('rec.btn.title')}
            >
              {btnState === 'saving' ? <span className="spinner" aria-hidden="true" /> : recording ? <StopIcon aria-hidden="true" /> : <span className="rec-dot" aria-hidden="true" />}
            </button>
          </div>
          <span className="rec-button-label" id="rec-button-label">{btnLabel}</span>
          {recording && <div className="rec-timer" aria-hidden="true" dir="ltr">{fmtDuration(elapsed)}</div>}
        </div>

        {!recording && (
          <p className="rec-hint">{rich(source === 'desktop' ? 'rec.hint.desktop' : 'rec.hint.tab')}</p>
        )}

        {recording && (
          <div className="rec-meters">
            <div className="rec-meter"><span>{t('rec.meter.system')}</span><div className="rec-bar"><b ref={sysBar} /></div></div>
            <div className="rec-meter"><span>{t('rec.meter.mic')}</span><div className="rec-bar"><b ref={micBar} /></div></div>
          </div>
        )}

        {/* The idle "Ready" status is not shown (the header pill already shows the server state). */}
        <div className={`rec-status ${status.error ? 'err' : ''}`} role="status" aria-live="polite">
          {!idle && status.error && <ExclamationCircleIcon className="rec-status-icon" aria-hidden="true" />}
          {!idle && <span>{t(status.key, status.vars)}</span>}
        </div>
        {savedId && !status.error && onOpenRecording && (
          <button type="button" className="ghost-btn small" onClick={() => onOpenRecording(savedId)}>{t('rec.viewInRecordings')}</button>
        )}
      </div>

      {serverDown && (
        <div className="rec-banner">
          <ExclamationTriangleIcon className="rec-banner-icon" aria-hidden="true" />
          <span>{t('rec.serverDown')}</span>
        </div>
      )}

      <details className="rec-settings">
        {/* One span: summary is a flex box, and bare text pieces would lose their edge spaces. */}
        <summary><span>{rich('rec.settings.summary', { mic: <bdi>{micLabel}</bdi>, lang: langLabel, model: <bdi>{modelLabel}</bdi> })}</span></summary>
        <div className="rec-fields">
          <div className="field field-toggle">
            <input id="set-usemic" type="checkbox" role="switch" className="toggle" checked={useMic} disabled={recording} onChange={(e) => setUseMic(e.target.checked)} />
            <label htmlFor="set-usemic">{t('rec.settings.useMic')}</label>
          </div>
          <div className="field">
            <label htmlFor="set-mic">{t('rec.settings.mic')}</label>
            <select id="set-mic" value={micId} disabled={recording || !useMic} onChange={(e) => setMicId(e.target.value)}>
              <option value="">{t('rec.settings.micDefault')}</option>
              {mics.map((m, i) => <option key={m.deviceId} value={m.deviceId}>{m.label || t('rec.settings.micN', { n: i + 1 })}</option>)}
            </select>
          </div>
          <div className="field field-toggle">
            <input id="set-auto" type="checkbox" role="switch" className="toggle" checked={autoTranscribe} onChange={(e) => setAutoTranscribe(e.target.checked)} />
            <label htmlFor="set-auto">{t('rec.settings.auto')}</label>
          </div>
          <div className="field">
            <label htmlFor="set-lang">{t('rec.settings.language')}</label>
            <select id="set-lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="set-model">{t('rec.settings.accuracy')}</label>
            <select id="set-model" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m} value={m}>{t(`model.${m}`)}</option>)}
            </select>
          </div>
        </div>
      </details>
    </div>
  );
}
