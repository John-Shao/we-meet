"""Candidate controls cannot alter the default adapter or fetch credentials."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from evaluations.asr_quality.run_provider import LanguageCandidateSession, run
from plugins.qwen_filetrans import QwenFileASRConfig, QwenFileASRSession


class LanguageCandidateTests(unittest.IsolatedAsyncioTestCase):
    """Bound paid requests, preserve evidence and keep credentials scoped."""

    async def test_only_submission_adds_hint_and_does_not_mutate_input(self):
        """Result downloads stay unauthenticated; caller payloads remain unchanged."""
        config = QwenFileASRConfig(api_key="test")
        session = LanguageCandidateSession(config, "en")
        body = {"parameters": {"channel_id": [0]}}
        with patch.object(
            QwenFileASRSession, "request", new_callable=AsyncMock
        ) as send:
            await session.request(
                None,
                "POST",
                config.url + "/services/audio/asr/transcription",
                body=body,
            )
            self.assertEqual(
                send.call_args.kwargs["body"]["parameters"],
                {"channel_id": [0], "language_hints": ["en"]},
            )
            self.assertNotIn("language_hints", body["parameters"])
            await session.request(
                None, "GET", "https://result.example.invalid", auth=False
            )
            self.assertFalse(send.call_args.kwargs["auth"])
            self.assertIsNone(send.call_args.kwargs["body"])

    async def test_candidate_submits_exactly_two_clean_cases(self):
        """Noise and silence cannot accidentally incur extra paid requests."""
        seen = []

        async def fake_run(session, audio, final):
            seen.append(session.language)
            session.provider_finished = True

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                QwenFileASRConfig,
                "from_env",
                return_value=QwenFileASRConfig(api_key="test"),
            ),
            patch.object(LanguageCandidateSession, "run", fake_run),
        ):
            await run(
                Path(directory) / "observations.json",
                "test",
                known_language_candidate=True,
            )
        self.assertEqual(seen, ["en", "zh"])

    async def test_term_candidate_is_bounded_and_preserves_silence_control(self):
        """A term experiment includes both Chinese fixtures and its negative control."""
        config = QwenFileASRConfig(api_key="test")
        session = LanguageCandidateSession(config, "zh", term_candidate=True)
        with patch.object(
            QwenFileASRSession, "request", new_callable=AsyncMock
        ) as send:
            await session.request(
                None,
                "POST",
                config.url + "/services/audio/asr/transcription",
                body={"parameters": {"channel_id": [0]}},
            )
            self.assertEqual(
                send.call_args.kwargs["body"]["parameters"]["vocabulary"], {"妙记": 5}
            )

        async def fake_run(session, audio, final):
            self.assertTrue(session.term_candidate)
            session.provider_finished = True

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(QwenFileASRConfig, "from_env", return_value=config),
            patch.object(LanguageCandidateSession, "run", fake_run),
        ):
            output = Path(directory) / "observations.json"
            await run(output, "test", term_candidate=True)
            ids = [
                c["id"] for c in json.loads(output.read_text(encoding="utf-8"))["cases"]
            ]
        self.assertEqual(ids, ["terms-zh-clean", "terms-zh-noise10", "silence"])

    async def test_failure_stops_and_existing_output_is_never_overwritten(self):
        """First failure stops the run and prior evidence cannot be replaced."""
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                QwenFileASRConfig,
                "from_env",
                return_value=QwenFileASRConfig(api_key="test"),
            ),
            patch.object(
                LanguageCandidateSession, "run", new_callable=AsyncMock
            ) as request,
        ):
            request.side_effect = ValueError("private provider error")
            output = Path(directory) / "observations.json"
            await run(output, "test", known_language_candidate=True)
            self.assertEqual(request.await_count, 1)
            original = output.read_bytes()
            self.assertNotIn(b"private provider error", original)
            with self.assertRaises(ValueError):
                await run(output, "test", known_language_candidate=True)
            self.assertEqual(output.read_bytes(), original)
