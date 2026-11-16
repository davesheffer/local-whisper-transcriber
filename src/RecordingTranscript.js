import React, { useEffect, useRef, useState } from 'react';
import { LanguageIcon, PencilSquareIcon } from '@heroicons/react/24/outline';

import { fmtStamp, friendlyError, isAbort, translateText, translatorStatus } from './ai/builtin';
import { progressLabel } from './aiNotes';
import { useI18n } from './i18n';
import { langName } from './useRecordings';

// Index of the segment playing at `t` seconds (-1 before the first / well past the last).
function segmentAt(segs, t) {
  let lo = 0; let hi = segs.length - 1; let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found === segs.length - 1 && t > segs[found].end + 2) return -1;
  return found;
}

// Transcript tab: timestamped segments (click to seek, playing one highlighted),
// translation toggle and edit mode.
export default function RecordingTranscript({
  rec, text, segments, running, audioRef, onSeek, lang, store, hash, onTranslation, saveTranscript, onSaved, onError,
}) {
  const { t } = useI18n();
  const done = rec.transcript?.status === 'done';
  const hasSegs = Array.isArray(segments) && segments.length > 0;
  const target = lang === 'en' ? 'he' : 'en';
  const [active, setActive] = useState(-1);
  const listRef = useRef(null);
  const userScrolled = useRef(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showTr, setShowTr] = useState(false);
  const [trAvail, setTrAvail] = useState(null);
  const [trBusy, setTrBusy] = useState(null);
  const [trError, setTrError] = useState(null);
  const trCtrl = useRef(null);

  useEffect(() => {
    let alive = true;
    if (!lang) { setTrAvail(null); return undefined; }
    translatorStatus(lang, target).then((s) => alive && setTrAvail(s));
    return () => { alive = false; };
  }, [lang, target]);
  useEffect(() => () => trCtrl.current && trCtrl.current.abort(), []);

  // Follow playback.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !hasSegs) return undefined;
    const onTime = () => {
      const i = segmentAt(segments, a.currentTime);
      setActive((prev) => (prev === i ? prev : i));
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('seeked', onTime);
    return () => { a.removeEventListener('timeupdate', onTime); a.removeEventListener('seeked', onTime); };
  }, [audioRef, segments, hasSegs]);

  // Keep the playing segment in view unless the user scrolled in the last 5 s.
  useEffect(() => {
    const box = listRef.current;
    if (active < 0 || editing || !box || box.offsetParent === null) return;
    if (Date.now() - userScrolled.current < 5000) return;
    const row = box.querySelector(`[data-i="${active}"]`);
    if (!row) return;
    const top = row.offsetTop;
    if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: 'smooth' });
    }
  }, [active, editing]);
  const markUserScroll = () => { userScrolled.current = Date.now(); };

  // Translation (cached in the summary file, or in memory when there is none).
  const sourceText = hasSegs ? segments.map((s) => String(s.text || '').trim()).join('\n') : (text || '');
  const cached = store && hash && store.translationsHash === hash && store.translations ? store.translations[target] : null;
  const trLines = cached != null ? String(cached).split('\n') : null;
  const aligned = hasSegs && trLines && trLines.length === segments.length;
  const canTranslate = done && !!sourceText.trim() && trAvail && trAvail !== 'unavailable';

  // An edit changes the transcript hash and drops the cached translation: hide the
  // translation column instead of leaving it empty under "Hide translation".
  useEffect(() => {
    setShowTr(false);
    if (trCtrl.current) trCtrl.current.abort();
  }, [hash]);

  async function toggleTranslation() {
    if (showTr) { setShowTr(false); if (trCtrl.current) trCtrl.current.abort(); return; }
    setShowTr(true);
    setTrError(null);
    if (cached != null) return;
    const c = new AbortController();
    trCtrl.current = c;
    setTrBusy({ stage: 'translate' });
    try {
      // translateText creates the translator before its first await (click = user activation).
      const out = await translateText(sourceText, lang, target, c.signal, setTrBusy);
      await onTranslation(target, out, hash);
      setTrAvail('available');
    } catch (e) {
      if (!isAbort(e)) { console.error('[ai] translation failed', e); setTrError(friendlyError(e)); }
    } finally {
      if (trCtrl.current === c) trCtrl.current = null;
      setTrBusy(null);
    }
  }

  function startEdit() {
    setDraft(hasSegs ? segments.map((s) => ({ start: s.start, end: s.end, text: String(s.text || '').trim() })) : (text || ''));
    setEditing(true);
  }
  function cancelEdit() { setEditing(false); setDraft(null); }
  async function save() {
    const body = Array.isArray(draft)
      ? { text: draft.map((s) => s.text.trim()).join('\n'), segments: draft.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })) }
      : { text: draft };
    setSaving(true);
    try {
      await saveTranscript(rec.id, body);
      onSaved(body);
      setEditing(false);
      setDraft(null);
    } catch (e) {
      // The server's message says why (409: transcription running / not finished).
      onError(t('transcript.saveFailed', { error: e.message }));
    } finally { setSaving(false); }
  }

  if (!done) {
    return (
      <p className="recs-transcript-empty">
        {running ? t('transcript.running') : t('transcript.none')}
      </p>
    );
  }
  if (text == null) return <div className="recs-transcript">{t('common.loading')}</div>;

  if (editing) {
    return (
      <div className="tr-edit">
        {Array.isArray(draft) ? (
          <ol className="tr-edit-list" dir={lang === 'he' ? 'rtl' : lang === 'en' ? 'ltr' : undefined}>
            {draft.map((s, i) => (
              <li key={i} className="tr-edit-row">
                <span className="seg-time static" dir="ltr">[{fmtStamp(s.start)}]</span>
                <textarea
                  dir="auto"
                  value={s.text}
                  rows={Math.max(1, Math.ceil(s.text.length / 70))}
                  aria-label={t('transcript.segmentAria', { time: fmtStamp(s.start) })}
                  onChange={(e) => { const v = e.target.value; setDraft((d) => d.map((x, j) => (j === i ? { ...x, text: v } : x))); }}
                />
              </li>
            ))}
          </ol>
        ) : (
          <textarea className="tr-edit-all" dir="auto" value={draft} aria-label={t('transcript.textAria')} onChange={(e) => setDraft(e.target.value)} />
        )}
        <div className="rec-actions">
          <button type="button" className="primary-btn" onClick={save} disabled={saving || running}>{saving ? t('common.saving') : t('transcript.save')}</button>
          <button type="button" className="ghost-btn" onClick={cancelEdit} disabled={saving}>{t('common.cancel')}</button>
        </div>
      </div>
    );
  }

  const trName = langName(target) || target;
  // Lay out the transcript in its own language's direction, not the UI's.
  const textDir = lang === 'he' ? 'rtl' : lang === 'en' ? 'ltr' : undefined;
  return (
    <div className="tr">
      <div className="tr-bar">
        <button type="button" className="ghost-btn small" onClick={startEdit} disabled={running}><PencilSquareIcon aria-hidden="true" />{t('transcript.edit')}</button>
        {canTranslate && (
          <button type="button" className="ghost-btn small" aria-pressed={showTr} onClick={toggleTranslation}>
            <LanguageIcon aria-hidden="true" />{showTr ? t('transcript.hideTr') : t('transcript.showTr', { lang: trName })}
          </button>
        )}
        {trBusy && <span className="ai-note" role="status">{progressLabel(trBusy)}</span>}
        {rec.transcript?.edited && <span className="chip">{t('transcript.edited')}</span>}
      </div>
      {trError && <p className="rec-error" role="alert">{trError}</p>}

      {hasSegs ? (
        <ol
          className={`recs-transcript seg-list ${showTr && aligned ? 'with-tr' : ''}`}
          dir={textDir}
          ref={listRef}
          onWheel={markUserScroll}
          onTouchMove={markUserScroll}
          onPointerDown={markUserScroll}
          onKeyDown={markUserScroll}
        >
          {segments.map((s, i) => (
            <li key={i} data-i={i} className={`seg ${i === active ? 'active' : ''}`} aria-current={i === active ? 'true' : undefined}>
              <button type="button" className="seg-time" dir="ltr" onClick={() => onSeek(s.start)} aria-label={t('transcript.playFrom', { time: fmtStamp(s.start) })}>[{fmtStamp(s.start)}]</button>
              <span className="seg-text" dir="auto" onClick={() => { if (!String(window.getSelection && window.getSelection())) onSeek(s.start); }}>{String(s.text || '').trim()}</span>
              {showTr && aligned && <span className="seg-tr" dir="auto">{trLines[i]}</span>}
            </li>
          ))}
        </ol>
      ) : (
        <div className={showTr && trLines ? 'tr-split' : ''}>
          <div className="recs-transcript" dir="auto">{text || t('transcript.noSpeech')}</div>
          {showTr && trLines && !aligned && <div className="recs-transcript" dir="auto">{cached}</div>}
        </div>
      )}
      {hasSegs && showTr && trLines && !aligned && (
        <div className="recs-transcript tr-block" dir="auto" aria-label={t('transcript.trAria', { lang: trName })}>{cached}</div>
      )}
    </div>
  );
}
