import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import './Recorder.css';
import './Recordings.css';

import { API } from './api';
import { fmtDate, fmtDuration, langName } from './useRecordings';

const NARROW = '(max-width: 719px)';
const isNarrow = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia(NARROW).matches;

function StatusChip({ rec, progress }) {
  const t = rec.transcript;
  const pct = progress?.percent;
  if (t && ['queued', 'running'].includes(t.status)) return <span className="chip chip-run"><ArrowPathIcon className="chip-icon spin" aria-hidden="true" />{pct != null ? `Transcribing ${pct}%` : (progress?.message || 'Transcribing…')}</span>;
  if (t?.status === 'done') return <span className="chip chip-done"><CheckCircleIcon className="chip-icon" aria-hidden="true" />Transcribed</span>;
  if (t?.status === 'error') return <span className="chip chip-err"><ExclamationCircleIcon className="chip-icon" aria-hidden="true" />Failed</span>;
  if (t?.status === 'interrupted') return <span className="chip chip-warn"><ExclamationTriangleIcon className="chip-icon" aria-hidden="true" />Interrupted</span>;
  if (t?.status === 'cancelled') return <span className="chip chip-warn"><XMarkIcon className="chip-icon" aria-hidden="true" />Cancelled</span>;
  return <span className="chip"><ClockIcon className="chip-icon" aria-hidden="true" />Not transcribed</span>;
}

