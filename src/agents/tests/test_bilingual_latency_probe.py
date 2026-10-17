"""Prevent queue/clock errors from turning diagnostic numbers into false latency."""

import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location(
    "latency_probe",
    Path(__file__).resolve().parents[1] / "scripts/probe_bilingual_latency.py",
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class TimelineTests(unittest.TestCase):
    """Use a controlled monotonic clock and real sample-rate units."""

    def setUp(self):
        """Start each independent trace at an arbitrary nonzero clock origin."""
        self.now = 100.0
        self.trace = probe.Timeline(clock=lambda: self.now)

    def test_silence_frames_do_not_replace_the_estimated_speech_end(self):
        """End time follows VAD samples, not the latest PCM arrival."""
        self.trace.mark("vad_start_of_speech")
        for _ in range(15):
            self.now += 0.1
            self.trace.sent(1600)
        event = SimpleNamespace(
            type=SimpleNamespace(value="end_of_speech"),
            samples_index=24000,
            silence_duration=0.5,
        )
        self.trace.vad(event)
        self.now += 0.2
        self.trace.mark("provider_first_audio")
        self.now += 0.3
        self.trace.mark("gateway_first_audio")
        summary = self.trace.report()["summary"]
        self.assertTrue(summary["single_utterance"])
        self.assertAlmostEqual(summary["end_detection_and_queue_ms"], 500)
        self.assertAlmostEqual(
            summary["estimated_speech_end_to_provider_first_audio_ms"], 700
        )
        self.assertAlmostEqual(summary["first_audio_hold_and_delivery_ms"], 300)

    def test_early_streamed_audio_keeps_a_negative_end_relative_latency(self):
        """Streaming before speech ends is valid and must not be clamped to zero."""
        self.trace.mark("vad_start_of_speech")
        self.now += 0.1
        self.trace.sent(1600)
        self.trace.mark("provider_first_audio")
        self.trace.mark("gateway_first_audio")
        self.now += 0.1
        self.trace.sent(1600)
        self.now += 0.5
        event = SimpleNamespace(
            type=SimpleNamespace(value="end_of_speech"),
            samples_index=11200,
            silence_duration=0.5,
        )
        self.trace.vad(event)
        self.assertAlmostEqual(
            self.trace.report()["summary"][
                "estimated_speech_end_to_gateway_first_audio_ms"
            ],
            -100,
        )

    def test_multiple_vad_turns_are_not_reported_as_one_sentence_latency(self):
        """Do not join a first response with the last of several utterances."""
        for _ in range(2):
            self.trace.mark("vad_start_of_speech")
            self.trace.mark("vad_end_of_speech", estimated_speech_end_sent_ms=0)
        self.trace.mark("provider_first_audio")
        self.trace.mark("gateway_first_audio")
        summary = self.trace.report()["summary"]
        self.assertFalse(summary["single_utterance"])
        self.assertNotIn("estimated_speech_end_to_gateway_first_audio_ms", summary)

    def test_delayed_vad_consumption_is_included_not_just_configured_silence(self):
        """Classifier blocking can leave already-generated detector events queued."""
        self.trace.sent(1600)
        self.now += 2
        event = SimpleNamespace(
            type=SimpleNamespace(value="end_of_speech"),
            samples_index=10400,
            silence_duration=0.55,
        )
        self.trace.vad(event)
        self.assertAlmostEqual(
            self.trace.stages[-1]["end_detection_and_queue_ms"], 2000
        )

    def test_first_audio_is_joined_to_the_delivered_item_without_exporting_ids(self):
        """An earlier suppressed response must not inflate another reply's gate."""
        self.trace.provider_audio("zh", "private-other")
        self.now += 1
        self.trace.provider_audio("en", "private-right")
        self.now += 0.2
        self.trace.gateway_audio("en:private-right")
        report = self.trace.report()
        self.assertAlmostEqual(
            report["summary"]["first_audio_hold_and_delivery_ms"], 200
        )
        self.assertNotIn("private-", str(report))
