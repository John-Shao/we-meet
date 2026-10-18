"""Prevent queue/clock errors from turning diagnostic numbers into false latency."""

import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "latency_probe",
    Path(__file__).resolve().parents[1] / "scripts/probe_bilingual_latency.py",
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
window_spec = importlib.util.spec_from_file_location(
    "turn_window_probe",
    Path(__file__).resolve().parents[1] / "scripts/probe_bilingual_turn_windows.py",
)
windows = importlib.util.module_from_spec(window_spec)
with patch.dict(sys.modules, {"probe_bilingual_latency": probe}):
    window_spec.loader.exec_module(windows)
prosody_spec = importlib.util.spec_from_file_location(
    "prosody_probe",
    Path(__file__).resolve().parents[1] / "scripts/probe_bilingual_prosody.py",
)
prosody = importlib.util.module_from_spec(prosody_spec)
with patch.dict(
    sys.modules,
    {
        "probe_bilingual_latency": probe,
        "probe_bilingual_turn_windows": windows,
    },
):
    prosody_spec.loader.exec_module(prosody)


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

    def test_provider_split_inside_one_vad_turn_is_not_single_reply_latency(self):
        """A provider can split a turn even when local VAD never emits an end."""
        self.trace.mark("vad_start_of_speech")
        self.trace.provider_audio("en", "first")
        self.trace.gateway_audio("en:first")
        self.trace.gateway_audio("en:first")
        self.trace.provider_audio("en", "second")
        self.trace.gateway_audio("en:second")
        self.trace.mark("vad_end_of_speech", estimated_speech_end_sent_ms=0)
        report = self.trace.report()
        self.assertFalse(report["summary"]["single_utterance"])
        self.assertNotIn(
            "estimated_speech_end_to_gateway_first_audio_ms", report["summary"]
        )
        self.assertEqual(
            sum(s["stage"] == "gateway_first_audio" for s in report["stages"]), 2
        )


class OutputWindowTests(unittest.TestCase):
    """Do not accept a first fragment as evidence that later speech was translated."""

    def test_first_reply_does_not_skip_the_post_input_observation(self):
        """A reply received during input must not terminate the quiet tail."""
        self.assertFalse(
            probe.output_settled(
                {"one": {"audio_end": True}},
                now=10,
                input_finished_at=9,
                last_output_at=5,
                settle_seconds=8,
            )
        )

    def test_pending_audio_and_new_fragments_extend_observation(self):
        """Finish only after every observed item ends and output becomes quiet."""
        events = {"one": {"audio_end": True}, "two": {"audio_end": False}}
        fields = {
            "now": 20,
            "input_finished_at": 10,
            "last_output_at": 15,
            "settle_seconds": 8,
        }
        self.assertFalse(probe.output_settled(events, **fields))

        events["two"]["audio_end"] = True
        self.assertTrue(probe.output_settled(events, **fields))
        fields["last_output_at"] = 19
        self.assertFalse(probe.output_settled(events, **fields))

    def test_empty_silence_does_not_count_as_a_completed_translation(self):
        """A long silent tail without any output still needs the bounded timeout."""
        self.assertFalse(
            probe.output_settled(
                {},
                now=30,
                input_finished_at=10,
                last_output_at=10,
                settle_seconds=8,
            )
        )


class PauseFixtureTests(unittest.TestCase):
    """Keep controlled stress fixtures distinct from naturally spoken pauses."""

    def test_pause_insertion_retains_all_original_samples_in_order(self):
        """A derived fixture must not truncate or replace words to create a gap."""
        pcm = bytes(range(100)) * 100
        rows = [
            {"type": "start_of_speech", "sample_index": 1000, "speech_samples": 500},
            {"type": "end_of_speech", "sample_index": 5000, "silence_samples": 1000},
        ]
        paused, midpoint = windows.paused_fixture(pcm, rows)
        split = midpoint * 2
        self.assertEqual(len(paused), len(pcm) + 16000)
        self.assertEqual(paused[:split], pcm[:split])
        self.assertEqual(paused[split : split + 16000], bytes(16000))
        self.assertEqual(paused[split + 16000 :], pcm[split:])

    def test_multiple_speech_spans_are_rejected_instead_of_guessed(self):
        """Reject an ambiguous fixture instead of guessing an insertion span."""
        with self.assertRaisesRegex(ValueError, "ambiguous_fixture_speech_span"):
            windows.paused_fixture(bytes(32000), [])