// ---------------------------------------------------------------------------
// Recordings screen: searchable list on the left, selected recording on the right.
// On narrow screens only one pane shows at a time (`view` = 'list' | 'detail').
// ---------------------------------------------------------------------------
export default function Recordings({ data, selectedId, onSelect, view, onView, onGoRecord, live }) {
  const { recordings, folder, progress, serverDown, loaded, loadFailed, refresh } = data;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const prevList = useRef(recordings);
  const listRef = useRef(null);
  const detailRef = useRef(null);

  // Default to the most recent recording; when the selected one disappears
  // (deleted here or elsewhere), move to the one that took its place.
  useEffect(() => {
    if (!loaded) return;
    const prev = prevList.current;
    prevList.current = recordings;
    if (selectedId && recordings.some((r) => r.id === selectedId)) return;
    const idx = selectedId ? prev.findIndex((r) => r.id === selectedId) : -1;
    // An unknown id that was never listed may simply not be fetched yet: keep it.
    if (selectedId && idx < 0) return;
    const next = recordings.length ? recordings[Math.min(Math.max(idx, 0), recordings.length - 1)].id : null;
    if (next !== selectedId) onSelect(next);
  }, [recordings, loaded, selectedId, onSelect]);

  const q = query.trim().toLowerCase();
  const shown = q
    ? recordings.filter((r) => `${r.name} ${r.transcript?.preview || ''}`.toLowerCase().includes(q))
    : recordings;
  const selected = recordings.find((r) => r.id === selectedId) || null;

  const say = (text, error = false) => setStatus({ text, error });

  function select(id) {
    onSelect(id);
    onView('detail');
    // On narrow screens the list was just replaced by the detail pane: move focus there.
    if (isNarrow()) {
      setTimeout(() => {
        const el = detailRef.current && detailRef.current.querySelector('.rec-title');
        if (el) el.focus();
      }, 0);
    }
  }
  function backToList() {
    onView('list');
    // Return focus to the row the user came from.
    setTimeout(() => {
      const el = listRef.current && listRef.current.querySelector('[aria-current="true"]');
      if (el) el.focus();
    }, 0);
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(folder);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    } catch { /* clipboard unavailable */ }
  }

  const head = (
    <div className="rec-history-head">
      <h2 id="recs-title">Recordings</h2>
      <span className="rec-count">{recordings.length}</span>
    </div>
  );
  const banner = serverDown && (
    <div className="rec-banner">
      <ExclamationTriangleIcon className="rec-banner-icon" aria-hidden="true" />
      <span>Server offline. Recordings and transcripts will update when it's back.</span>
    </div>
  );
  const liveRow = live && (
    <button type="button" className="recs-row recs-row-live" onClick={onGoRecord}>
      <span className="recs-row-name">Current recording</span>
      <span className="recs-row-meta">{live === 'recording' ? 'In progress — open the Record tab to stop' : 'Saving to the server…'}</span>
      <span className={`chip ${live === 'recording' ? 'chip-err' : 'chip-run'}`}>
        {live === 'recording'
          ? <><span className="recs-live-dot" aria-hidden="true" />Recording</>
          : <><ArrowPathIcon className="chip-icon spin" aria-hidden="true" />Uploading…</>}
      </span>
    </button>
  );

  // Nothing to list yet: one full-width state instead of the two panes.
  if (!loaded || recordings.length === 0) {
    return (
      <section className="recs-solo" aria-labelledby="recs-title">
        {head}
        {banner}
        {liveRow}
        {!loaded ? (
          <div className="rec-empty">Loading recordings…</div>
        ) : loadFailed ? (
          <div className="rec-empty">
            <p>Couldn't load recordings.</p>
            <button type="button" className="ghost-btn" onClick={refresh}>Try again</button>
          </div>
        ) : (
          <div className="rec-empty">
            <p>No recordings yet — record one in the Record tab.</p>
            <button type="button" className="ghost-btn" onClick={onGoRecord}>Go to Record</button>
          </div>
        )}
      </section>
    );
  }

  return (
    <div className={`recs ${view === 'detail' ? 'show-detail' : 'show-list'}`}>
      <section className="recs-list-pane" aria-labelledby="recs-title">
        {head}
        {folder && (
          <p className="rec-folder">
            <span>Saved in <code>{folder}</code></span>
            <button type="button" className="ghost-btn small" onClick={copyPath}>{copiedPath ? 'Copied ✓' : 'Copy path'}</button>
          </p>
        )}
        {banner}
        <div className="recs-search">
          <MagnifyingGlassIcon className="recs-search-icon" aria-hidden="true" />
          <input
            type="search"
            dir="auto"
            value={query}
            placeholder="Search recordings"
            aria-label="Search recordings"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {liveRow}
        {shown.length === 0 ? (
          <div className="rec-empty">
            <p>No recordings match “{query.trim()}”.</p>
            <button type="button" className="ghost-btn small" onClick={() => setQuery('')}>Clear search</button>
          </div>
        ) : (
          <ul className="recs-list" ref={listRef} aria-label="Recordings">
            {shown.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="recs-row"
                  aria-current={r.id === selectedId ? 'true' : undefined}
                  onClick={() => select(r.id)}
                >
                  <span className="recs-row-name" dir="auto">{r.name}</span>
                  <span className="recs-row-meta">{fmtDate(r.created)} · {fmtDuration(r.duration)}</span>
                  <StatusChip rec={r} progress={progress[r.id]} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="recs-detail" aria-label="Recording details" ref={detailRef}>
        <button type="button" className="link-btn recs-back" onClick={backToList}>
          <ArrowLeftIcon aria-hidden="true" />Back to list
        </button>
        {status && (
          <div className={`rec-status recs-status ${status.error ? 'err' : ''}`} role="status" aria-live="polite">
            {status.error && <ExclamationCircleIcon className="rec-status-icon" aria-hidden="true" />}
            <span>{status.text}</span>
          </div>
        )}
        {selected ? (
          <RecordingDetail
            key={selected.id}
            rec={selected}
            progress={progress[selected.id]}
            actions={data}
            onError={(m) => say(m, true)}
            onNotice={(m) => say(m)}
          />
        ) : (
          <div className="rec-empty">Select a recording</div>
        )}
      </section>
    </div>
  );
}

// The former Recorder history item, shown as a full detail pane.
function RecordingDetail({ rec, progress, actions, onError, onNotice }) {
  const { transcribe, rename: renameRecording, remove: removeRecording, cancel: cancelTranscription, fetchTranscript, refresh } = actions;
  const [name, setName] = useState(rec.name);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(null);
  const [copied, setCopied] = useState(false);
  const id = encodeURIComponent(rec.id);
  const t = rec.transcript;
  const running = t && ['queued', 'running'].includes(t.status);

  useEffect(() => setName(rec.name), [rec.name]);

  // Re-fetch the full transcript when it changes (finishedAt moves on every new run).
  useEffect(() => {
    if (!t || t.status !== 'done') return;
    let alive = true;
    fetchTranscript(rec.id).then((s) => alive && setText(s)).catch(() => {});
    return () => { alive = false; };
  }, [rec.id, t?.status, t?.finishedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  async function rename() {
    setEditing(false);
    const clean = name.trim();
    if (!clean || clean === rec.name) { setName(rec.name); return; }
    try {
      await renameRecording(rec.id, clean);
    } catch (e) { onError(`Rename failed: ${e.message}`); setName(rec.name); }
  }
  async function remove() {
    try {
      await removeRecording(rec.id);
      onNotice('Moved to the _deleted folder.');
      refresh();
    } catch (e) { onError(`Delete failed: ${e.message}`); }
  }
  async function cancel() {
    try { await cancelTranscription(rec.id); } catch (e) { onError(`Cancel failed: ${e.message}`); }
  }
  async function retranscribe() {
    try { await transcribe(rec.id); } catch (e) { onError(`Could not start transcription: ${e.message}`); }
  }
  async function copy() {
    try {
      let value = text;
      if (value == null) value = await fetchTranscript(rec.id);
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
  const retry = ['error', 'interrupted', 'cancelled'].includes(t?.status);
  const lang = langName(t?.language);

  return (
    <article className="rec-item recs-item">
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
            <h3 className="rec-title" dir="auto" tabIndex={-1}>{rec.name}</h3>
            <button type="button" className="icon-btn" aria-label="Rename" title="Rename" onClick={() => setEditing(true)}><PencilSquareIcon aria-hidden="true" /></button>
          </>
        )}
      </div>
      <div className="rec-meta">{fmtDate(rec.created)} · {fmtDuration(rec.duration)}{lang ? ` · ${lang}` : ''}</div>
      <div className="rec-chip-row">
        <StatusChip rec={rec} progress={progress} />
        {running && (
          <>
            <div className="rec-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct || 0} aria-label="Transcription progress"><b style={{ width: `${pct || 0}%` }} /></div>
            <button type="button" className="ghost-btn small" onClick={cancel}>Stop</button>
          </>
        )}
        {retry && <button type="button" className="ghost-btn small" onClick={retranscribe}>Try again</button>}
        {!t && <button type="button" className="ghost-btn small" onClick={retranscribe}>Transcribe</button>}
      </div>
      {t?.status === 'error' && t.error && <p className="rec-error">{t.error}</p>}
      <audio className="rec-audio" controls preload="none" src={`${API}/api/recordings/${id}/audio`} onLoadedMetadata={fixDuration} />
      <div className="rec-actions">
        {t?.status === 'done' && (
          <>
            <button type="button" className="primary-btn" onClick={copy}>{copied ? 'Copied ✓' : 'Copy text'}</button>
            <a className="ghost-btn" href={`${API}/api/recordings/${id}/transcript?download=1`}><ArrowDownTrayIcon aria-hidden="true" />Download .txt</a>
          </>
        )}
        <a className="ghost-btn" href={`${API}/api/recordings/${id}/audio?download=1`}><ArrowDownTrayIcon aria-hidden="true" />Download audio</a>
        {t && !running && !retry && <button type="button" className="ghost-btn" onClick={retranscribe}><ArrowPathIcon aria-hidden="true" />Transcribe again</button>}
        <button type="button" className="ghost-btn danger" onClick={remove} disabled={running}><TrashIcon aria-hidden="true" />Delete</button>
      </div>
      <h4 className="recs-transcript-title">Transcript</h4>
      {t?.status === 'done' ? (
        <div className="recs-transcript" dir="auto">{text == null ? 'Loading…' : (text || '(no speech detected)')}</div>
      ) : (
        <p className="recs-transcript-empty">
          {running ? 'Transcribing — the text will appear here when it is done.' : 'No transcript yet.'}
        </p>
      )}
    </article>
  );
}
