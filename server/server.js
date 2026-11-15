const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const readline = require('readline');
const crypto = require('crypto');
const os = require('os');
const { createStore } = require('./recordings');

// Loopback only by default: recordings and transcripts must not be reachable from the network.
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_BIND = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(HOST);
const LOCAL_HOST_HEADER = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
// DNS rebinding: a foreign site re-pointed at 127.0.0.1 is "same-origin" (no Origin header),
// but its requests still carry the foreign Host. Only enforced on a loopback bind; with
// HOST set to a LAN address the user has opted into network access.
const hostAllowed = (host) => !LOOPBACK_BIND || LOCAL_HOST_HEADER.test(host || '');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    cb(null, hostAllowed(req.headers.host) && (!origin || !LOOPBACK_BIND || LOCAL_ORIGIN.test(origin)));
  },
  cors: { origin: /^http:\/\/localhost:\d+$/, methods: ['GET', 'POST'] },
  // A long transcription must survive a brief network/CPU hiccup. Heavy models
  // (large-v3) peg the CPU, which can momentarily starve the client's heartbeat;
  // give the ping plenty of slack so the socket isn't declared dead and dropped.
  pingInterval: 25000,
  pingTimeout: 60000,
});
const PORT = 5000;
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const WORKER_SCRIPT = path.join(__dirname, 'whisper_worker.py');
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(os.homedir(), 'Documents', 'Meeting Recordings');
const BUILD_DIR = path.join(__dirname, '..', 'build');
const store = createStore(RECORDINGS_DIR);

// -----------------------------------------------------------------------------
// Persistent worker pool
// -----------------------------------------------------------------------------
// One long-lived Python process per model. The model loads once, then every
// transcription reuses it. Workers communicate over stdin/stdout with
// newline-delimited JSON. Output messages carry a `jobId` so we can route them
// back to the right socket.
// -----------------------------------------------------------------------------
const workers = new Map(); // modelName -> WorkerHandle
const jobs = new Map();    // jobId -> { clientId, filePath, modelName, res, responded }

// Route a message to a client's room. Progress is keyed by a stable per-tab
// clientId (not socket.id) so updates survive socket reconnects.
function emitToClient(clientId, event, payload) {
  if (clientId) io.to('client:' + clientId).emit(event, payload);
}

function createWorker(modelName) {
  console.log(`[worker:${modelName}] spawning...`);
  const proc = spawn(PYTHON_BIN, ['-u', WORKER_SCRIPT, modelName], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });

  proc.stdout.setEncoding('utf8');
  proc.stdin.setDefaultEncoding('utf8');

  const handle = {
    modelName,
    proc,
    ready: false,
    readyPromise: null,
    activeJobIds: new Set(),
  };

  handle.readyPromise = new Promise((resolve, reject) => {
    handle._resolveReady = resolve;
    handle._rejectReady = reject;
  });

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.warn(`[worker:${modelName}] non-JSON line: ${line}`);
      return;
    }
    handleWorkerMessage(handle, msg);
  });

  proc.on('exit', (code, signal) => {
    console.warn(`[worker:${modelName}] exited code=${code} signal=${signal}`);
    // An evicted worker can exit after a fresh one for the same model was spawned.
    if (workers.get(modelName) === handle) workers.delete(modelName);
    for (const jobId of handle.activeJobIds) {
      const job = jobs.get(jobId);
      if (!job) continue;
      const msg = {
        type: 'error',
        error: `Worker for model "${modelName}" exited unexpectedly`,
      };
      if (!job.recordingId) emitToClient(job.clientId, 'transcription-update', msg);
      finishJob(jobId, msg);
    }
    if (!handle.ready && handle._rejectReady) {
      handle._rejectReady(new Error(`Worker exited before ready (code=${code})`));
    }
  });

  workers.set(modelName, handle);
  return handle;
}

function getWorker(modelName) {
  let h = workers.get(modelName);
  if (!h) h = createWorker(modelName);
  return h;
}

// Keep at most this many models resident at once. Evicts the least-recently
// touched *idle* worker (one with no active jobs) when a new model is loaded.
// Set WHISPER_MAX_WORKERS=0 to keep them all alive (uses more RAM).
const MAX_WORKERS = parseInt(process.env.WHISPER_MAX_WORKERS || '1', 10);
const lruOrder = []; // modelNames, most-recently used last

