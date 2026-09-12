"""Source observations remain bounded and terminal manifests remain immutable."""

import unittest
from unittest import mock

from asr_observer import ASRObserver
from transcript_writer import TranscriptWriter


def start(observer):
    """Create one observed stream without pretending a provider task has run."""
    observer.observe(
        {"type": "stream_started", "stream_id": "stream", "model": "qwen-asr"}
    )


def task(**changes):
    """A tiny completed task with no source text or credentials."""
    return {
        "type": "task",
        "stream_id": "stream",
        "task_id": "task",
        "finished": True,
        "input_samples": 16000,
        "final_sentences": 1,
        "billed_seconds": 1.0,
        **changes,
    }


class ASRObserverTest(unittest.TestCase):
    """Observations distinguish silence, failure, duplicates and finished work."""

    def test_repeated_receipts_are_idempotent_and_conflicting_receipts_fail(self):
        """Duplicate callbacks must neither double-count usage nor replace evidence."""
        observer = ASRObserver()
        self.assertEqual(observer.manifest(), {})
        start(observer)
        observer.observe(task())
        observer.observe(task())
        observer.observe({"type": "stream_finished", "stream_id": "stream"})
        report = observer.manifest()
        self.assertEqual(report["tasks_finished"], 1)
        self.assertEqual(report["billed_seconds"], 1.0)
        self.assertEqual(report["errors"], [])
        observer.observe(task(input_samples=32000))
        self.assertIn("asr_observation_conflict", observer.manifest()["errors"])
        self.assertEqual(observer.manifest()["input_samples"], 16000)

    def test_failure_limits_and_mixed_model_are_explicit(self):
        """Do not merge changing model provenance or drop evidence silently."""
        observer = ASRObserver()
        start(observer)
        observer.observe(task(finished=False))
        self.assertIn("asr_stream_failed", observer.manifest()["errors"])
        observer.observe(
            {"type": "stream_started", "stream_id": "other", "model": "different"}
        )
        self.assertIn("asr_observation_conflict", observer.manifest()["errors"])
        with mock.patch("asr_observer.MAX_OBSERVATIONS", 1):
            observer.observe(task(task_id="second"))
        self.assertIn("asr_observation_limit", observer.manifest()["errors"])
        self.assertEqual(observer.manifest()["tasks_started"], 1)


class TerminalObservationTest(unittest.IsolatedAsyncioTestCase):
    """Delivery retry reuses the exact first manifest, even after late observations."""

    async def test_open_stream_cannot_seal_success_and_retry_manifest_is_fixed(self):
        """A timeout with an active source stays incomplete after late completion."""
        writer = TranscriptWriter(
            base_url="https://backend.test", token=str(mock.sentinel.agent_token)
        )
        writer._post_sync = mock.Mock(return_value=True)
        await writer.begin_delivery("room", "RM_session")
        writer.observe_asr(
            {"type": "stream_started", "stream_id": "stream", "model": "qwen-asr"}
        )
        writer.observe_asr(task())
        await writer.finish_delivery()
        first = writer._post_sync.call_args.args[0]
        self.assertEqual(first["outcome"], "incomplete")
        self.assertEqual(first["source_report"]["streams_finished"], 0)
        writer.observe_asr({"type": "stream_finished", "stream_id": "stream"})
        await writer.finish_delivery()
        self.assertEqual(writer._post_sync.call_args.args[0], first)

    async def test_drained_source_reports_observation_without_audio_coverage(self):
        """A successful report adds counters, never an audio-complete assertion."""
        writer = TranscriptWriter(
            base_url="https://backend.test", token=str(mock.sentinel.agent_token)
        )
        writer._post_sync = mock.Mock(return_value=True)
        await writer.begin_delivery("room", "RM_session")
        writer.observe_asr(
            {"type": "stream_started", "stream_id": "stream", "model": "qwen-asr"}
        )
        writer.observe_asr(task())
        writer.observe_asr({"type": "stream_finished", "stream_id": "stream"})
        await writer.finish_delivery()
        payload = writer._post_sync.call_args.args[0]
        self.assertEqual(payload["outcome"], "complete")
        self.assertEqual(payload["source_report"]["tasks_finished"], 1)
        self.assertNotIn("coverage_status", payload["source_report"])


if __name__ == "__main__":
    unittest.main()
