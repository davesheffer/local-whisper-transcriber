// UI-side glue for the on-device AI: status hook, the "AI gate" notice, progress
// labels, and the one generate → save → auto-title path used by both the Notes tab
// and background auto-summarize.
import React, { useCallback, useEffect, useState } from 'react';
import { ArrowPathIcon, ExclamationTriangleIcon, SparklesIcon } from '@heroicons/react/24/outline';

import {
  buildMarkdown, detectLanguage, friendlyError, getStatus, guessLang, normLang, overallStatus, prepare, summarize,
} from './ai/builtin';

export const AUTO_KEY = 'ai.autoSummarize';
export const autoSummarizeOn = () => { try { return localStorage.getItem(AUTO_KEY) !== 'false'; } catch { return true; } };

// Default names given by the Record tab (`Meeting <date>` / `Recovered <date>`) and the
// server (`Meeting <toLocaleString()>`): the prefix plus a year and a time somewhere.
export function isDefaultName(name) {
  const n = String(name || '');
  return /^(Meeting|Recovered) [^\n]{0,48}$/.test(n) && /\d{4}/.test(n) && /\d{1,2}[:.]\d{2}/.test(n);
}

// Language of a transcript: detector first, then the language it was transcribed in,
// then the script.
export async function resolveLang(declared, text) {
  const d = normLang(declared);
  const fallback = d && d !== 'auto' ? d : guessLang(text);
  if (!text || !text.trim()) return fallback;
  return detectLanguage(text, fallback);
}

export function progressLabel(p) {
  if (!p) return '';
  const part = p.total > 1 ? ` part ${p.part}/${p.total}` : '';
  switch (p.stage) {
    case 'download': return `Downloading the on-device model… ${Math.round((p.loaded || 0) * 100)}%`;
    case 'translate': return `Translating${part ? ` (${part.trim()})` : ''}…`;
    case 'start': return 'Starting the on-device model…';
    case 'summarize': return `Summarizing${part}…`;
    case 'reduce': return 'Combining notes…';
    case 'translate-back': return 'Translating the result back…';
    case 'answer': return 'Thinking…';
    case 'save': return 'Saving…';
    default: return 'Working…';
  }
}

export const transcriptFor = (segments, text) => (Array.isArray(segments) && segments.length ? segments : text);

export function safeFileName(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120); // eslint-disable-line no-control-regex
  return clean || 'meeting';
}