function touchWorker(modelName) {
  const i = lruOrder.indexOf(modelName);
  if (i >= 0) lruOrder.splice(i, 1);
  lruOrder.push(modelName);
  evictIfNeeded();
}

function evictIfNeeded() {
  if (MAX_WORKERS <= 0) return;
  while (lruOrder.length > MAX_WORKERS) {
    // Find oldest model whose worker has no active jobs.
    let victimIdx = -1;
    for (let i = 0; i < lruOrder.length; i++) {
      const w = workers.get(lruOrder[i]);
      if (w && w.activeJobIds.size === 0) { victimIdx = i; break; }
    }
    if (victimIdx < 0) return; // everything is busy; try again later
    const [victim] = lruOrder.splice(victimIdx, 1);
    const w = workers.get(victim);
    if (w) {
      console.log(`[worker:${victim}] evicting (LRU)`);
      try { sendToWorker(w, { action: 'shutdown' }); } catch (_) {}
      setTimeout(() => { try { w.proc.kill(); } catch (_) {} }, 1000);
      workers.delete(victim);
    }
  }
}

function sendToWorker(handle, obj) {
  handle.proc.stdin.write(JSON.stringify(obj) + '\n');
}

function handleWorkerMessage(handle, msg) {
  if (msg.type === 'ready') {
    handle.ready = true;
    handle.device = msg.device;
    handle.computeType = msg.compute_type;
    handle._resolveReady && handle._resolveReady();
    console.log(`[worker:${handle.modelName}] ready (device=${msg.device})`);
    return;
  }

  const jobId = msg.jobId;
  if (!jobId) return;
  const job = jobs.get(jobId);
  if (!job || job.finishing) return;

  // Recording jobs report via recording-progress / recording-updated only, so they
  // never leak into the file tab's transcription-update handler.
  if (!job.recordingId) emitToClient(job.clientId, 'transcription-update', msg);
  if (job.recordingId && (msg.type === 'progress' || msg.type === 'status' || msg.type === 'info')) {
    io.emit('recording-progress', { id: job.recordingId, percent: msg.percent, message: msg.message });
  }
  if (job.segments && msg.type === 'segment') {
    job.segments.push({ start: msg.start_time, end: msg.end_time, text: msg.text });
  }

  if (msg.type === 'complete') {
    if (!job.responded && job.res && !job.res.headersSent) {
      job.res.json({ text: msg.text, language: msg.language, metrics: msg.metrics });
      job.responded = true;
    }
    finishJob(jobId, msg);
  } else if (msg.type === 'cancelled') {
    if (!job.responded && job.res && !job.res.headersSent) {
      job.res.status(499).json({ error: 'Cancelled' });
      job.responded = true;
    }
    if (!job.recordingId) emitToClient(job.clientId, 'transcription-cancelled', {
      message: 'Transcription cancelled successfully',
    });
    finishJob(jobId, msg);
  } else if (msg.type === 'error') {
    if (!job.responded && job.res && !job.res.headersSent) {
      job.res.status(500).json({ error: msg.error || 'Transcription failed' });
      job.responded = true;
    }
    finishJob(jobId, msg);
  }
}

// `finalMsg` is the worker message that ended the job (complete/cancelled/error).
// If onDone returns a promise (recording jobs saving their result), the job stays registered,
// marked `finishing`, until it settles: findRecordingJob keeps answering 409 to edits meanwhile.
function finishJob(jobId, finalMsg) {
  const job = jobs.get(jobId);
  if (!job || job.finishing) return;
  job.finishing = true;
  const worker = workers.get(job.modelName);
  if (worker) worker.activeJobIds.delete(jobId);
  let pending = null;
  if (job.onDone) {
    try { pending = job.onDone(finalMsg || { type: 'error', error: 'Transcription aborted' }); } catch (e) { console.warn('onDone error:', e.message); }
  }
  if (job.filePath && !job.keepFile) {
    fs.unlink(job.filePath, (err) => {
      if (err && err.code !== 'ENOENT') console.warn('cleanup error:', err.message);
    });
  }
  if (pending && typeof pending.then === 'function') {
    Promise.resolve(pending).catch(() => {}).then(() => jobs.delete(jobId));
  } else {
    jobs.delete(jobId);
  }
}

// -----------------------------------------------------------------------------
// HTTP / Socket setup
// -----------------------------------------------------------------------------
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

