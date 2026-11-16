import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import './RecordingAi.css';

import { API } from './api';
import { buildMarkdown, normLang, sha256 } from './ai/builtin';
import { isDefaultName, resolveLang, transcriptFor, useAiStatus } from './aiNotes';
import { useI18n, t as tNow } from './i18n';
import RecordingAsk from './RecordingAsk';
import RecordingNotes from './RecordingNotes';
import RecordingTranscript from './RecordingTranscript';
import { fmtDate, fmtDuration, fmtShortDate, langName } from './useRecordings';

const NARROW = '(max-width: 719px)';
const isNarrow = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia(NARROW).matches;

function StatusChip({ rec, progress }) {
  const { t: tr } = useI18n();
  const t = rec.transcript;
  const pct = progress?.percent;
  if (t && ['queued', 'running'].includes(t.status)) return <span className="chip chip-run"><ArrowPathIcon className="chip-icon spin" aria-hidden="true" />{pct != null ? tr('recs.chip.transcribingPct', { percent: pct }) : (progress?.message || tr('recs.chip.transcribing'))}</span>;
  if (t?.status === 'done') return <span className="chip chip-done"><CheckCircleIcon className="chip-icon" aria-hidden="true" />{tr('recs.chip.done')}</span>;
  if (t?.status === 'error') return <span className="chip chip-err"><ExclamationCircleIcon className="chip-icon" aria-hidden="true" />{tr('recs.chip.failed')}</span>;
  if (t?.status === 'interrupted') return <span className="chip chip-warn"><ExclamationTriangleIcon className="chip-icon" aria-hidden="true" />{tr('recs.chip.interrupted')}</span>;
  if (t?.status === 'cancelled') return <span className="chip chip-warn"><XMarkIcon className="chip-icon" aria-hidden="true" />{tr('recs.chip.cancelled')}</span>;
  return <span className="chip"><ClockIcon className="chip-icon" aria-hidden="true" />{tr('recs.chip.none')}</span>;
}

