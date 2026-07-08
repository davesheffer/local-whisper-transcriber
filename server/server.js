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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
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
    workers.delete(modelName);
    for (const jobId of handle.activeJobIds) {
      const job = jobs.get(jobId);
      if (!job) continue;
      emitToClient(job.clientId, 'transcription-update', {
        type: 'error',
        error: `Worker for model "${modelName}" exited unexpectedly`,
      });
      finishJob(jobId);
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
    handle._resolveReady && handle._resolveReady();
    console.log(`[worker:${handle.modelName}] ready (device=${msg.device})`);
    return;
  }

  const jobId = msg.jobId;
  if (!jobId) return;
  const job = jobs.get(jobId);
  if (!job) return;

  emitToClient(job.clientId, 'transcription-update', msg);

  if (msg.type === 'complete') {
    if (!job.responded && job.res && !job.res.headersSent) {
      job.res.json({ text: msg.text, language: msg.language });
      job.responded = true;
    }
    finishJob(jobId);
  } else if (msg.type === 'cancelled') {
    if (!job.responded && job.res && !job.res.headersSent) {
      job.res.status(499).json({ error: 'Cancelled' });
      job.responded = true;
    }
    emitToClient(job.clientId, 'transcription-cancelled', {
      message: 'Transcription cancelled successfully',
    });
    finishJob(jobId);
  } else if (msg.type === 'error') {
    if (!job.responded && job.res && !job.res.headersSent) {
      job.res.status(500).json({ error: msg.error || 'Transcription failed' });
      job.responded = true;
    }
    finishJob(jobId);
  }
}

function finishJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  const worker = workers.get(job.modelName);
  if (worker) worker.activeJobIds.delete(jobId);
  if (job.filePath) {
    fs.unlink(job.filePath, (err) => {
      if (err && err.code !== 'ENOENT') console.warn('cleanup error:', err.message);
    });
  }
  jobs.delete(jobId);
}

// -----------------------------------------------------------------------------
// HTTP / Socket setup
// -----------------------------------------------------------------------------
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

app.use(cors({ origin: /^http:\/\/localhost:\d+$/ }));
app.use(express.json());

function cancelJobsForClient(clientId) {
  if (!clientId) return;
  for (const [jobId, job] of jobs.entries()) {
    if (job.clientId !== clientId) continue;
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
    status[name] = { ready: w.ready, active: w.activeJobIds.size };
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

server.listen(PORT, () => {
  console.log(`[>] Transcription server on http://localhost:${PORT}`);
  console.log(`[✓] Health: http://localhost:${PORT}/api/health`);
  server.timeout = 7200000;
  server.keepAliveTimeout = 7200000;
  server.headersTimeout = 7210000;

  // Pre-warm the default model so the first transcription starts instantly.
  const preload = process.env.WHISPER_PRELOAD || 'base';
  console.log(`[~] Pre-warming model: ${preload} (max resident workers: ${MAX_WORKERS || 'unlimited'})`);
  getWorker(preload);
  touchWorker(preload);
});
