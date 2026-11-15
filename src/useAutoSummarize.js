import { useCallback, useEffect, useRef, useState } from 'react';

import { getStatus, isAbort, overallStatus } from './ai/builtin';
import { autoSummarizeOn, generateAndSave, resolveLang } from './aiNotes';

// Background notes for recordings whose transcription finishes while the app is open.
// One job at a time; only when the model is already downloaded ('available'), so no
// user gesture is needed. Returns { job: { id, progress } | null, cancel(id) }.
export default function useAutoSummarize(data) {
  const { recordings, loaded, fetchTranscript, getSegments, saveSummary, rename } = data;
  const seen = useRef(null); // id → transcript status at the last list update
  const queue = useRef([]);
  const busy = useRef(false);
  const ctrl = useRef(null);
  const recs = useRef(recordings);
  const actions = useRef({ fetchTranscript, getSegments, saveSummary, rename });
  const [job, setJob] = useState(null);
  recs.current = recordings;
  actions.current = { fetchTranscript, getSegments, saveSummary, rename };

  const runOne = useCallback(async (id) => {
    const a = actions.current;
    const find = () => recs.current.find((r) => r.id === id);
    let rec = find();
    if (!rec || rec.summary || rec.transcript?.status !== 'done' || !autoSummarizeOn()) return;
    const text = await a.fetchTranscript(id);
    if (!text || !text.trim()) return;
    const lang = await resolveLang(rec.transcript?.language, text);
    if (overallStatus(await getStatus(lang)) !== 'available') return;
    const segments = await a.getSegments(id).catch(() => null);
    rec = find();
    if (!rec || rec.summary) return;
    const c = new AbortController();
    ctrl.current = { id, c };
    setJob({ id, progress: { stage: 'start' } });
    await generateAndSave({
      rec, text, segments, lang, existing: null, pending: null,
      actions: { saveSummary: a.saveSummary, rename: (rid, name) => (find()?.name === rec.name ? a.rename(rid, name) : null) },
      signal: c.signal,
      onProgress: (p) => setJob({ id, progress: p }),
    });
  }, []);

  const pump = useCallback(async () => {
    if (busy.current) return;
    const id = queue.current.shift();
    if (!id) return;
    busy.current = true;
    try {
      await runOne(id);
    } catch (e) {
      if (!isAbort(e)) console.error('[ai] auto-summarize failed for', id, e);
    } finally {
      busy.current = false;
      ctrl.current = null;
      setJob(null);
      pump();
    }
  }, [runOne]);

  // Queue recordings that just moved to 'done' (not the ones already done at startup).
  useEffect(() => {
    if (!loaded) return;
    const before = seen.current;
    seen.current = new Map(recordings.map((r) => [r.id, r.transcript?.status]));
    if (!before) return;
    let added = false;
    for (const r of recordings) {
      if (r.transcript?.status !== 'done' || before.get(r.id) === 'done' || r.summary) continue;
      if (!queue.current.includes(r.id) && ctrl.current?.id !== r.id) { queue.current.push(r.id); added = true; }
    }
    if (added) pump();
  }, [recordings, loaded, pump]);

  const cancel = useCallback((id) => {
    queue.current = queue.current.filter((x) => x !== id);
    if (ctrl.current && ctrl.current.id === id) ctrl.current.c.abort();
  }, []);

  return { job, cancel };
}
