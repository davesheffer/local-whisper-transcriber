"""
Persistent Whisper worker process.

Stays alive between transcriptions so the model only loads ONCE per worker.
Communicates over stdin/stdout using newline-delimited JSON.

Inbound commands (one JSON object per line on stdin):
  {"action": "transcribe", "jobId": "...", "file": "/path/to/audio", "language": "he"}
  {"action": "cancel", "jobId": "..."}
  {"action": "ping"}
  {"action": "shutdown"}

Outbound messages (one JSON object per line on stdout, all tagged with jobId
when relevant):
  {"type": "ready", "model": "base", "device": "cuda"}
  {"type": "status",   "jobId": "...", "message": "..."}
  {"type": "info",     "jobId": "...", "total_duration": 123.4, "language": "he"}
  {"type": "progress", "jobId": "...", "percent": 42}
  {"type": "segment",  "jobId": "...", "text": "...", "start_time": 0.0, "end_time": 4.2}
  {"type": "complete", "jobId": "...", "text": "...", "language": "he"}
  {"type": "cancelled","jobId": "..."}
  {"type": "error",    "jobId": "...", "error": "..."}
"""

import json
import os
from pathlib import Path
import sys
import threading
import time
import traceback
import warnings

# Force UTF-8 on stdin/stdout so Hebrew (and any non-ASCII text) survives the
# trip to Node on Windows, where the default console codepage is cp1252.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

warnings.filterwarnings("ignore")

# CTranslate2 runs inference; a CPU-only PyTorch installation says nothing
# about whether CTranslate2 can use CUDA (and PyTorch is not required).
import ctranslate2
import numpy as np
from faster_whisper import WhisperModel

try:
    from faster_whisper import BatchedInferencePipeline
    _HAS_BATCHED = True
except Exception:
    BatchedInferencePipeline = None
    _HAS_BATCHED = False


