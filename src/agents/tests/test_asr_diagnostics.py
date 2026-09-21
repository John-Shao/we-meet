"""Fault injection for stage attribution, redaction and task-group failures."""

import asyncio
import json
import os
import unittest
import uuid
from unittest import mock

from asr_diagnostics import PREFIX, StageError, failures, stage
from plugins.qwen_filetrans import QwenFileASRConfig, QwenFileASRSession
from tests import test_capture_transcriber as worker_fixture


class StageTests(unittest.TestCase):
    """Exceptions cannot smuggle raw URLs, transcripts or credentials into logs."""

    def test_nested_stages_and_groups_keep_root_stage(self):
        """Outer operations do not relabel an inner failure."""
        with self.assertRaises(StageError) as caught:
            with stage("delivery"), stage("result_parse"):
                raise ValueError("PRIVATE transcript https://signed?token=SECRET")
        self.assertEqual(str(caught.exception), "result_parse:failed")
        group = ExceptionGroup("PRIVATE", [caught.exception, TimeoutError("SECRET")])
        self.assertEqual(
            [(item.stage, item.code) for item in failures(group)],
            [("result_parse", "failed"), ("execution", "timeout")],
        )

    def test_cancel_is_not_failure(self):
        """Task cancellation must still propagate to the worker lifecycle."""
        with self.assertRaises(asyncio.CancelledError), stage("cleanup"):
            raise asyncio.CancelledError


class WorkerDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    """Use the existing async protocol fixture, including its regression cases."""

    setUp = worker_fixture.CaptureWorkerTests.setUp

    async def test_no_speech_reason_requires_advertised_backend_and_no_text(self):
        """Old strict backends keep the old envelope; partial text stays generic."""
        for supported, final_count in ((False, 0), (True, 0), (True, 1)):
            with self.subTest(supported=supported, final_count=final_count):
                self.setUp()
                self.job["supports_failure_code"] = supported
                self.attempt.sequence = self.attempt.delivered = final_count
                with mock.patch.object(
                    self.attempt,
                    "process",
                    side_effect=StageError("transcription_poll", "no_speech"),
                ):
                    await self.attempt.execute()
                self.assertEqual(
                    self.attempt.receipt.get("failure_code"),
                    "no_speech_detected" if supported and final_count == 0 else None,
                )
                self.assertFalse(self.attempt.receipt["provider_finished"])

    async def test_delivery_failure_has_job_stage_and_no_exception_text(self):
        """TaskGroup exceptions resolve to the failed backend delivery stage."""
        self.backend.fail = "originals"
        with self.assertLogs("capture-transcriber", "WARNING") as logs:
            await self.attempt.execute()
        entry = json.loads(logs.output[0].split(PREFIX)[1])
        self.assertEqual(entry["job_id"], self.job["id"])
        self.assertEqual(entry["stage"], "delivery")
        self.assertNotIn("simulated_unknown_response", str(logs.output))
        self.assertFalse(self.attempt.receipt["provider_finished"])

    async def test_secondary_errors_prevent_no_speech_reason(self):
        """Mixed task failures and cleanup failures must remain operational errors."""
        empty = StageError("transcription_poll", "no_speech")
        for failure, cleanup in (
            (ExceptionGroup("private", [empty, StageError("delivery")]), None),
            (empty, StageError("cleanup")),
        ):
            with self.subTest(cleanup=cleanup):
                self.setUp()
                self.job["supports_failure_code"] = True
                if cleanup:
                    session = mock.Mock(
                        cleanup_error=cleanup,
                        provider_finished=False,
                        input_samples=16000,
                        billed_seconds=None,
                    )
                    session.task_id = str(uuid.uuid4())
                    self.attempt.sessions = [session]
                with mock.patch.object(self.attempt, "process", side_effect=failure):
                    await self.attempt.execute()
                self.assertNotIn("failure_code", self.attempt.receipt)

    async def test_corrupt_audio_has_specific_stage_before_provider(self):
        """Storage integrity failure is distinguishable from provider failure."""
        self.backend.data = b"SECRET"
        with self.assertLogs("capture-transcriber", "WARNING") as logs:
            await self.attempt.execute()
        self.assertIn('"stage": "audio_validate"', str(logs.output))
        self.assertFalse(self.sockets)


class ProviderDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    """Exercise actual adapter stages with injected storage and HTTP failures."""

    async def attempt(self, failure=None, *, cleanup=False):
        """Run a short bounded file through all adapter phases without network."""
        session = QwenFileASRSession(QwenFileASRConfig(api_key="SECRET"))
        storage = mock.Mock()
        storage.presigned_get_object.return_value = "https://private.invalid/SECRET"
        if failure in {"storage_upload", "storage_sign"}:
            method = (
                "fput_object" if failure == "storage_upload" else "presigned_get_object"
            )
            getattr(storage, method).side_effect = RuntimeError("PRIVATE SECRET")
        if cleanup:
            storage.remove_object.side_effect = RuntimeError("PRIVATE CLEANUP")
        responses = [
            {"output": {"task_id": str(uuid.uuid4())}},
            {
                "output": {
                    "task_status": "SUCCEEDED",
                    "results": [
                        {
                            "subtask_status": "SUCCEEDED",
                            "transcription_url": "https://test.aliyuncs.com/result",
                        }
                    ],
                }
            },
            {
                "transcripts": [
                    {
                        "sentences": [
                            {
                                "text": "synthetic",
                                "begin_time": 0,
                                "end_time": 90,
                            }
                        ]
                    }
                ]
            },
        ]
        for index, name in enumerate(
            ("transcription_submit", "transcription_poll", "result_fetch")
        ):
            if failure == name:
                responses[index] = TimeoutError("SECRET")
        if failure == "result_parse":
            responses[2] = {"transcripts": [{"sentences": [{"text": "PRIVATE"}]}]}

        async def audio():
            yield bytes(3200)

        async def final(_sentence):
            if failure == "delivery":
                raise RuntimeError("PRIVATE delivery")

        with (
            mock.patch.dict(
                os.environ,
                {
                    "AWS_S3_ENDPOINT_URL": "test.invalid",
                    "AWS_STORAGE_BUCKET_NAME": "test",
                },
            ),
            mock.patch("plugins.qwen_filetrans.storage_client", return_value=storage),
            mock.patch.object(session, "request", side_effect=responses),
        ):
            try:
                await session.run(audio(), final)
            except StageError as error:
                return session, error
        return session, None

    async def test_each_phase_is_distinct_and_sanitized(self):
        """One failure per phase cannot leak response or exception contents."""
        for name in (
            "storage_upload",
            "storage_sign",
            "transcription_submit",
            "transcription_poll",
            "result_fetch",
            "result_parse",
            "delivery",
        ):
            with self.subTest(stage=name):
                session, error = await self.attempt(name)
                self.assertEqual(error.stage, name)
                self.assertNotIn("PRIVATE", str(error))
                self.assertNotIn("SECRET", str(error))
                self.assertFalse(session.provider_finished)

    async def test_cleanup_keeps_primary_error(self):
        """A secondary deletion error cannot obscure the original submit failure."""
        session, error = await self.attempt("transcription_submit", cleanup=True)
        self.assertEqual(error.stage, "transcription_submit")
        self.assertEqual(session.cleanup_error.stage, "cleanup")
        session, error = await self.attempt(cleanup=True)
        self.assertEqual(error.stage, "cleanup")

    async def test_missing_structure_fails_but_explicit_silence_is_valid(self):
        """Silence can finish empty; malformed provider output cannot."""
        session = QwenFileASRSession(QwenFileASRConfig(api_key="SECRET"))
        with self.assertRaises(StageError):
            await session.publish({}, mock.Mock())
        final = mock.Mock()
        await session.publish({"transcripts": []}, final)
        final.assert_not_called()

    async def test_only_observed_terminal_code_maps_to_no_speech(self):
        """Require the exact code, not empty output or a matching message."""
        for output, code in (
            (
                {"task_status": "FAILED", "code": "ASR_RESPONSE_HAVE_NO_WORDS"},
                "no_speech",
            ),
            ({"task_status": "FAILED", "code": "FILE_DOWNLOAD_FAILED"}, "failed"),
            (
                {"task_status": "FAILED", "message": "ASR_RESPONSE_HAVE_NO_WORDS"},
                "failed",
            ),
            (
                {
                    "task_status": "FAILED",
                    "code": "ASR_RESPONSE_HAVE_NO_WORDS",
                    "results": [{}],
                },
                "failed",
            ),
            (
                {"task_status": "SUCCEEDED", "code": "ASR_RESPONSE_HAVE_NO_WORDS"},
                "failed",
            ),
        ):
            session = QwenFileASRSession(QwenFileASRConfig(api_key="test-only"))
            with (
                self.subTest(output=output),
                mock.patch.object(
                    session,
                    "request",
                    side_effect=[
                        {"output": {"task_id": str(uuid.uuid4())}},
                        {"output": output},
                    ],
                ),
                self.assertRaises(StageError) as caught,
            ):
                await session.transcribe("https://fixture.invalid", mock.Mock())
            self.assertEqual(caught.exception.stage, "transcription_poll")
            self.assertEqual(caught.exception.code, code)
            self.assertFalse(session.provider_finished)
