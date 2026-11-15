import { useCallback, useEffect, useState } from 'react';
import io from 'socket.io-client';

import { API } from './api';

// ---------------------------------------------------------------------------
// Shared helpers (used by Recorder and Recordings)
// ---------------------------------------------------------------------------
export const LANGUAGES = [
  { value: 'he', label: 'Hebrew' },
  { value: 'en', label: 'English' },
  { value: 'auto', label: 'Auto-detect' },
];
export const langName = (code) => (LANGUAGES.find((l) => l.value === code)?.label) || null;

const pad = (n) => String(n).padStart(2, '0');
export function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  return `${h ? h + ':' : ''}${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
}
export const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export async function api(path, opts = {}) {
  const res = await fetch(API + path, opts);
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((isJson && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

const recPath = (id) => `/api/recordings/${encodeURIComponent(id)}`;
const orNull = (e) => { if (e.status === 404) return null; throw e; };
const putJson = (path, body) => api(path, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// The one socket.io connection for the app, plus the recordings list,
// live transcription progress and the server-side recording actions.
// ---------------------------------------------------------------------------
export default function useRecordings() {
  const [socket, setSocket] = useState(null);
  const [recordings, setRecordings] = useState([]);
  const [folder, setFolder] = useState('');
  const [progress, setProgress] = useState({});
  const [serverDown, setServerDown] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

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

  // initial load + live updates
  useEffect(() => {
    refresh();
    const s = io(API);
    let timer;
    s.on('connect', () => { setServerDown(false); refresh(); });
    s.on('disconnect', () => setServerDown(true));
    s.on('recording-updated', () => { clearTimeout(timer); timer = setTimeout(refresh, 150); });
    s.on('recording-progress', (p) => setProgress((prev) => ({ ...prev, [p.id]: p })));
    setSocket(s);
    return () => { clearTimeout(timer); s.disconnect(); };
  }, [refresh]);

  // Actions throw on failure; callers decide how to report the error.
  // Without explicit settings, transcription uses the Record tab's saved model/language.
  const transcribe = useCallback((id, opts = {}) => api(`${recPath(id)}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || load('rec.model', 'base'),
      language: opts.language || load('rec.language', 'he'),
    }),
  }), []);
  const rename = useCallback((id, name) => api(recPath(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }), []);
  const remove = useCallback((id) => api(recPath(id), { method: 'DELETE' }), []);
  const cancel = useCallback((id) => api(`${recPath(id)}/cancel`, { method: 'POST' }), []);
  const fetchTranscript = useCallback(async (id) => {
    const res = await fetch(`${API}${recPath(id)}/transcript`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }, []);

  // Segments, transcript edits and AI notes (404 = none yet → null).
  const getSegments = useCallback((id) => api(`${recPath(id)}/segments`).catch(orNull), []);
  const saveTranscript = useCallback((id, { text, segments }) => putJson(`${recPath(id)}/transcript`,
    segments ? { text, segments } : { text }), []);
  const getSummary = useCallback((id) => api(`${recPath(id)}/summary`).catch(orNull), []);
  const saveSummary = useCallback((id, summary, markdown) => putJson(`${recPath(id)}/summary`, { summary, markdown }), []);
  const deleteSummary = useCallback((id) => api(`${recPath(id)}/summary`, { method: 'DELETE' }), []);

  return {
    socket, recordings, folder, progress, serverDown, loaded, loadFailed,
    refresh, transcribe, rename, remove, cancel, fetchTranscript,
    getSegments, saveTranscript, getSummary, saveSummary, deleteSummary,
  };
}
