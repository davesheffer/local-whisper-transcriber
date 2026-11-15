import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDownTrayIcon, ArrowPathIcon, ExclamationTriangleIcon, LanguageIcon, SparklesIcon,
} from '@heroicons/react/24/outline';

import { buildMarkdown, friendlyError, isAbort, normLang, translateText, translatorStatus } from './ai/builtin';
import {
  AiGate, AUTO_KEY, autoSummarizeOn, downloadText, generateAndSave, progressLabel, safeFileName,
} from './aiNotes';
import { fmtDate, langName } from './useRecordings';

const NOTES_LANG_KEY = 'ai.notesLang';
const RTL = ['he', 'ar', 'fa', 'ur'];
const readNotesLang = () => { try { return localStorage.getItem(NOTES_LANG_KEY); } catch { return null; } };

// Translate each summary field on its own so the structure survives (owner/due stay as-is).
// The first translateText call runs before any await, so a click can start the model download.
async function translateNotes(s, from, to, signal, onProgress) {
  const list = (a) => (Array.isArray(a) ? a : []);
  const items = list(s.actionItems);
  const src = [s.title, s.tldr, ...list(s.keyPoints), ...list(s.decisions), ...items.map((a) => a && a.task)];
  const total = src.filter((x) => x && String(x).trim()).length;
  const out = [];
  let n = 0;
  for (const x of src) {
    if (!x || !String(x).trim()) { out.push(x); continue; }
    n += 1;
    if (onProgress) onProgress({ stage: 'notes', part: n, total });
    const r = await translateText(String(x), from, to, signal, (p) => p.stage === 'download' && onProgress && onProgress(p));
    out.push(String(r).trim());
  }
  let i = 0;
  const take = (k) => { const v = out.slice(i, i + k); i += k; return v; };
  const [title, tldr] = take(2);
  const keyPoints = take(list(s.keyPoints).length);
  const decisions = take(list(s.decisions).length);
  const actionItems = take(items.length).map((task, j) => ({ ...items[j], task }));
  return { title, tldr, keyPoints, decisions, actionItems };
}