class CoverageTests(unittest.TestCase):
    """Separate lexical preservation indicators from segmentation and semantics."""

    def test_fragmented_travel_content_is_checked_across_all_final_outputs(self):
        """Multiple completed clauses must not be called missing just by their count."""
        coverage = prosody.Coverage("travel_prosody")
        coverage.observe(
            {"source": "新宿站，浅草寺", "text": "Shinjuku Station, Asakusa Temple"}
        )
        coverage.observe(
            {"source": "三号线还是七号线", "text": "line THREE or line ７"}
        )
        report = coverage.report()
        self.assertTrue(report["source_all_anchors"])
        self.assertTrue(report["target_all_anchors"])
        self.assertEqual(report["translation_events"], 2)
        self.assertNotIn("Shinjuku Station, Asakusa Temple", str(report))

    def test_absent_negation_is_not_hidden_by_a_polite_translation(self):
        """A thank-you clause alone cannot satisfy a negative reply fixture."""
        coverage = prosody.Coverage("short_polite_no")
        coverage.observe({"source": "不用了，谢谢", "text": "Thank you"})
        report = coverage.report()
        self.assertTrue(report["source_all_anchors"])
        self.assertFalse(report["target_all_anchors"])
        self.assertFalse(report["target_anchors"]["negation"])

    def test_missing_line_number_does_not_pass_the_travel_check(self):
        """Preserving names and one number is not evidence of both numeric anchors."""
        coverage = prosody.Coverage("travel_prosody")
        coverage.observe(
            {"source": "新宿 浅草 三 七", "text": "Shinjuku Asakusa three"}
        )
        self.assertFalse(coverage.report()["target_all_anchors"])

    def test_no_translation_and_excess_text_cannot_be_reported_as_covered(self):
        """Silence is incomplete, and large model payloads are bounded in memory."""
        coverage = prosody.Coverage("short_yes")
        self.assertFalse(coverage.report()["source_all_anchors"])
        with self.assertRaisesRegex(ValueError, "prosody_text_limit"):
            coverage.observe({"source": "x" * (prosody.MAX_TEXT_CHARS + 1), "text": ""})

    def test_place_alias_and_digits_adjacent_to_chinese_are_not_missing(self):
        """Place aliases and Arabic numbers in Chinese must survive lexical scoring."""
        coverage = prosody.Coverage("travel_prosody")
        coverage.observe(
            {
                "source": "新宿 浅草寺 3号线 7号线",
                "text": "Shinjuku, Sensō-ji, line3 or line7",
            }
        )
        self.assertTrue(coverage.report()["source_all_anchors"])
        self.assertTrue(coverage.report()["target_all_anchors"])

    def test_larger_numbers_do_not_satisfy_individual_line_numbers(self):
        """Thirteen and seventeen must not satisfy three and seven."""
        coverage = prosody.Coverage("travel_prosody")
        coverage.observe(
            {"source": "新宿 浅草寺 13号线 17号线", "text": "Shinjuku Asakusa 13 or 17"}
        )
        self.assertFalse(coverage.report()["source_all_anchors"])
        self.assertFalse(coverage.report()["target_all_anchors"])
        coverage = prosody.Coverage("travel_prosody")
        coverage.observe(
            {
                "source": "新宿 浅草寺 十三号线 十七号线",
                "text": "Shinjuku Asakusa thirteen or seventeen",
            }
        )
        self.assertFalse(coverage.report()["source_all_anchors"])
        self.assertFalse(coverage.report()["target_all_anchors"])
