"""Device selection regressions; no model downloads or GPU required."""
import os
import unittest
from unittest.mock import MagicMock, patch

import whisper_worker as worker
from faster_whisper.feature_extractor import FeatureExtractor


class DeviceSelectionTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"WHISPER_BATCHED": "0"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    @patch.object(worker, "configure_cuda_libraries")
    @patch.object(worker.ctranslate2, "get_cuda_device_count", return_value=1)
    @patch.object(worker, "WhisperModel")
    def test_auto_uses_ctranslate_cuda_without_pytorch(self, factory, *_):
        factory.return_value.feature_extractor = FeatureExtractor(feature_size=80)
        model, device = worker.load_model("base")
        self.assertEqual(device, "cuda")
        self.assertEqual(factory.call_args.kwargs["compute_type"], "int8_float16")
        model.encode.assert_called_once()
        self.assertEqual(model.encode.call_args.args[0].shape, (80, 3000))

    @patch.object(worker, "configure_cuda_libraries")
    @patch.object(worker.ctranslate2, "get_cuda_device_count", return_value=1)
    @patch.object(worker, "WhisperModel")
    def test_missing_cuda_library_falls_back_before_ready(self, factory, *_):
        gpu = MagicMock()
        gpu.feature_extractor = FeatureExtractor(feature_size=128)
        gpu.encode.side_effect = RuntimeError("cudnn64_9.dll missing")
        cpu = MagicMock()
        factory.side_effect = [gpu, cpu]
        model, device = worker.load_model("large-v3")
        self.assertIs(model, cpu)
        self.assertEqual(device, "cpu")
        self.assertEqual(factory.call_args.kwargs["compute_type"], "int8")
        cpu.encode.assert_not_called()

    @patch.object(worker, "configure_cuda_libraries")
    @patch.object(worker, "WhisperModel", side_effect=RuntimeError("CUDA unavailable"))
    def test_explicit_cuda_does_not_silently_fall_back(self, factory, *_):
        os.environ["WHISPER_DEVICE"] = "cuda"
        with self.assertRaisesRegex(RuntimeError, "CUDA unavailable"):
            worker.load_model("base")
        factory.assert_called_once()

    @patch.object(worker, "configure_cuda_libraries")
    @patch.object(worker.ctranslate2, "get_cuda_device_count")
    @patch.object(worker, "WhisperModel")
    def test_explicit_cpu_skips_gpu_and_honors_threads(self, factory, count, *_):
        os.environ.update(WHISPER_DEVICE="cpu", WHISPER_CPU_THREADS="6")
        _, device = worker.load_model("base")
        self.assertEqual(device, "cpu")
        count.assert_not_called()
        self.assertEqual(factory.call_args.kwargs["cpu_threads"], 6)

    @patch.object(worker, "emit")
    def test_cancelled_queued_job_never_runs_inference(self, emit):
        model = MagicMock()
        worker.request_cancel("cancelled-before-start")
        worker.run_transcription(model, {"jobId": "cancelled-before-start", "file": "unused.wav"})
        model.transcribe.assert_not_called()
        emit.assert_called_once_with({"type": "cancelled", "jobId": "cancelled-before-start"})
        self.assertFalse(worker.is_cancelled("cancelled-before-start"))


if __name__ == "__main__":
    unittest.main()