// Notes tab: AI status, generate/regenerate, the summary sections, language toggle, copy and export.
export default function RecordingNotes({
  rec, text, segments, lang, hash, summary, pending, ai, auto, actions, onGenerated, onNotesTranslation, onError,
}) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [autoOn, setAutoOn] = useState(autoSummarizeOn);
  const [viewLang, setViewLang] = useState(readNotesLang);
  const [trAvail, setTrAvail] = useState(null);
  const [trBusy, setTrBusy] = useState(null);
  const [trError, setTrError] = useState(null);
  const ctrl = useRef(null);
  const trCtrl = useRef(null);
  const done = rec.transcript?.status === 'done';
  const autoJob = auto && auto.job && auto.job.id === rec.id ? auto.job : null;
  const working = busy || (autoJob && autoJob.progress);
  const stale = !!(summary && hash && summary.sourceHash && summary.sourceHash !== hash);
  const canGenerate = ai.state === 'available' && done && !!(text && text.trim()) && !working && !trBusy;

  // Notes language toggle (Hebrew <-> English), translations cached in the summary file.
  const has = summary && typeof summary === 'object';
  const notesLang = (has && normLang(summary.lang)) || normLang(lang) || 'en';
  const target = notesLang === 'he' ? 'en' : 'he';
  const cachedTr = has && summary.notesTranslations && summary.notesTranslationsFor === summary.createdAt
    ? summary.notesTranslations[target] || null : null;
  const showTr = viewLang === target && !!cachedTr;
  const view = showTr ? { ...summary, ...cachedTr } : summary;
  const shownLang = showTr ? target : notesLang;
  const canToggle = has && !working && (!!cachedTr || (trAvail && trAvail !== 'unavailable'));
  const toLang = showTr || trBusy ? notesLang : target;

  useEffect(() => {
    let alive = true;
    if (!has) { setTrAvail(null); return undefined; }
    translatorStatus(notesLang, target).then((s) => alive && setTrAvail(s));
    return () => { alive = false; };
  }, [has, notesLang, target]);
  useEffect(() => () => trCtrl.current && trCtrl.current.abort(), []);

  function chooseLang(l) {
    setViewLang(l);
    try { localStorage.setItem(NOTES_LANG_KEY, l); } catch { /* storage unavailable */ }
  }
  async function toggleLang() {
    if (showTr || trBusy) { chooseLang(notesLang); if (trCtrl.current) trCtrl.current.abort(); return; }
    chooseLang(target);
    setTrError(null);
    if (cachedTr) return;
    const c = new AbortController();
    trCtrl.current = c;
    setTrBusy({ stage: 'notes' });
    try {
      // translateNotes creates the translator before its first await (click = user activation).
      const out = await translateNotes(summary, notesLang, target, c.signal, setTrBusy);
      await onNotesTranslation(target, out, summary.createdAt);
      setTrAvail('available');
    } catch (e) {
      if (!isAbort(e)) { console.error('[ai] translating notes failed', e); setTrError(friendlyError(e)); }
    } finally {
      if (trCtrl.current === c) trCtrl.current = null;
      setTrBusy(null);
    }
  }
  function stopTr() { if (trCtrl.current) trCtrl.current.abort(); chooseLang(notesLang); }
  const trLabel = (p) => (p.stage === 'notes'
    ? `Translating notes…${p.total > 1 ? ` (${p.part}/${p.total})` : ''}` : progressLabel(p));

  async function generate() {
    if (!canGenerate) return;
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setBusy({ stage: 'start' });
    try {
      const merged = await generateAndSave({
        rec, text, segments, lang, existing: summary || null, pending, actions, signal: c.signal, onProgress: setBusy,
      });
      onGenerated(merged);
    } catch (e) {
      if (!isAbort(e)) { console.error('[ai] generating notes failed', e); setError(friendlyError(e)); }
    } finally {
      ctrl.current = null;
      setBusy(null);
    }
  }
  function stop() {
    if (ctrl.current) ctrl.current.abort();
    else if (autoJob) auto.cancel(rec.id);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(buildMarkdown(rec, view, null));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) { onError(`Copy failed: ${e.message}`); }
  }
  function exportMd() {
    const transcript = Array.isArray(segments) && segments.length ? segments : text;
    downloadText(`${safeFileName(rec.name)}.md`, buildMarkdown(rec, view, transcript));
  }
  function toggleAuto(on) {
    setAutoOn(on);
    try { localStorage.setItem(AUTO_KEY, on ? 'true' : 'false'); } catch { /* storage unavailable */ }
  }

  return (
    <div className="notes">
      <AiGate ai={ai} what="Meeting notes" />

      {working && (
        <div className="ai-busy" role="status" aria-live="polite">
          <ArrowPathIcon className="ai-note-icon spin" aria-hidden="true" />
          <span>{progressLabel(busy || autoJob.progress)}{!busy && autoJob ? ' (automatic)' : ''}</span>
          <button type="button" className="ghost-btn small" onClick={stop}>Cancel</button>
        </div>
      )}
      {trBusy && (
        <div className="ai-busy" role="status" aria-live="polite">
          <ArrowPathIcon className="ai-note-icon spin" aria-hidden="true" />
          <span>{trLabel(trBusy)}</span>
          <button type="button" className="ghost-btn small" onClick={stopTr}>Cancel</button>
        </div>
      )}
      {error && <p className="rec-error" role="alert">{error}</p>}
      {trError && <p className="rec-error" role="alert">{trError}</p>}

      {stale && !working && (
        <div className="rec-banner">
          <ExclamationTriangleIcon className="rec-banner-icon" aria-hidden="true" />
          <span>
            Transcript changed — these notes are from an older version.
            {canGenerate && <> <button type="button" className="link-btn" onClick={generate}>Regenerate</button></>}
          </span>
        </div>
      )}

      {summary === undefined && done ? (
        <p className="recs-transcript-empty">Loading notes…</p>
      ) : has ? (
        <div className="notes-body" lang={shownLang} dir={RTL.includes(shownLang) ? 'rtl' : 'ltr'}>
          {view.title && <h4 className="notes-title" dir="auto">{view.title}</h4>}
          {view.tldr && (
            <section className="notes-sec">
              <h5>TL;DR</h5>
              <p dir="auto">{view.tldr}</p>
            </section>
          )}
          <NoteList head="Key points" items={view.keyPoints} />
          <NoteList head="Decisions" items={view.decisions} />
          {Array.isArray(view.actionItems) && view.actionItems.length > 0 && (
            <section className="notes-sec">
              <h5>Action items</h5>
              <ul className="notes-todo">
                {view.actionItems.map((a, i) => (
                  <li key={i}>
                    <span className="notes-check" aria-hidden="true" />
                    <span dir="auto">{a.task}{a.owner ? <span className="notes-owner" dir="auto"> — {a.owner}</span> : null}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {summary.createdAt && <p className="notes-meta">Written on this computer by Chrome's built-in AI · {fmtDate(summary.createdAt)}</p>}
        </div>
      ) : !done ? (
        <p className="recs-transcript-empty">Notes can be written once the recording is transcribed.</p>
      ) : text != null && !text.trim() ? (
        <p className="recs-transcript-empty">No speech was detected, so there is nothing to summarize.</p>
      ) : ai.state === 'available' && !working ? (
        <p className="recs-transcript-empty">No notes yet.</p>
      ) : null}

      <div className="rec-actions">
        {ai.state === 'available' && done && (
          <button type="button" className={has ? 'ghost-btn' : 'primary-btn'} onClick={generate} disabled={!canGenerate}>
            {has ? <ArrowPathIcon aria-hidden="true" className="btn-icon" /> : <SparklesIcon aria-hidden="true" className="btn-icon" />}
            {has ? 'Regenerate' : 'Generate notes'}
          </button>
        )}
        {canToggle && (
          <button type="button" className="ghost-btn" aria-pressed={showTr} onClick={toggleLang}>
            <LanguageIcon aria-hidden="true" />
            {`Show in ${langName(toLang) || toLang}`}
          </button>
        )}
        {has && <button type="button" className="ghost-btn" onClick={copy}>{copied ? 'Copied ✓' : 'Copy notes'}</button>}
        {has && <button type="button" className="ghost-btn" onClick={exportMd}><ArrowDownTrayIcon aria-hidden="true" />Export .md</button>}
      </div>

      {ai.state !== 'unsupported' && (
        <div className="field field-toggle notes-auto">
          <input id="ai-auto" type="checkbox" role="switch" className="toggle" checked={autoOn} onChange={(e) => toggleAuto(e.target.checked)} />
          <label htmlFor="ai-auto">Write notes automatically for new recordings</label>
        </div>
      )}
    </div>
  );
}

function NoteList({ head, items }) {
  if (!Array.isArray(items) || !items.length) return null;
  return (
    <section className="notes-sec">
      <h5>{head}</h5>
      <ul className="notes-list">
        {items.map((x, i) => <li key={i} dir="auto">{x}</li>)}
      </ul>
    </section>
  );
}