// ---------------------------------------------------------------------------
// Recordings screen: searchable list on the left, selected recording on the right.
// On narrow screens only one pane shows at a time (`view` = 'list' | 'detail').
// ---------------------------------------------------------------------------
export default function Recordings({ data, selectedId, onSelect, view, onView, onGoRecord, live, auto }) {
  const { t, rich } = useI18n();
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
    ? recordings.filter((r) => `${r.name} ${r.transcript?.preview || ''} ${r.summary?.title || ''} ${r.summary?.tldr || ''}`.toLowerCase().includes(q))
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
      <h2 id="recs-title">{t('recs.title')}</h2>
      <span className="rec-count">{recordings.length}</span>
    </div>
  );
  const banner = serverDown && (
    <div className="rec-banner">
      <ExclamationTriangleIcon className="rec-banner-icon" aria-hidden="true" />
      <span>{t('recs.serverDown')}</span>
    </div>
  );
  const liveRow = live && (
    <button type="button" className="recs-row recs-row-live" onClick={onGoRecord}>
      <span className="recs-row-name">{t('recs.live.name')}</span>
      <span className="recs-row-line">
        <span className="recs-row-meta">{live === 'recording' ? t('recs.live.recordingMeta') : t('recs.live.savingMeta')}</span>
        <span className={`chip ${live === 'recording' ? 'chip-err' : 'chip-run'}`}>
          {live === 'recording'
            ? <><span className="recs-live-dot" aria-hidden="true" />{t('recs.live.recording')}</>
            : <><ArrowPathIcon className="chip-icon spin" aria-hidden="true" />{t('recs.live.uploading')}</>}
        </span>
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
          <div className="rec-empty">{t('recs.loading')}</div>
        ) : loadFailed ? (
          <div className="rec-empty">
            <p>{t('recs.loadFailed')}</p>
            <button type="button" className="ghost-btn" onClick={refresh}>{t('common.tryAgain')}</button>
          </div>
        ) : (
          <div className="rec-empty">
            <p>{t('recs.empty')}</p>
            <button type="button" className="ghost-btn" onClick={onGoRecord}>{t('recs.startRecording')}</button>
          </div>
        )}
      </section>
    );
  }

  return (
    <div className={`recs ${view === 'detail' ? 'show-detail' : 'show-list'}`}>
      <section className="recs-list-pane" aria-labelledby="recs-title">
        {head}
        {banner}
        <div className="recs-search">
          <MagnifyingGlassIcon className="recs-search-icon" aria-hidden="true" />
          <input
            type="search"
            dir="auto"
            value={query}
            placeholder={t('recs.search')}
            aria-label={t('recs.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {liveRow}
        {shown.length === 0 ? (
          <div className="rec-empty">
            <p>{rich('recs.noMatch', { query: <bdi>{query.trim()}</bdi> })}</p>
            <button type="button" className="ghost-btn small" onClick={() => setQuery('')}>{t('recs.clearSearch')}</button>
          </div>
        ) : (
          <ul className="recs-list" ref={listRef} aria-label={t('recs.listLabel')}>
            {shown.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="recs-row"
                  aria-current={r.id === selectedId ? 'true' : undefined}
                  onClick={() => select(r.id)}
                >
                  <span className="recs-row-name" dir="auto">{r.name}</span>
                  <span className="recs-row-line">
                    <span className="recs-row-meta"><bdi>{fmtShortDate(r.created)}</bdi> · <bdi>{fmtDuration(r.duration)}</bdi></span>
                    <StatusChip rec={r} progress={progress[r.id]} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {folder && (
          <p className="rec-folder">
            <span className="rec-folder-path" title={folder}>{rich('recs.savedIn', { path: <code dir="ltr">{folder}</code> })}</span>
            <button type="button" className="ghost-btn small" onClick={copyPath}>{copiedPath ? t('common.copied') : t('recs.copyPath')}</button>
          </p>
        )}
      </section>

      <section className="recs-detail" aria-label={t('recs.detailsLabel')} ref={detailRef}>
        <button type="button" className="link-btn recs-back" onClick={backToList}>
          <ArrowLeftIcon className="flip-rtl" aria-hidden="true" />{t('recs.back')}
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
            auto={auto}
            onError={(m) => say(m, true)}
            onNotice={(m) => say(m)}
          />
        ) : (
          <div className="rec-empty">{t('recs.selectOne')}</div>
        )}
      </section>
    </div>
  );
}

const SUBTABS = [
  { id: 'notes', labelKey: 'detail.tab.notes' },
  { id: 'transcript', labelKey: 'detail.tab.transcript' },
  { id: 'ask', labelKey: 'detail.tab.ask' },
];
let lastSubtab = 'notes';
const EMPTY_PENDING = { qa: [], translations: {}, translationsHash: null };

// The former Recorder history item, shown as a full detail pane.
function RecordingDetail({ rec, progress, actions, auto, onError, onNotice }) {
  const {
    transcribe, rename: renameRecording, remove: removeRecording, cancel: cancelTranscription, fetchTranscript, refresh,
    getSegments, getSummary, saveSummary, saveTranscript,
  } = actions;
  const { t: tr, dir } = useI18n();
  const [name, setName] = useState(rec.name);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(null);
  const [segments, setSegments] = useState(undefined); // undefined = loading, null = none
  const [summary, setSummary] = useState(undefined); // undefined = loading, null = none
  const summaryRef = useRef(null);
  // Q&A / translations kept in memory while the recording has no summary file yet;
  // they are merged into the summary when notes are generated.
  const [pending, setPending] = useState(EMPTY_PENDING);
  const pendingRef = useRef(EMPTY_PENDING);
  const recRef = useRef(rec);
  recRef.current = rec;
  // Summary saves run one after another, so an older PUT never lands after a newer one.
  const saveChain = useRef(Promise.resolve());
  const [hash, setHash] = useState(null);
  const [detected, setDetected] = useState(null);
  const [sub, setSub] = useState(lastSubtab);
  const [copied, setCopied] = useState(false);
  const audioRef = useRef(null);
  const pendingSeek = useRef(null);
  const id = encodeURIComponent(rec.id);
  const t = rec.transcript;
  const running = t && ['queued', 'running'].includes(t.status);
  const declared = normLang(t?.language);
  const lang = detected || (declared && declared !== 'auto' ? declared : null);
  const ai = useAiStatus(lang || 'en');

  useEffect(() => setName(rec.name), [rec.name]);

  // Re-fetch the full transcript and its segments when it changes
  // (finishedAt moves on every new run; edited flips after a save elsewhere).
  useEffect(() => {
    if (!t || t.status !== 'done') return;
    let alive = true;
    fetchTranscript(rec.id).then((s) => alive && setText(s)).catch(() => {});
    getSegments(rec.id).then((s) => alive && setSegments(Array.isArray(s) ? s : null)).catch((e) => {
      console.error('[ai] loading segments failed', e);
      if (alive) setSegments(null);
    });
    return () => { alive = false; };
  }, [rec.id, t?.status, t?.finishedAt, t?.edited]); // eslint-disable-line react-hooks/exhaustive-deps

  // Summary file: on open and whenever the list reports a newer one.
  useEffect(() => {
    let alive = true;
    getSummary(rec.id).then((s) => {
      if (!alive) return;
      const value = s && typeof s === 'object' ? s : null;
      summaryRef.current = value;
      setSummary(value);
    }).catch((e) => {
      console.error('[ai] loading the summary failed', e);
      if (alive && summaryRef.current === null) setSummary(null);
    });
    return () => { alive = false; };
  }, [rec.id, rec.summary?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hash (stale-notes check) and language of the current transcript.
  useEffect(() => {
    if (text == null) return undefined;
    let alive = true;
    sha256(text).then((h) => alive && setHash(h)).catch((e) => console.error('[ai] sha256 failed', e));
    resolveLang(t?.language, text).then((l) => alive && setDetected(l)).catch(() => {});
    return () => { alive = false; };
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSerial = useCallback((rid, value, markdown) => {
    const p = saveChain.current.catch(() => {}).then(() => saveSummary(rid, value, markdown));
    saveChain.current = p;
    return p;
  }, [saveSummary]);

  // Apply a change to the summary (or the in-memory store when there is none) and save it.
  const updateStore = useCallback(async (fn) => {
    const cur = summaryRef.current;
    if (!cur) {
      const nextPending = fn(pendingRef.current);
      pendingRef.current = nextPending;
      setPending(nextPending);
      return;
    }
    const next = fn(cur);
    summaryRef.current = next;
    setSummary(next);
    try {
      await saveSerial(rec.id, next, buildMarkdown(rec, next, transcriptFor(segments, text)));
    } catch (e) {
      console.error('[ai] saving the summary failed', e);
      onError(tNow('detail.saveNotesFailed', { error: e.message }));
    }
  }, [rec, segments, text, saveSerial, onError]);

  // Notes generation reads the store when the model is done, not when it started.
  const getStore = useCallback(() => ({ existing: summaryRef.current, pending: pendingRef.current }), []);
  // Auto-title only while the recording still has its default name (the user may rename it
  // while notes are being written).
  const autoRename = useCallback((rid, newName) => (
    isDefaultName(recRef.current.name) ? renameRecording(rid, newName) : null
  ), [renameRecording]);

  function onGenerated(merged) {
    summaryRef.current = merged;
    setSummary(merged);
    pendingRef.current = EMPTY_PENDING;
    setPending(EMPTY_PENDING);
  }
  const onTranslation = (target, out, h) => updateStore((s) => ({
    ...s,
    translations: { ...(s.translationsHash === h ? s.translations : {}), [target]: out },
    translationsHash: h,
  }));
  // Notes translations belong to one generated summary (createdAt); a regenerated one drops them.
  const onNotesTranslation = (target, out, forAt) => updateStore((s) => (!s || s.createdAt !== forAt ? s : {
    ...s,
    notesTranslations: { ...(s.notesTranslationsFor === forAt ? s.notesTranslations : {}), [target]: out },
    notesTranslationsFor: forAt,
  }));
  const onAnswer = (item) => updateStore((s) => ({ ...s, qa: [...(s.qa || []), item] }));
  function onTranscriptSaved(body) {
    setText(body.text);
    if (body.segments) setSegments(body.segments);
    onNotice(tNow('detail.transcriptSaved'));
  }

  async function rename() {
    setEditing(false);
    const clean = name.trim();
    if (!clean || clean === rec.name) { setName(rec.name); return; }
    try {
      await renameRecording(rec.id, clean);
    } catch (e) { onError(tNow('detail.renameFailed', { error: e.message })); setName(rec.name); }
  }
  async function remove() {
    try {
      await removeRecording(rec.id);
      onNotice(tNow('detail.deleted'));
      refresh();
    } catch (e) { onError(tNow('detail.deleteFailed', { error: e.message })); }
  }
  async function cancel() {
    try { await cancelTranscription(rec.id); } catch (e) { onError(tNow('detail.cancelFailed', { error: e.message })); }
  }
  async function retranscribe() {
    try { await transcribe(rec.id); } catch (e) { onError(tNow('detail.transcribeFailed', { error: e.message })); }
  }
  async function copy() {
    try {
      let value = text;
      if (value == null) value = await fetchTranscript(rec.id);
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) { onError(tNow('common.copyFailed', { error: e.message })); }
  }

  // MediaRecorder WebM has no duration header; make the browser scan it so seeking works.
  // A seek requested before that finished is applied once the scan is done.
  const fixDuration = (e) => {
    const a = e.currentTarget;
    if (a.duration === Infinity) {
      a.currentTime = 1e101;
      a.addEventListener('timeupdate', () => {
        const target = pendingSeek.current;
        pendingSeek.current = null;
        a.currentTime = target ?? 0;
        if (target != null) a.play().catch(() => {});
      }, { once: true });
    } else if (pendingSeek.current != null) {
      a.currentTime = pendingSeek.current;
      pendingSeek.current = null;
    }
  };
  const seek = useCallback((sec) => {
    const a = audioRef.current;
    if (!a) return;
    if (a.readyState < 1 || a.duration === Infinity) {
      pendingSeek.current = sec;
      if (a.readyState < 1) a.load();
      a.play().catch(() => {});
      return;
    }
    a.currentTime = sec;
    a.play().catch(() => {});
  }, []);

  function selectSub(next) {
    lastSubtab = next;
    setSub(next);
  }
  const onSubKey = (e) => {
    const i = SUBTABS.findIndex((s) => s.id === sub);
    // Arrows follow the visual order, which is mirrored in RTL.
    const fwd = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    let n;
    if (e.key === fwd) n = (i + 1) % SUBTABS.length;
    else if (e.key === back) n = (i - 1 + SUBTABS.length) % SUBTABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = SUBTABS.length - 1;
    else return;
    e.preventDefault();
    const next = SUBTABS[n].id;
    selectSub(next);
    const el = document.getElementById(`rsub-${next}`);
    if (el) el.focus();
  };

  const pct = progress?.percent;
  const retry = ['error', 'interrupted', 'cancelled'].includes(t?.status);
  const langLabel = langName(t?.language);
  const store = summary || pending;
  const thread = (store && Array.isArray(store.qa)) ? store.qa : [];

  return (
    <article className="rec-item recs-item">
      <div className="rec-item-top">
        {editing ? (
          <input
            className="rec-name"
            value={name}
            dir="auto"
            autoFocus
            aria-label={tr('detail.nameAria')}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(rec.name); setEditing(false); } }}
          />
        ) : (
          <>
            <h3 className="rec-title" dir="auto" tabIndex={-1}>{rec.name}</h3>
            <button type="button" className="icon-btn" aria-label={tr('detail.rename')} title={tr('detail.rename')} onClick={() => setEditing(true)}><PencilSquareIcon aria-hidden="true" /></button>
          </>
        )}
      </div>
      <div className="rec-meta-row">
        <span className="rec-meta"><bdi>{fmtDate(rec.created)}</bdi>{' · '}<bdi>{fmtDuration(rec.duration)}</bdi>{langLabel ? ` · ${langLabel}` : ''}</span>
        <StatusChip rec={rec} progress={progress} />
        {running && (
          <>
            <div className="rec-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct || 0} aria-label={tr('detail.progressAria')}><b style={{ width: `${pct || 0}%` }} /></div>
            <button type="button" className="ghost-btn small" onClick={cancel}>{tr('common.stop')}</button>
          </>
        )}
        {retry && <button type="button" className="ghost-btn small" onClick={retranscribe}>{tr('common.tryAgain')}</button>}
        {!t && <button type="button" className="ghost-btn small" onClick={retranscribe}>{tr('detail.transcribe')}</button>}
      </div>
      {t?.status === 'error' && t.error && <p className="rec-error">{t.error}</p>}
      <audio ref={audioRef} className="rec-audio" controls preload="none" src={`${API}/api/recordings/${id}/audio`} onLoadedMetadata={fixDuration} />
      <div className="rec-actions">
        {t?.status === 'done' && (
          <>
            <button type="button" className="primary-btn" onClick={copy}>{copied ? tr('common.copied') : tr('common.copyText')}</button>
            <a className="ghost-btn small" href={`${API}/api/recordings/${id}/transcript?download=1`} aria-label={tr('detail.transcriptAria')} title={tr('detail.transcriptAria')}><ArrowDownTrayIcon aria-hidden="true" />{tr('detail.transcript')}</a>
          </>
        )}
        <a className="ghost-btn small" href={`${API}/api/recordings/${id}/audio?download=1`} aria-label={tr('detail.audioAria')} title={tr('detail.audioAria')}><ArrowDownTrayIcon aria-hidden="true" />{tr('detail.audio')}</a>
        {t && !running && !retry && <button type="button" className="ghost-btn small icon-narrow" onClick={retranscribe} title={tr('detail.transcribeAgain')}><ArrowPathIcon aria-hidden="true" /><span className="btn-label">{tr('detail.transcribeAgain')}</span></button>}
        <button type="button" className="ghost-btn small danger rec-delete icon-narrow" onClick={remove} disabled={running} title={tr('detail.delete')}><TrashIcon aria-hidden="true" /><span className="btn-label">{tr('detail.delete')}</span></button>
      </div>

      <div className="subtabs" role="tablist" aria-label={tr('detail.sectionsAria')}>
        {SUBTABS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`rsub-${s.id}`}
            aria-selected={sub === s.id}
            aria-controls={`rsubpanel-${s.id}`}
            tabIndex={sub === s.id ? 0 : -1}
            className={`subtab ${sub === s.id ? 'active' : ''}`}
            onClick={() => selectSub(s.id)}
            onKeyDown={onSubKey}
          >
            {tr(s.labelKey)}
          </button>
        ))}
      </div>
      {/* Panels stay mounted so a running answer or translation survives tab switches. */}
      <div role="tabpanel" id="rsubpanel-notes" aria-labelledby="rsub-notes" className="subtab-panel" hidden={sub !== 'notes'}>
        <RecordingNotes
          rec={rec}
          text={text}
          segments={segments}
          lang={lang}
          hash={hash}
          summary={t?.status === 'done' || summary ? summary : null}
          pending={pending}
          getStore={getStore}
          ai={ai}
          auto={auto}
          actions={{ saveSummary: saveSerial, rename: autoRename }}
          onGenerated={onGenerated}
          onNotesTranslation={onNotesTranslation}
          onError={onError}
        />
      </div>
      <div role="tabpanel" id="rsubpanel-transcript" aria-labelledby="rsub-transcript" className="subtab-panel" hidden={sub !== 'transcript'}>
        <RecordingTranscript
          rec={rec}
          text={text}
          segments={segments}
          running={running}
          audioRef={audioRef}
          onSeek={seek}
          lang={lang}
          store={store}
          hash={hash}
          onTranslation={onTranslation}
          saveTranscript={saveTranscript}
          onSaved={onTranscriptSaved}
          onError={onError}
        />
      </div>
      <div role="tabpanel" id="rsubpanel-ask" aria-labelledby="rsub-ask" className="subtab-panel" hidden={sub !== 'ask'}>
        <RecordingAsk rec={rec} text={text} lang={lang} ai={ai} thread={thread} onAnswer={onAnswer} />
      </div>
    </article>
  );
}
