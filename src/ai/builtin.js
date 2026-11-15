// On-device meeting AI using Chrome's built-in AI (Gemini Nano via the Prompt API,
// Translator, LanguageDetector). No React here: plain async functions that take an
// AbortSignal and report progress through `onProgress({ stage, loaded?, part?, total? })`.
//
// Gemini Nano only reads and writes English on the measured machines, so any other
// transcript language is translated to English, prompted in English, and the results
// are translated back to the transcript language.
//
// The globals are read through window so CRA's no-undef lint rule stays happy.

const LM = () => window.LanguageModel;
const TR = () => window.Translator;
const LD = () => window.LanguageDetector;

const EN_IO = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

// Max characters per Translator call (also checked against translator.inputQuota).
const TRANSLATE_CHARS = 1500;

const SYSTEM_SUMMARY = 'You are an assistant that writes concise, factual meeting notes from transcripts. '
  + 'Only use information that is in the transcript. Never invent names, numbers or decisions. '
  + 'The transcript comes from automatic speech recognition and may contain errors.';
const SYSTEM_ASK = 'You answer questions about a meeting using only its transcript. '
  + 'Be brief and specific. If the transcript does not contain the answer, say so. '
  + 'The transcript comes from automatic speech recognition and may contain errors.';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const abortError = () => {
  try { return new DOMException('Aborted', 'AbortError'); } catch { const e = new Error('Aborted'); e.name = 'AbortError'; return e; }
};
const checkAbort = (signal) => { if (signal && signal.aborted) throw abortError(); };
export const isAbort = (e) => e && e.name === 'AbortError';

// Resolve `promise`, or reject as soon as `signal` aborts (the work itself may continue).
function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

export function normLang(code) {
  if (!code || typeof code !== 'string') return null;
  const base = code.toLowerCase().split(/[-_]/)[0];
  if (base === 'iw') return 'he';
  return base || null;
}

