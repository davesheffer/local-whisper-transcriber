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


def fake_segment(start, end, text, compression_ratio=1.5):
    return MagicMock(start=start, end=end, text=text, compression_ratio=compression_ratio)


class GapRecoveryTests(unittest.TestCase):
    def test_find_gaps_reports_uncovered_stretches_including_edges(self):
        spans = [(5.0, 10.0), (11.0, 20.0), (8.0, 12.0), (40.0, 50.0)]
        self.assertEqual(worker.find_gaps(spans, 60.0, min_gap=3.0),
                         [(0.0, 5.0), (20.0, 40.0), (50.0, 60.0)])

    def test_find_gaps_ignores_short_pauses(self):
        self.assertEqual(worker.find_gaps([(0.0, 10.0), (12.0, 20.0)], 21.0, min_gap=3.0), [])

    @patch.object(worker, "emit")
    @patch.object(worker.os.path, "exists", return_value=True)
    @patch.object(worker, "decode_audio")
    def test_skipped_passage_is_retranscribed_and_merged_in_order(self, decode, _, emit):
        decode.return_value = worker.np.zeros(30 * worker.SAMPLE_RATE, dtype=worker.np.float32)
        fast_pass = ([fake_segment(0.0, 8.0, "first"), fake_segment(20.0, 30.0, "last")],
                     MagicMock(duration=30.0, language="he"))
        re_pass = ([fake_segment(1.0, 6.0, "middle"),
                    fake_segment(6.0, 11.0, "loop loop loop", compression_ratio=9.0)], None)
        model = MagicMock()
        model.transcribe.side_effect = [fast_pass, re_pass]

        worker.run_transcription(model, {"jobId": "gap", "file": "audio.m4a"})

        clip = model.transcribe.call_args_list[1].args[0]
        self.assertEqual(len(clip), 12 * worker.SAMPLE_RATE)
        self.assertEqual(model.transcribe.call_args_list[1].kwargs["beam_size"], 5)
        complete = emit.call_args_list[-1].args[0]
        self.assertEqual(complete["type"], "complete")
        self.assertEqual(complete["text"], "first middle last")
        self.assertEqual(complete["metrics"]["recovered_segments"], 1)

    @patch.object(worker, "emit")
    @patch.object(worker.os.path, "exists", return_value=True)
    @patch.object(worker, "decode_audio")
    def test_cancel_during_gap_recovery_stops_the_job(self, decode, _, emit):
        decode.return_value = worker.np.zeros(60 * worker.SAMPLE_RATE, dtype=worker.np.float32)

        def re_pass_segments():
            yield fake_segment(0.0, 5.0, "one")
            worker.request_cancel("cancel-in-gap")
            yield fake_segment(5.0, 10.0, "two")

        model = MagicMock()
        model.transcribe.side_effect = [([], MagicMock(duration=60.0, language="he")),
                                        (re_pass_segments(), None)]

        worker.run_transcription(model, {"jobId": "cancel-in-gap", "file": "audio.m4a"})

        self.assertEqual(emit.call_args_list[-1].args[0],
                         {"type": "cancelled", "jobId": "cancel-in-gap"})
        self.assertFalse(worker.is_cancelled("cancel-in-gap"))


if __name__ == "__main__":
    unittest.main()
