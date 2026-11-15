import React, { useRef, useState } from 'react';
import { ArrowDownTrayIcon, ArrowPathIcon, ExclamationTriangleIcon, SparklesIcon } from '@heroicons/react/24/outline';

import { buildMarkdown, friendlyError, isAbort } from './ai/builtin';
import {
  AiGate, AUTO_KEY, autoSummarizeOn, downloadText, generateAndSave, progressLabel, safeFileName,
} from './aiNotes';
import { fmtDate } from './useRecordings';

// Notes tab: AI status, generate/regenerate, the summary sections, copy and export.
export default function RecordingNotes({ rec, text, segments, lang, hash, summary, pending, ai, auto, actions, onGenerated, onError }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [autoOn, setAutoOn] = useState(autoSummarizeOn);
  const ctrl = useRef(null);
  const done = rec.transcript?.status === 'done';
  const autoJob = auto && auto.job && auto.job.id === rec.id ? auto.job : null;
  const working = busy || (autoJob && autoJob.progress);
  const stale = !!(summary && hash && summary.sourceHash && summary.sourceHash !== hash);
  const canGenerate = ai.state === 'available' && done && !!(text && text.trim()) && !working;

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
      await navigator.clipboard.writeText(buildMarkdown(rec, summary, null));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) { onError(`Copy failed: ${e.message}`); }
  }
  function exportMd() {
    const transcript = Array.isArray(segments) && segments.length ? segments : text;
    downloadText(`${safeFileName(rec.name)}.md`, buildMarkdown(rec, summary, transcript));
  }
  function toggleAuto(on) {
    setAutoOn(on);
    try { localStorage.setItem(AUTO_KEY, on ? 'true' : 'false'); } catch { /* storage unavailable */ }
  }

  const has = summary && typeof summary === 'object';
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
      {error && <p className="rec-error" role="alert">{error}</p>}

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
        <div className="notes-body">
          {summary.title && <h4 className="notes-title" dir="auto">{summary.title}</h4>}
          {summary.tldr && (
            <section className="notes-sec">
              <h5>TL;DR</h5>
              <p dir="auto">{summary.tldr}</p>
            </section>
          )}
          <NoteList head="Key points" items={summary.keyPoints} />
          <NoteList head="Decisions" items={summary.decisions} />
          {Array.isArray(summary.actionItems) && summary.actionItems.length > 0 && (
            <section className="notes-sec">
              <h5>Action items</h5>
              <ul className="notes-todo">
                {summary.actionItems.map((a, i) => (
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