app.use((req, res, next) => {
  if (!hostAllowed(req.get('host'))) return res.status(403).send('Forbidden host');
  next();
});
app.use(cors({ origin: /^http:\/\/localhost:\d+$/ }));
// Transcript edits and AI notes can be megabytes: those PUTs get their own 5 MB parser at the
// route (after the Origin check); every other route keeps the default 100 kb limit.
const BIG_JSON_ROUTE = /^\/api\/recordings\/[^/]+\/(transcript|summary)\/?$/i;
const bigJson = express.json({ limit: '5mb' });
const smallJson = express.json();
app.use((req, res, next) => (req.method === 'PUT' && BIG_JSON_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

// Serve the built React app (installable PWA) from the same origin as the API.
// Without a build (dev: `npm start` on :3000) the plain welcome page below is used.
if (fs.existsSync(path.join(BUILD_DIR, 'index.html'))) {
  app.use(express.static(BUILD_DIR, {
    setHeaders: (res, p) => {
      if (/(index\.html|sw\.js|manifest\.json)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
}

function cancelJobsForClient(clientId) {
  if (!clientId) return;
  for (const [jobId, job] of jobs.entries()) {
    // Recording jobs have their own cancel endpoint; the file tab's Stop must not kill them.
    if (job.clientId !== clientId || job.recordingId) continue;
    const worker = workers.get(job.modelName);
    if (worker) sendToWorker(worker, { action: 'cancel', jobId });
  }
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // The browser sends a stable, per-tab clientId. We join a room keyed by it so
  // that a socket which drops and auto-reconnects (new socket.id) keeps getting
  // live updates for any job already in flight.
  socket.on('register', (clientId) => {
    if (typeof clientId === 'string' && clientId) {
      socket.data.clientId = clientId;
      socket.join('client:' + clientId);
    }
  });

  // Explicit Stop button — the ONLY socket event that cancels work.
  socket.on('cancel-transcription', () => {
    cancelJobsForClient(socket.data.clientId);
  });

  // A websocket disconnect is NOT a cancellation. The progress socket is only a
  // side channel; the real request is the HTTP POST, and cancellation is driven
  // from that request's lifecycle (see /api/transcribe). A transient blip used
  // to kill in-flight transcriptions here — that was the "stops in the middle"
  // bug. The client auto-reconnects and re-registers to resume live updates.
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

app.get('/', (req, res) => {
  res.send(`<h1>Local Whisper Transcriber</h1><p>OK on port ${PORT}</p>`);
});

app.get('/api/health', (req, res) => {
  const status = {};
  for (const [name, w] of workers.entries()) {
    status[name] = {
      ready: w.ready, active: w.activeJobIds.size,
      device: w.device || null, compute_type: w.computeType || null,
    };
  }
  res.json({ status: 'ok', workers: status });
});

// Pre-load a model without doing a transcription.
app.post('/api/warmup', async (req, res) => {
  const model = (req.body && req.body.model) || 'base';
  const w = getWorker(model);
  touchWorker(model);
  try {
    await w.readyPromise;
    res.json({ ok: true, model });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = req.file.path;
  const model = req.body.model || 'base';
  const clientId = req.body.clientId;
  const language = req.body.language || 'he';
  const jobId = crypto.randomUUID();

  console.log(`[job ${jobId}] file=${req.file.originalname} model=${model}`);

  const worker = getWorker(model);

  jobs.set(jobId, {
    clientId,
    filePath,
    modelName: model,
    res,
    responded: false,
  });

  // Reserve the job on the worker BEFORE touching the LRU, so a concurrent model
  // switch/warmup can't evict this worker out from under us while it's loading.
  worker.activeJobIds.add(jobId);
  touchWorker(model);

  // Tie the job's lifetime to THIS HTTP request. If the client aborts it (tab
  // closed / navigated away) before we respond, cancel the work. A dropped
  // progress *websocket* does NOT close this request, so transient blips no
  // longer cancel transcriptions.
  res.on('close', () => {
    const job = jobs.get(jobId);
    if (job && !job.responded) {
      const w = workers.get(job.modelName);
      if (w) sendToWorker(w, { action: 'cancel', jobId });
    }
  });

  try {
    if (!worker.ready) {
      emitToClient(clientId, 'transcription-update', {
        type: 'status',
        jobId,
        message: `Loading ${model} model (one-time)...`,
      });
      await worker.readyPromise;
    }

    sendToWorker(worker, {
      action: 'transcribe',
      jobId,
      file: filePath,
      language,
    });
  } catch (e) {
    finishJob(jobId);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------------------
// Recordings (meeting recorder): stored on disk, transcribed in the background
// -----------------------------------------------------------------------------
// Recordings are private: refuse requests a foreign website makes from the user's browser
// (multipart POSTs need no CORS preflight). Same-origin and non-browser local calls pass.
app.use('/api/recordings', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && LOOPBACK_BIND && !LOCAL_ORIGIN.test(origin)) return res.status(403).json({ error: 'Forbidden origin' });
  next();
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!e.status) console.error('[recordings]', e);
  if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
});

const recordingUpload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB (~60h of Opus at 128kbps)
});

function announce(id) {
  io.emit('recording-updated', { id });
}

function findRecordingJob(recordingId) {
  for (const [jobId, job] of jobs.entries()) if (job.recordingId === recordingId) return jobId;
  return null;
}

async function transcribeRecording(meta, { model, language, clientId }) {
  const jobId = crypto.randomUUID();
  const announced = (p) => p
    .then(() => announce(meta.id))
    .catch((e) => console.warn(`[recordings] ${meta.id}: ${e.message}`));
  const update = (patch) => announced(store.setTranscript(meta.id, patch));
  const segments = []; // from `segment` messages; written only when the job completes

  const worker = getWorker(model);
  jobs.set(jobId, {
    clientId,
    filePath: store.audioPath(meta),
    keepFile: true,
    recordingId: meta.id,
    modelName: model,
    res: null,
    responded: true,
    segments,
    // Returns the store write so finishJob keeps the job registered until it is on disk.
    onDone: (msg) => {
      if (msg.type === 'complete') {
        const saved = store.completeTranscript(meta.id, {
          status: 'done', text: msg.text || '', detectedLanguage: msg.language || null, finishedAt: Date.now(), error: null,
        }, segments).catch((e) => {
          // Never leave the recording "running" with no job behind it.
          console.warn(`[recordings] ${meta.id}: could not save transcript: ${e.message}`);
          return store.setTranscript(meta.id, { status: 'error', error: 'Could not save transcript', finishedAt: Date.now() });
        });
        return announced(saved);
      }
      if (msg.type === 'cancelled') return update({ status: 'cancelled', finishedAt: Date.now() });
      return update({ status: 'error', error: msg.error || 'Transcription failed', finishedAt: Date.now() });
    },
  });
  worker.activeJobIds.add(jobId);
  touchWorker(model);
  await update({ status: 'running', model, language, jobId, startedAt: Date.now(), finishedAt: null, error: null });

  (async () => {
    try {
      if (!worker.ready) {
        io.emit('recording-progress', { id: meta.id, message: `Loading ${model} model (one-time)...` });
        await worker.readyPromise;
      }
      const job = jobs.get(jobId);
      if (!job || job.finishing) return; // cancelled while the model was loading
      sendToWorker(worker, { action: 'transcribe', jobId, file: store.audioPath(meta), language });
    } catch (e) {
      finishJob(jobId, { type: 'error', error: e.message });
    }
  })();
  return jobId;
}

app.get('/api/recordings', wrap(async (req, res) => {
  res.json({ dir: store.dir, recordings: await store.list() });
}));

app.post('/api/recordings', recordingUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const meta = await store.save({
      tmpPath: req.file.path,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      name: req.body.name,
      duration: req.body.duration,
      created: req.body.created,
    });
    announce(meta.id);
    res.status(201).json(meta);
  } catch (e) {
    // Keep the upload: it may be the only server-side copy of the recording.
    console.error(`[recordings] save failed, upload kept at ${req.file.path}: ${e.message}`);
    e.message = `Could not save recording (${e.message}). The upload was kept at ${req.file.path}`;
    throw e;
  }
}));

app.get('/api/recordings/:id/audio', wrap(async (req, res) => {
  const meta = await store.get(req.params.id);
  const download = req.query.download === '1';
  if (download) {
    const safe = meta.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || meta.id;
    res.attachment(`${safe}.${meta.ext}`);
  }
  // root + relative name: an absolute path with a dot-folder (e.g. ~/.recordings) would 404.
  res.sendFile(meta.file, { root: store.dir });
}));

app.get('/api/recordings/:id/transcript', wrap(async (req, res) => {
  const meta = await store.get(req.params.id);
  const text = await store.readTranscript(meta.id);
  if (req.query.download === '1') {
    const safe = meta.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || meta.id;
    res.attachment(`${safe}.txt`);
  }
  res.type('text/plain; charset=utf-8').send(text);
}));

app.get('/api/recordings/:id/segments', wrap(async (req, res) => {
  res.json(await store.readSegments(req.params.id));
}));

app.put('/api/recordings/:id/transcript', bigJson, wrap(async (req, res) => {
  // No await between the check and editTranscript queueing on the recording's lock.
  if (findRecordingJob(req.params.id)) return res.status(409).json({ error: 'Wait for the transcription to finish before editing' });
  const meta = await store.editTranscript(req.params.id, req.body);
  announce(meta.id);
  res.json({ ok: true });
}));

app.get('/api/recordings/:id/summary', wrap(async (req, res) => {
  res.json(await store.readSummary(req.params.id));
}));

app.put('/api/recordings/:id/summary', bigJson, wrap(async (req, res) => {
  const meta = await store.putSummary(req.params.id, req.body);
  announce(meta.id);
  res.json({ ok: true });
}));

app.delete('/api/recordings/:id/summary', wrap(async (req, res) => {
  const meta = await store.deleteSummary(req.params.id);
  announce(meta.id);
  res.json({ ok: true });
}));

app.patch('/api/recordings/:id', wrap(async (req, res) => {
  const meta = await store.rename(req.params.id, req.body && req.body.name);
  announce(meta.id);
  res.json(meta);
}));

app.delete('/api/recordings/:id', wrap(async (req, res) => {
  const jobId = findRecordingJob(req.params.id);
  if (jobId) return res.status(409).json({ error: 'Stop the transcription before deleting' });
  await store.remove(req.params.id);
  announce(req.params.id);
  res.json({ ok: true, movedTo: path.join(store.dir, '_deleted') });
}));

app.post('/api/recordings/:id/transcribe', wrap(async (req, res) => {
  const meta = await store.get(req.params.id);
  if (findRecordingJob(meta.id)) return res.status(409).json({ error: 'Already transcribing' });
  const body = req.body || {};
  const model = typeof body.model === 'string' && body.model ? body.model : 'base';
  const language = typeof body.language === 'string' && body.language ? body.language : 'he';
  const jobId = await transcribeRecording(meta, { model, language, clientId: body.clientId });
  res.status(202).json({ jobId });
}));

app.post('/api/recordings/:id/cancel', wrap(async (req, res) => {
  const meta = await store.get(req.params.id);
  const jobId = findRecordingJob(meta.id);
  if (!jobId) return res.status(404).json({ error: 'No transcription running' });
  const job = jobs.get(jobId);
  if (job.finishing) return res.json({ ok: true }); // already ended; its result is being saved
  const w = workers.get(job.modelName);
  if (w && w.ready) sendToWorker(w, { action: 'cancel', jobId });
  else finishJob(jobId, { type: 'cancelled' }); // still loading the model: nothing queued yet
  res.json({ ok: true });
}));

// Errors that escape a route (body-parser, multer, ...) as JSON with a fitting status, no stack.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = Number(err.status || err.statusCode);
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') status = 413;
  else if (err.type === 'entity.parse.failed') status = 400;
  if (!(status >= 400 && status < 600)) status = 500;
  if (status >= 500) console.error('[server]', err);
  res.status(status).json({ error: err.message || 'Request failed' });
});

function shutdown() {
  console.log('Shutting down workers...');
  for (const w of workers.values()) {
    try { sendToWorker(w, { action: 'shutdown' }); } catch (_) {}
    try { w.proc.kill(); } catch (_) {}
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Mark leftovers from a previous run BEFORE accepting requests, so the scan can't
// race a transcription started in the first milliseconds.
store.markInterrupted()
  .then((n) => n && console.log(`[~] Marked ${n} unfinished transcription(s) as interrupted`))
  .catch((e) => console.warn('[recordings] startup scan failed:', e.message))
  .then(() => server.listen(PORT, HOST, () => {
  console.log(`[>] Transcription server on http://localhost:${PORT}`);
  console.log(`[✓] Health: http://localhost:${PORT}/api/health`);
  console.log(`[✓] Recordings: ${RECORDINGS_DIR}`);
  server.timeout = 7200000;
  server.keepAliveTimeout = 7200000;
  server.headersTimeout = 7210000;

  // Pre-warm the default model so the first transcription starts instantly.
  const preload = process.env.WHISPER_PRELOAD || 'base';
  console.log(`[~] Pre-warming model: ${preload} (max resident workers: ${MAX_WORKERS || 'unlimited'})`);
  getWorker(preload);
  touchWorker(preload);
}));
