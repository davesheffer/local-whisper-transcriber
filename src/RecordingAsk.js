import React, { useEffect, useRef, useState } from 'react';
import { ArrowPathIcon, PaperAirplaneIcon, StopIcon } from '@heroicons/react/24/outline';

import { ask, friendlyError, isAbort } from './ai/builtin';
import { AiGate, progressLabel } from './aiNotes';

// Ask tab: a chat about the meeting, answered on-device from the transcript.
export default function RecordingAsk({ rec, text, lang, ai, thread, onAnswer }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null); // { question, stage, … }
  const [partial, setPartial] = useState('');
  const [error, setError] = useState(null);
  const ctrl = useRef(null);
  const endRef = useRef(null);
  const done = rec.transcript?.status === 'done';
  const ready = ai.state === 'available' && done && !!(text && text.trim());

  useEffect(() => () => ctrl.current && ctrl.current.abort(), []);
  useEffect(() => {
    const el = endRef.current;
    if (el && el.offsetParent !== null && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [thread.length, partial, busy]);

  async function send() {
    const question = q.trim();
    if (!question || busy || !ready) return;
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setQ('');
    setPartial('');
    setBusy({ question, stage: 'answer' });
    try {
      const a = await ask({
        question, text, lang, history: thread, signal: c.signal,
        onProgress: (p) => setBusy((b) => (b ? { ...b, ...p } : b)),
        onPartial: setPartial,
      });
      await onAnswer({ q: question, a, at: Date.now() });
    } catch (e) {
      setQ((cur) => cur || question);
      if (!isAbort(e)) { console.error('[ai] ask failed', e); setError(friendlyError(e)); }
    } finally {
      ctrl.current = null;
      setBusy(null);
      setPartial('');
    }
  }
  const stop = () => ctrl.current && ctrl.current.abort();

  return (
    <div className="ask">
      <AiGate ai={ai} what="Questions about the meeting" />
      {!done && <p className="recs-transcript-empty">You can ask questions once the recording is transcribed.</p>}

      <div className="ask-scroll">
      {(thread.length > 0 || busy) && (
        <ol className="ask-thread" aria-label="Questions and answers">
          {thread.map((m, i) => (
            <li key={`${m.at}-${i}`} className="ask-pair">
              <p className="ask-q" dir="auto">{m.q}</p>
              <p className="ask-a" dir="auto">{m.a}</p>
            </li>
          ))}
          {busy && (
            <li className="ask-pair">
              <p className="ask-q" dir="auto">{busy.question}</p>
              <p className="ask-a pending" dir="auto" aria-live="polite">
                {partial || <><ArrowPathIcon className="ai-note-icon spin" aria-hidden="true" />{progressLabel(busy)}</>}
              </p>
            </li>
          )}
        </ol>
      )}
      <div ref={endRef} />
      </div>
      {error && <p className="rec-error" role="alert">{error}</p>}

      {ready && (
        <div className="ask-input">
          <textarea
            dir="auto"
            rows={2}
            value={q}
            placeholder="Ask about this meeting — e.g. What did we decide about the budget?"
            aria-label="Question about this meeting"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
          />
          {busy ? (
            <button type="button" className="ghost-btn" onClick={stop}><StopIcon aria-hidden="true" />Stop</button>
          ) : (
            <button type="button" className="primary-btn" onClick={send} disabled={!q.trim()}><PaperAirplaneIcon aria-hidden="true" className="btn-icon" />Ask</button>
          )}
        </div>
      )}
      {ready && thread.length === 0 && !busy && (
        <p className="ai-note">Answers come from the transcript only and are written on this computer. Press Enter to send, Shift+Enter for a new line.</p>
      )}
    </div>
  );
}