export function downloadText(filename, text, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Rename a recording to its summary title, only while it still has the default name.
export async function autoTitle(rec, title, rename) {
  const clean = String(title || '').trim().slice(0, 200);
  if (!clean || !isDefaultName(rec.name) || clean === rec.name) return;
  try { await rename(rec.id, clean); } catch (e) { console.error('[ai] auto-title failed', e); }
}

// existing: the stored summary (Q&A history is kept; translations only when they were
// made for the same transcript). pending: Q&A / translations held in memory because the
// recording had no summary file yet. Either may be a getter, read once generation is
// done, so Q&A or translations saved while the model was running are not lost.
export async function generateAndSave({ rec, text, segments, lang, existing, pending, actions, signal, onProgress }) {
  const s = await summarize({ text, segments, lang, signal, onProgress });
  if (signal && signal.aborted) { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; }
  const read = (v) => (typeof v === 'function' ? v() : v);
  const ex = read(existing);
  const pe = read(pending);
  const sameTr = (o) => o && o.translationsHash === s.sourceHash && o.translations;
  const merged = {
    ...s,
    qa: [...((ex && ex.qa) || []), ...((pe && pe.qa) || [])],
    translations: { ...(sameTr(ex) || {}), ...(sameTr(pe) || {}) },
    translationsHash: s.sourceHash,
  };
  if (onProgress) onProgress({ stage: 'save' });
  try {
    await actions.saveSummary(rec.id, merged, buildMarkdown(rec, merged, transcriptFor(segments, text)));
  } catch (e) {
    console.error('[ai] saving the summary failed', e);
    const err = new Error(`Could not save the notes: ${e.message}`);
    err.friendly = true;
    throw err;
  }
  await autoTitle(rec, merged.title, actions.rename);
  return merged;
}

// ---------------------------------------------------------------------------
// Status of the on-device AI for one transcript language.
// state: 'checking' | 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available'
// ---------------------------------------------------------------------------
export function useAiStatus(lang) {
  const supported = !!window.LanguageModel;
  const [state, setState] = useState(supported ? 'checking' : 'unsupported');
  const [download, setDownload] = useState(null);
  const [error, setError] = useState(null);

  const check = useCallback(async () => {
    if (!supported) return 'unsupported';
    try {
      const next = overallStatus(await getStatus(lang));
      setState(next);
      return next;
    } catch (e) {
      console.error('[ai] status check failed', e);
      setState('unavailable');
      return 'unavailable';
    }
  }, [lang, supported]);

  useEffect(() => { check(); }, [check]);

  // Chrome may already be downloading (e.g. started in another tab): poll until done.
  useEffect(() => {
    if (state !== 'downloading' || download != null) return undefined;
    const timer = setInterval(check, 3000);
    return () => clearInterval(timer);
  }, [state, download, check]);

  // Must run straight from a click handler (prepare() calls create() synchronously).
  const enable = useCallback(() => {
    setError(null);
    setDownload(0);
    setState('downloading');
    prepare(lang, (p) => setDownload(p.loaded || 0))
      .then(() => { setDownload(null); return check(); })
      .catch((e) => { setDownload(null); setError(friendlyError(e)); check(); });
  }, [lang, check]);

  return { state, download, error, enable, recheck: check, lang };
}

// Notice shown instead of AI features until the model is ready. Renders nothing when ready.
export function AiGate({ ai, what = 'Meeting notes' }) {
  if (!ai || ai.state === 'available') return null;
  if (ai.state === 'checking') {
    return <p className="ai-note"><ArrowPathIcon className="ai-note-icon spin" aria-hidden="true" />Checking on-device AI…</p>;
  }
  if (ai.state === 'unsupported') {
    return (
      <div className="rec-banner ai-gate">
        <ExclamationTriangleIcon className="rec-banner-icon" aria-hidden="true" />
        <span>
          {what} use Chrome's built-in on-device AI, which this browser doesn't have. Open the app in Chrome 138 or newer
          on a supported computer. Recording, transcripts and downloads keep working here.
        </span>
      </div>
    );
  }
  if (ai.state === 'unavailable') {
    return (
      <div className="rec-banner ai-gate">
        <ExclamationTriangleIcon className="rec-banner-icon" aria-hidden="true" />
        <span>
          Chrome reports its on-device AI as unavailable on this computer{ai.lang && ai.lang !== 'en' ? ' for this language' : ''}
          {' '}(it needs enough free disk space, memory and a supported GPU or CPU). Details: chrome://on-device-internals.
          {ai.error ? ` ${ai.error}` : ''}
        </span>
      </div>
    );
  }
  const pct = ai.download != null ? Math.round(ai.download * 100) : null;
  return (
    <div className="ai-gate ai-enable">
      {ai.state === 'downloading' ? (
        <>
          <p className="ai-note"><ArrowPathIcon className="ai-note-icon spin" aria-hidden="true" />Downloading the on-device AI model{pct != null ? `… ${pct}%` : '…'}</p>
          <div className="rec-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct || 0} aria-label="Model download"><b style={{ width: `${pct || 0}%` }} /></div>
        </>
      ) : (
        <>
          <p className="ai-note">
            {what} are written on this computer by Chrome's built-in AI. Chrome downloads the model once (a few GB);
            nothing is sent to the cloud.
          </p>
          <button type="button" className="primary-btn" onClick={ai.enable}><SparklesIcon aria-hidden="true" className="btn-icon" />Enable on-device AI</button>
        </>
      )}
      {ai.error && <p className="rec-error">{ai.error}</p>}
    </div>
  );
}