// Script-based guess, used when LanguageDetector is missing or unsure.
export function guessLang(text) {
  const s = String(text || '').slice(0, 4000);
  const hebrew = (s.match(/[֐-׿]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  return hebrew > latin ? 'he' : 'en';
}

// Friendly message for errors shown in the UI (never a raw parse/DOM error).
export function friendlyError(e) {
  if (!e) return 'Something went wrong.';
  if (isAbort(e)) return 'Cancelled.';
  const name = e.name || '';
  if (name === 'QuotaExceededError') return 'The transcript is too long for the on-device model.';
  if (name === 'NotAllowedError') return 'Chrome needs a click to download the on-device model. Press "Enable on-device AI".';
  if (name === 'NotSupportedError') return 'This language is not supported by the on-device model.';
  if (name === 'NetworkError') return 'The model download failed. Check the connection and try again.';
  if (e.friendly) return e.message;
  return `On-device AI failed: ${e.message || name || 'unknown error'}`;
}
const friendly = (message) => { const e = new Error(message); e.friendly = true; return e; };

const pad = (n) => String(n).padStart(2, '0');
// Seconds → "mm:ss" (or "h:mm:ss" past one hour).
export function fmtStamp(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(t / 3600);
  return `${h ? h + ':' : ''}${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------
async function safeAvailability(fn) {
  try { return await fn(); } catch (e) { console.error('[ai] availability check failed', e); return 'unavailable'; }
}

// lang: transcript language ('en', 'he', …). Non-English needs both translation directions.
export async function getStatus(lang) {
  const l = normLang(lang) || 'en';
  const supported = !!LM();
  const out = { supported, lang: l, lm: 'unavailable', translator: 'not-needed', detector: 'unavailable' };
  if (!supported) return out;
  out.lm = await safeAvailability(() => LM().availability(EN_IO));
  if (l !== 'en') {
    if (!TR()) out.translator = 'unavailable';
    else {
      const [to, back] = await Promise.all([
        safeAvailability(() => TR().availability({ sourceLanguage: l, targetLanguage: 'en' })),
        safeAvailability(() => TR().availability({ sourceLanguage: 'en', targetLanguage: l })),
      ]);
      out.translator = worst([to, back]);
    }
  }
  if (LD()) out.detector = await safeAvailability(() => LD().availability());
  return out;
}

const RANK = { unavailable: 0, downloadable: 1, downloading: 2, available: 3, 'not-needed': 4 };
function worst(list) {
  return list.reduce((a, b) => ((RANK[b] ?? 0) < (RANK[a] ?? 0) ? b : a), 'not-needed');
}

// One state for the UI: 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available'.
export function overallStatus(status) {
  if (!status || !status.supported) return 'unsupported';
  const w = worst([status.lm, status.translator]);
  return w === 'not-needed' ? 'available' : w;
}

// Translator availability for one direction (used by the transcript translate toggle).
export async function translatorStatus(from, to) {
  if (!TR()) return 'unavailable';
  const a = normLang(from); const b = normLang(to);
  if (!a || !b || a === b) return 'unavailable';
  return safeAvailability(() => TR().availability({ sourceLanguage: a, targetLanguage: b }));
}

// ---------------------------------------------------------------------------
// Translators and detector (cached: they are stateless)
// ---------------------------------------------------------------------------
const translators = new Map();

// Calls Translator.create() synchronously when not cached, so it can run inside a
// click handler (first download needs transient user activation).
function getTranslator(from, to, onLoaded) {
  const key = `${from}>${to}`;
  if (translators.has(key)) return translators.get(key);
  const p = TR().create({
    sourceLanguage: from,
    targetLanguage: to,
    monitor(m) { m.addEventListener('downloadprogress', (e) => onLoaded && onLoaded(e.loaded)); },
  });
  translators.set(key, p);
  p.catch((e) => { translators.delete(key); console.error('[ai] Translator.create failed', from, to, e); });
  return p;
}

let detectorPromise = null;
function getDetector() {
  if (!detectorPromise) {
    detectorPromise = LD().create();
    detectorPromise.catch((e) => { detectorPromise = null; console.error('[ai] LanguageDetector.create failed', e); });
  }
  return detectorPromise;
}

// Must be called directly from a click handler: every create() starts before any await.
// Resolves when all needed models are downloaded; progress is the average across them.
export function prepare(lang, onProgress) {
  const l = normLang(lang) || 'en';
  const loaded = [];
  const jobs = [];
  const models = 1 + (l !== 'en' && TR() ? 2 : 0); // the detector is not counted
  const report = (i) => (v) => {
    loaded[i] = typeof v === 'number' ? v : 0;
    const avg = loaded.reduce((a, b) => a + (b || 0), 0) / models;
    if (onProgress) onProgress({ stage: 'download', loaded: Math.min(1, avg) });
  };
  if (!LM()) return Promise.reject(friendly('This browser has no built-in AI.'));
  const i0 = jobs.length;
  jobs.push(LM().create({
    ...EN_IO,
    monitor(m) { m.addEventListener('downloadprogress', (e) => report(i0)(e.loaded)); },
  }).then((s) => { report(i0)(1); s.destroy(); }));
  if (l !== 'en' && TR()) {
    const i1 = jobs.length;
    jobs.push(getTranslator(l, 'en', report(i1)).then(() => report(i1)(1)));
    const i2 = jobs.length;
    jobs.push(getTranslator('en', l, report(i2)).then(() => report(i2)(1)));
  }
  if (LD()) jobs.push(getDetector().catch(() => null));
  return Promise.all(jobs).then(() => undefined, (e) => { console.error('[ai] prepare failed', e); throw e; });
}

export async function detectLanguage(text, fallback = 'en') {
  const sample = String(text || '').slice(0, 2000).trim();
  if (!sample || !LD()) return fallback;
  try {
    if ((await LD().availability()) !== 'available') return fallback;
    const detector = await getDetector();
    const results = await detector.detect(sample);
    const top = results && results[0];
    if (!top || top.detectedLanguage === 'und' || top.confidence < 0.5) return fallback;
    return normLang(top.detectedLanguage) || fallback;
  } catch (e) {
    console.error('[ai] language detection failed', e);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------
// Split text into pieces of at most `max` chars at line, then sentence, then word
// boundaries. Each piece keeps the separator that followed it so that
// pieces.map(p => p.text + p.sep).join('') reconstructs the layout.
export function splitPieces(text, max) {
  const out = [];
  const lines = String(text || '').split('\n');
  lines.forEach((line, li) => {
    const lineSep = li < lines.length - 1 ? '\n' : '';
    if (line.length <= max) { out.push({ text: line, sep: lineSep }); return; }
    const sentences = line.match(/[^.!?。？！]+[.!?。？！]*\s*/g) || [line];
    let buf = '';
    const flush = (sep) => { if (buf) out.push({ text: buf.trimEnd(), sep }); buf = ''; };
    for (const s of sentences) {
      if (s.length > max) {
        flush(' ');
        const words = s.split(/(\s+)/);
        for (const w of words) {
          if (w.length > max) {
            flush(' ');
            for (let i = 0; i < w.length; i += max) out.push({ text: w.slice(i, i + max), sep: '' });
          } else if (buf.length + w.length > max) { flush(' '); buf = w.trimStart(); } else buf += w;
        }
        flush(' ');
      } else if (buf.length + s.length > max) { flush(' '); buf = s; } else buf += s;
    }
    flush(lineSep);
  });
  return out;
}

// Group pieces into chunks of at most `max` chars (lines are kept together when possible).
export function chunkText(text, max) {
  const chunks = [];
  let cur = '';
  for (const p of splitPieces(text, max)) {
    const add = p.text + p.sep;
    if (cur && cur.length + add.length > max) { chunks.push(cur); cur = ''; }
    cur += add;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.map((c) => c.replace(/\s+$/, '')).filter((c) => c.trim());
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------
async function translateChunk(translator, chunk, signal) {
  // Respect inputQuota when the translator reports one: halve until it fits.
  if (Number.isFinite(translator.inputQuota) && translator.measureInputUsage && chunk.length > 200) {
    const usage = await translator.measureInputUsage(chunk, { signal });
    if (usage > translator.inputQuota) {
      const halves = chunkText(chunk, Math.ceil(chunk.length / 2));
      const parts = [];
      for (const h of halves) parts.push(await translateChunk(translator, h, signal));
      return parts.join('\n');
    }
  }
  return translator.translate(chunk, { signal });
}

// Translate text line-preserving: each chunk is a group of lines; if the translator
// merged lines, that chunk is re-translated line by line so line i stays line i.
export async function translateText(text, from, to, signal, onProgress) {
  const a = normLang(from); const b = normLang(to);
  if (!text || !a || !b || a === b) return text || '';
  if (!TR()) throw friendly('Translation is not available in this browser.');
  // getTranslator runs before the first await (user activation for downloads).
  const tp = getTranslator(a, b, (loaded) => onProgress && onProgress({ stage: 'download', loaded }));
  const translator = await withAbort(tp, signal);
  const chunks = chunkText(text, TRANSLATE_CHARS);
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    checkAbort(signal);
    if (onProgress) onProgress({ stage: 'translate', part: i + 1, total: chunks.length });
    const chunk = chunks[i];
    let res = await translateChunk(translator, chunk, signal);
    const want = chunk.split('\n').length;
    if (want > 1 && String(res).split('\n').length !== want) {
      const lines = [];
      for (const line of chunk.split('\n')) lines.push(line.trim() ? await translator.translate(line, { signal }) : '');
      res = lines.join('\n');
    }
    out.push(res);
  }
  return out.join('\n');
}

// Translate a list of short strings (summary fields) in one pass where possible.
async function translateList(list, from, to, signal) {
  const out = [];
  for (const s of list) out.push(s ? (await translateText(s, from, to, signal)).trim() : s);
  return out;
}

// Cache of English versions of transcripts (for repeated questions).
const englishCache = new Map();
async function toEnglish(text, lang, signal, onProgress) {
  if (lang === 'en') return text;
  const key = `${lang}:${text}`;
  if (englishCache.has(key)) return englishCache.get(key);
  const en = await translateText(text, lang, 'en', signal, onProgress);
  englishCache.set(key, en);
  while (englishCache.size > 4) englishCache.delete(englishCache.keys().next().value);
  return en;
}

// ---------------------------------------------------------------------------
// Prompt API sessions
// ---------------------------------------------------------------------------
async function createSession(system, signal, onProgress) {
  if (!LM()) throw friendly('This browser has no built-in AI.');
  try {
    return await LM().create({
      ...EN_IO,
      initialPrompts: [{ role: 'system', content: system }],
      signal,
      monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress && onProgress({ stage: 'download', loaded: e.loaded })); },
    });
  } catch (e) {
    if (!isAbort(e)) console.error('[ai] LanguageModel.create failed', e);
    throw e;
  }
}

// Tokens available for one prompt + answer in a fresh clone of `session`.
// (Newer Chrome builds name these contextWindow / contextUsage / measureContextUsage.)
function budget(session, reserve) {
  const q = session.inputQuota ?? session.contextWindow;
  const u = session.inputUsage ?? session.contextUsage;
  const quota = Number.isFinite(q) ? q : 4096;
  const used = Number.isFinite(u) ? u : 0;
  return Math.max(256, quota - used - reserve);
}

async function measure(session, text, signal) {
  try {
    if (session.measureInputUsage) return await session.measureInputUsage(text, { signal });
    if (session.measureContextUsage) return await session.measureContextUsage(text, { signal });
  } catch (e) { if (isAbort(e)) throw e; console.error('[ai] measureInputUsage failed', e); }
  return Math.ceil(text.length / 3.5);
}

// Prompt in a throwaway clone so every prompt starts from the system prompt only.
async function promptOnce(base, text, opts, signal) {
  const s = await base.clone({ signal });
  try { return await s.prompt(text, { ...opts, signal }); } finally { try { s.destroy(); } catch { /* already gone */ } }
}

// ---------------------------------------------------------------------------
// Defensive JSON
// ---------------------------------------------------------------------------
export function parseJsonLoose(str) {
  if (str && typeof str === 'object') return str;
  const s = String(str || '').trim();
  const tries = [s, s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')];
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) {
    try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* next */ }
  }
  return null;
}

const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const strList = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x && (x.text || x.point || x.decision))).map(str).filter(Boolean) : []);
const NO_OWNER = /^(n\/?a|none|unknown|unassigned|not (specified|mentioned|stated)|-+|null)$/i;

function normalizeSummary(obj) {
  const o = obj || {};
  const actionItems = (Array.isArray(o.actionItems) ? o.actionItems : [])
    .map((x) => (typeof x === 'string' ? { task: x, owner: '' } : { task: str(x && x.task), owner: str(x && x.owner) }))
    .filter((x) => x.task)
    .map((x) => ({ task: x.task, owner: NO_OWNER.test(x.owner) ? '' : x.owner }));
  return {
    title: str(o.title).replace(/^["'“]+|["'”]+$/g, '').slice(0, 200),
    tldr: str(o.tldr || o.summary),
    keyPoints: strList(o.keyPoints),
    decisions: strList(o.decisions),
    actionItems,
  };
}
const isEmptySummary = (s) => !s.title && !s.tldr && !s.keyPoints.length;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    tldr: { type: 'string' },
    keyPoints: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task: { type: 'string' }, owner: { type: 'string' } },
        required: ['task', 'owner'],
      },
    },
  },
  required: ['title', 'tldr', 'keyPoints', 'decisions', 'actionItems'],
};

const SUMMARY_INSTRUCTIONS = 'Write meeting notes as JSON with these fields:\n'
  + '- title: a short descriptive meeting title (max 8 words, no date)\n'
  + '- tldr: 1-3 sentences summarizing the meeting\n'
  + '- keyPoints: 3-8 short bullet points of what was discussed\n'
  + '- decisions: decisions that were made (empty array if none)\n'
  + '- actionItems: tasks someone agreed to do, each {"task", "owner"}; owner is the person\'s name if said, otherwise ""\n';

// Prompt for the final JSON; retries once on unreadable/empty output and once without
// the schema if this Chrome rejects responseConstraint.
async function promptSummary(base, prompt, signal) {
  let constrained = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    checkAbort(signal);
    let raw;
    try {
      raw = await promptOnce(base, constrained ? prompt : `${prompt}\nReply with only the JSON object, no other text.`,
        constrained ? { responseConstraint: SUMMARY_SCHEMA } : {}, signal);
    } catch (e) {
      if (isAbort(e) || e.name === 'QuotaExceededError') throw e;
      console.error('[ai] summary prompt failed', e);
      if (constrained && (e.name === 'NotSupportedError' || e.name === 'SyntaxError' || e.name === 'TypeError')) { constrained = false; continue; }
      if (attempt >= 1) throw e;
      continue;
    }
    const parsed = parseJsonLoose(raw);
    if (parsed) {
      const s = normalizeSummary(parsed);
      if (!isEmptySummary(s)) return s;
    }
    console.error('[ai] unreadable or empty summary from the model', String(raw).slice(0, 500));
    if (attempt >= 1) break;
  }
  throw friendly('The on-device model returned unreadable notes. Try Regenerate.');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
export async function summarize({ text, segments, lang, signal, onProgress }) {
  const progress = (p) => onProgress && onProgress(p);
  const source = String(text || (segments || []).map((s) => s.text).join('\n')).trim();
  if (!source) throw friendly('The transcript is empty.');
  let l = normLang(lang);
  if (!l || l === 'auto') l = await detectLanguage(source, guessLang(source));
  checkAbort(signal);

  const sourceHash = await sha256(text != null ? String(text) : source);
  const en = l === 'en' ? source : await toEnglish(source, l, signal, progress);
  checkAbort(signal);

  progress({ stage: 'start' });
  const base = await createSession(SYSTEM_SUMMARY, signal, progress);
  let result;
  try {
    const reserve = 1200; // instructions + JSON answer
    const room = budget(base, reserve);
    const finalPrompt = (body, what) => `${SUMMARY_INSTRUCTIONS}\n${what}:\n"""\n${body}\n"""`;
    const whole = finalPrompt(en, 'Transcript');
    const tokens = await measure(base, whole, signal);
    if (tokens <= room) {
      progress({ stage: 'summarize', part: 1, total: 1 });
      result = await promptSummary(base, whole, signal);
    } else {
      // Map: notes per chunk. Reduce: final JSON from the combined notes.
      let material = en;
      let ratio = en.length / Math.max(1, tokens); // chars per token
      for (let round = 0; round < 3; round++) {
        const chunkChars = Math.max(800, Math.floor(room * ratio * 0.85));
        const chunks = chunkText(material, chunkChars);
        const notes = [];
        for (let i = 0; i < chunks.length; i++) {
          checkAbort(signal);
          progress({ stage: 'summarize', part: i + 1, total: chunks.length });
          const res = await promptOnce(base,
            `This is part ${i + 1} of ${chunks.length} of a meeting transcript. Write short bullet notes of the topics, `
            + `facts, decisions and action items (with who will do them) in this part. Notes only, no intro.\n"""\n${chunks[i]}\n"""`,
            {}, signal);
          notes.push(String(res || '').trim());
        }
        material = notes.filter(Boolean).join('\n');
        const reducePrompt = finalPrompt(material, 'Notes from the meeting, in order');
        const t = await measure(base, reducePrompt, signal);
        if (t <= room || round === 2) {
          progress({ stage: 'reduce' });
          result = await promptSummary(base, reducePrompt, signal);
          break;
        }
        ratio = material.length / Math.max(1, t);
      }
    }
  } finally {
    try { base.destroy(); } catch { /* already gone */ }
  }

  if (l !== 'en') {
    progress({ stage: 'translate-back' });
    const flat = [result.title, result.tldr, ...result.keyPoints, ...result.decisions,
      ...result.actionItems.flatMap((a) => [a.task, a.owner])];
    const tr = await translateList(flat, 'en', l, signal);
    let i = 0;
    result = {
      title: tr[i++],
      tldr: tr[i++],
      keyPoints: result.keyPoints.map(() => tr[i++]),
      decisions: result.decisions.map(() => tr[i++]),
      actionItems: result.actionItems.map(() => ({ task: tr[i++], owner: tr[i++] })),
    };
  }

  return {
    version: 1,
    lang: l,
    ...result,
    qa: [],
    translations: {},
    sourceHash,
    createdAt: Date.now(),
    engine: 'chrome-builtin',
  };
}

// ---------------------------------------------------------------------------
// Ask the meeting
// ---------------------------------------------------------------------------
const STOP = new Set(('the and for are but not you all any can had her was one our out has have this that with what when where '
  + 'which who why how did does about from they them then than there their will would could should into your just also been '
  + 'were said say like very more some such only over').split(' '));
const words = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length >= 3 && !STOP.has(w));

// Keep the chunks that share the most words with the question, in transcript order.
function pickChunks(chunks, question, maxChars) {
  const q = new Set(words(question));
  const scored = chunks.map((c, i) => {
    const ws = words(c);
    let hit = 0;
    for (const w of ws) if (q.has(w)) hit++;
    return { i, c, score: hit / Math.sqrt(ws.length + 1) };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = [];
  let used = 0;
  for (const s of scored) {
    if (used + s.c.length > maxChars && picked.length) continue;
    picked.push(s);
    used += s.c.length;
  }
  return picked.sort((a, b) => a.i - b.i).map((s) => s.c);
}

// history: [{ q, a }] in the transcript language (last few are used as context).
export async function ask({ question, text, lang, history = [], signal, onProgress, onPartial }) {
  const progress = (p) => onProgress && onProgress(p);
  const q0 = String(question || '').trim();
  if (!q0) throw friendly('Type a question first.');
  const source = String(text || '').trim();
  if (!source) throw friendly('The transcript is empty.');
  let l = normLang(lang);
  if (!l || l === 'auto') l = await detectLanguage(source, guessLang(source));

  const en = await toEnglish(source, l, signal, progress);
  // Answer in the question's language, limited to the two languages we can translate.
  let qLang = l === 'en' ? 'en' : await detectLanguage(q0, guessLang(q0) === 'he' ? 'he' : l);
  if (qLang !== 'en' && qLang !== l) qLang = l;
  const q = qLang === 'en' ? q0 : (await translateText(q0, qLang, 'en', signal)).trim();
  let past = (history || []).slice(-3).filter((h) => h && h.q && h.a);
  if (l !== 'en' && past.length) {
    const flat = await translateList(past.flatMap((h) => [h.q, h.a]), l, 'en', signal);
    past = past.map((_, i) => ({ q: flat[i * 2], a: flat[i * 2 + 1] }));
  }
  checkAbort(signal);

  progress({ stage: 'answer' });
  const base = await createSession(SYSTEM_ASK, signal, progress);
  let answer = '';
  try {
    const pastText = past.map((h) => `Q: ${h.q}\nA: ${h.a}`).join('\n');
    const build = (ctx, partial) => `Meeting transcript${partial ? ' (most relevant parts)' : ''}:\n"""\n${ctx}\n"""\n`
      + (pastText ? `Earlier questions:\n${pastText}\n` : '')
      + `Question: ${q}\nAnswer:`;
    const room = budget(base, 600);
    let prompt = build(en, false);
    const tokens = await measure(base, prompt, signal);
    if (tokens > room) {
      const ratio = en.length / Math.max(1, tokens);
      const maxChars = Math.floor(room * ratio * 0.8);
      const chunks = chunkText(en, Math.max(500, Math.floor(maxChars / 4)));
      prompt = build(pickChunks(chunks, q, maxChars).join('\n…\n'), true);
    }
    const s = await base.clone({ signal });
    try {
      if (onPartial && l === 'en' && s.promptStreaming) {
        for await (const chunk of s.promptStreaming(prompt, { signal })) {
          answer += chunk;
          onPartial(answer);
        }
      } else {
        answer = await s.prompt(prompt, { signal });
      }
    } finally { try { s.destroy(); } catch { /* already gone */ } }
  } finally {
    try { base.destroy(); } catch { /* already gone */ }
  }
  answer = String(answer || '').trim();
  if (!answer) throw friendly('The on-device model returned an empty answer. Try rephrasing.');
  if (qLang !== 'en') {
    progress({ stage: 'translate-back' });
    answer = (await translateText(answer, 'en', qLang, signal)).trim();
  }
  return answer;
}

// ---------------------------------------------------------------------------
// Hash + Markdown
// ---------------------------------------------------------------------------
export async function sha256(text) {
  const data = new TextEncoder().encode(String(text ?? ''));
  if (window.crypto && window.crypto.subtle) {
    const buf = await window.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Insecure context (no crypto.subtle): FNV-1a, still stable for change detection.
  let h = 0x811c9dc5;
  for (const b of data) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return `fnv1a-${h.toString(16)}-${data.length}`;
}

function fmtDateLong(ts) {
  try { return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(ts); }
}
function fmtLen(ms) {
  if (!ms && ms !== 0) return '';
  return fmtStamp(Math.round(ms / 1000));
}

// recording: list item ({ name, created, duration }); summary may be null;
// transcript: segments array, plain text, or null to leave the transcript out.
export function buildMarkdown(recording, summary, transcript) {
  const r = recording || {};
  const s = summary || {};
  const lines = [];
  const title = s.title || r.name || 'Meeting notes';
  lines.push(`# ${title}`, '');
  if (r.name && r.name !== title) lines.push(`- Recording: ${r.name}`);
  if (r.created) lines.push(`- Date: ${fmtDateLong(r.created)}`);
  if (r.duration != null) lines.push(`- Duration: ${fmtLen(r.duration)}`);
  if (lines[lines.length - 1] !== '') lines.push('');
  if (s.tldr) lines.push('## TL;DR', '', s.tldr, '');
  const list = (head, items) => { if (items && items.length) lines.push(`## ${head}`, '', ...items.map((x) => `- ${x}`), ''); };
  list('Key points', s.keyPoints);
  list('Decisions', s.decisions);
  if (s.actionItems && s.actionItems.length) {
    lines.push('## Action items', '', ...s.actionItems.map((a) => `- [ ] ${a.task}${a.owner ? ` — ${a.owner}` : ''}`), '');
  }
  if (Array.isArray(transcript) && transcript.length) {
    lines.push('## Transcript', '');
    for (const seg of transcript) lines.push(`[${fmtStamp(seg.start)}] ${String(seg.text || '').trim()}`, '');
  } else if (typeof transcript === 'string' && transcript.trim()) {
    lines.push('## Transcript', '', transcript.trim(), '');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