def emit(obj):
    """Emit one JSON object as a single line, flushed."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    """Human-readable log to stderr (not parsed by Node)."""
    sys.stderr.write(f"[worker] {msg}\n")
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# Cancellation state — set by stdin reader, polled by the transcription loop.
# ---------------------------------------------------------------------------
_cancel_lock = threading.Lock()
_cancel_for_job = set()  # jobIds requested to cancel


def request_cancel(job_id):
    with _cancel_lock:
        _cancel_for_job.add(job_id)


def is_cancelled(job_id):
    with _cancel_lock:
        return job_id in _cancel_for_job


def clear_cancel(job_id):
    with _cancel_lock:
        _cancel_for_job.discard(job_id)


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------
_dll_directories = []  # Keep Windows DLL directory handles alive.


def configure_cuda_libraries():
    """Find optional NVIDIA pip wheels without changing the system PATH."""
    if os.name != "nt":
        return
    directories = []
    for root in sys.path:
        for package in ("cublas", "cudnn", "cuda_nvrtc", "cuda_runtime"):
            directory = Path(root) / "nvidia" / package / "bin"
            if directory.is_dir() and str(directory) not in directories:
                directories.append(str(directory))
                _dll_directories.append(os.add_dll_directory(str(directory)))
    if directories:
        os.environ["PATH"] = os.pathsep.join(directories + [os.environ.get("PATH", "")])


def load_model(model_name):
    """
    Load faster-whisper with the fastest sensible settings for the available
    hardware:
      - CUDA + float16 (or int8_float16) if a GPU is present
      - CPU + int8 otherwise (quantized, multi-threaded)

    Returns (transcriber, device) where `transcriber` is either a WhisperModel
    or a BatchedInferencePipeline wrapping one. Both expose `.transcribe(...)`.
    """
    configure_cuda_libraries()
    requested_device = os.environ.get("WHISPER_DEVICE", "auto").lower()
    if requested_device not in ("auto", "cpu", "cuda"):
        raise ValueError("WHISPER_DEVICE must be auto, cpu, or cuda")
    device = requested_device
    if device == "auto":
        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"

    def create(device):
        compute_type = os.environ.get(
            "WHISPER_COMPUTE_TYPE", "int8_float16" if device == "cuda" else "int8"
        )
        log(f"Loading {model_name} on {device} compute_type={compute_type}")
        kwargs = {"device": device, "compute_type": compute_type, "num_workers": 1}
        if device == "cpu":
            kwargs["cpu_threads"] = max(1, int(os.environ.get(
                "WHISPER_CPU_THREADS", str(os.cpu_count() or 4)
            )))
        loaded = WhisperModel(model_name, **kwargs)
        if device == "cuda":
            # CUDA DLLs can load lazily. Exercise the encoder before announcing
            # readiness so missing cuBLAS/cuDNN fails here, not on the first file.
            features = loaded.feature_extractor
            loaded.encode(np.zeros(
                (features.mel_filters.shape[0], features.nb_max_frames), dtype=np.float32
            ))
        return loaded

    try:
        model = create(device)
    except (RuntimeError, OSError) as exc:
        if device != "cuda" or requested_device != "auto":
            raise
        log(f"CUDA initialization failed: {exc}. Falling back to CPU; "
            "install server/requirements-gpu.txt for NVIDIA libraries.")
        device = "cpu"
        model = create(device)

    # Wrap in a BatchedInferencePipeline when available — this runs VAD-detected
    # segments through the model in parallel, often 2-4x faster on GPU.
    use_batched = _HAS_BATCHED and os.environ.get("WHISPER_BATCHED", "1") != "0"
    if use_batched:
        try:
            transcriber = BatchedInferencePipeline(model=model)
            log("Using BatchedInferencePipeline")
            return transcriber, device
        except Exception as e:
            log(f"BatchedInferencePipeline unavailable ({e}); falling back to sequential")

    return model, device


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------
def run_transcription(model, job):
    job_id = job.get("jobId")
    file_path = job["file"]
    language = job.get("language") or "he"
    started = time.perf_counter()
    first_segment_seconds = None

    if is_cancelled(job_id):
        emit({"type": "cancelled", "jobId": job_id})
        clear_cancel(job_id)
        return

    if not os.path.exists(file_path):
        emit({"type": "error", "jobId": job_id, "error": f"File not found: {file_path}"})
        return

    try:
        emit({"type": "status", "jobId": job_id, "message": "Starting transcription..."})

        # Fast settings:
        #   beam_size=1                       -> greedy decoding, much faster
        #   condition_on_previous_text=False  -> avoids slow context drift, reduces hallucinations
        #   vad_filter=True                   -> skips silence (huge for real recordings)
        common_kwargs = dict(
            language=language,
            beam_size=1,
            without_timestamps=False,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )

        if isinstance(model, BatchedInferencePipeline) if _HAS_BATCHED else False:
            batch_size = int(os.environ.get("WHISPER_BATCH_SIZE", "8"))
            segments, info = model.transcribe(
                file_path,
                batch_size=batch_size,
                **common_kwargs,
            )
        else:
            segments, info = model.transcribe(
                file_path,
                best_of=1,
                temperature=0.0,
                condition_on_previous_text=False,
                **common_kwargs,
            )

        total_duration = float(getattr(info, "duration", 0.0) or 0.0)
        detected_language = getattr(info, "language", language)

        emit({
            "type": "info",
            "jobId": job_id,
            "total_duration": total_duration,
            "language": detected_language,
        })

        collected = []
        chunk_index = 0
        last_percent = -1

        for segment in segments:
            if is_cancelled(job_id):
                emit({"type": "cancelled", "jobId": job_id})
                clear_cancel(job_id)
                return

            chunk_index += 1
            text = (segment.text or "").strip()
            if text:
                if first_segment_seconds is None:
                    first_segment_seconds = time.perf_counter() - started
                collected.append(text)
                emit({
                    "type": "segment",
                    "jobId": job_id,
                    "chunk": chunk_index,
                    "text": text,
                    "start_time": float(segment.start),
                    "end_time": float(segment.end),
                })

            # Approximate progress from end-time / total duration.
            if total_duration > 0:
                percent = int(min(99, (segment.end / total_duration) * 100))
                if percent != last_percent:
                    last_percent = percent
                    emit({
                        "type": "progress",
                        "jobId": job_id,
                        "chunk": chunk_index,
                        "total_chunks": 0,  # unknown with streaming VAD
                        "percent": percent,
                    })

        final_text = " ".join(collected).strip()
        elapsed = time.perf_counter() - started
        metrics = {
            "elapsed_seconds": round(elapsed, 3),
            "audio_seconds": round(total_duration, 3),
            "first_segment_seconds": round(first_segment_seconds, 3) if first_segment_seconds is not None else None,
            "realtime_factor": round(elapsed / total_duration, 4) if total_duration > 0 else None,
        }
        log(f"Completed job {job_id}: {json.dumps(metrics)}")
        emit({
            "type": "complete",
            "jobId": job_id,
            "text": final_text,
            "language": detected_language,
            "metrics": metrics,
        })
    except Exception as e:
        emit({
            "type": "error",
            "jobId": job_id,
            "error": str(e),
            "traceback": traceback.format_exc(),
        })


# ---------------------------------------------------------------------------
# Stdin command reader (runs in a background thread so it can deliver
# cancellation messages while a transcription is running on the main thread).
# ---------------------------------------------------------------------------
_command_queue = []
_command_cv = threading.Condition()


def stdin_reader():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            log(f"Bad JSON on stdin: {line!r}")
            continue

        action = msg.get("action")
        if action == "cancel":
            jid = msg.get("jobId")
            if jid:
                request_cancel(jid)
                log(f"Cancel requested for job {jid}")
            continue

        # Everything else gets queued for the main loop to handle in order.
        with _command_cv:
            _command_queue.append(msg)
            _command_cv.notify()


def next_command():
    with _command_cv:
        while not _command_queue:
            _command_cv.wait()
        return _command_queue.pop(0)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    model_name = sys.argv[1] if len(sys.argv) > 1 else "base"

    try:
        model, device = load_model(model_name)
    except Exception as e:
        emit({
            "type": "error",
            "error": f"Failed to load model: {e}",
            "traceback": traceback.format_exc(),
        })
        sys.exit(1)

    underlying = model.model if _HAS_BATCHED and isinstance(model, BatchedInferencePipeline) else model
    emit({"type": "ready", "model": model_name, "device": device,
          "compute_type": underlying.model.compute_type})

    reader = threading.Thread(target=stdin_reader, daemon=True)
    reader.start()

    while True:
        try:
            cmd = next_command()
        except KeyboardInterrupt:
            break

        action = cmd.get("action")
        if action == "transcribe":
            run_transcription(model, cmd)
        elif action == "ping":
            emit({"type": "pong"})
        elif action == "shutdown":
            log("Shutdown requested")
            break
        else:
            emit({"type": "error", "error": f"Unknown action: {action}"})


if __name__ == "__main__":
    main()
