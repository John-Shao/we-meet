"""File ASR upload, polling, final delivery and private-object cleanup."""

import os
import unittest
import uuid
import wave
from unittest import mock

from capture_live_transcriber import LiveCaptureAttempt
from capture_transcriber import CaptureAttempt
from plugins.qwen_asr import QwenASRSession
from plugins.qwen_filetrans import MODEL, QwenFileASRConfig, QwenFileASRSession


class FileTranscriptionTests(unittest.IsolatedAsyncioTestCase):
    """Exercise the complete adapter without making any provider requests."""

    async def test_file_upload_complete_result_and_cleanup(self):
        """WAV is closed before upload; final timestamps and billing survive."""
        config = QwenFileASRConfig(api_key="test-only")
        session = QwenFileASRSession(config)
        task_id = str(uuid.uuid4())
        storage = mock.Mock()
        storage.presigned_get_object.return_value = "https://audio.invalid/signed.wav"

        def inspect_upload(bucket, key, path, **kwargs):
            with wave.open(path, "rb") as audio:
                self.assertEqual(audio.getnframes(), 1600)
                self.assertEqual(audio.getframerate(), 16000)

        storage.fput_object.side_effect = inspect_upload

        async def audio():
            yield bytes(3200)

        finals = []

        async def final(sentence):
            finals.append(sentence)

        responses = [
            {"output": {"task_id": task_id}},
            {
                "output": {
                    "task_status": "SUCCEEDED",
                    "results": [
                        {
                            "subtask_status": "SUCCEEDED",
                            "transcription_url": "https://result.oss-cn-beijing.aliyuncs.com/result.json",
                        }
                    ],
                },
                "usage": {"duration": 0.1},
            },
            {
                "transcripts": [
                    {"sentences": [{"text": "Hello", "begin_time": 10, "end_time": 90}]}
                ]
            },
        ]
        with (
            mock.patch.dict(
                os.environ,
                {
                    "AWS_S3_ENDPOINT_URL": "s3.invalid",
                    "AWS_S3_ACCESS_KEY_ID": "test",
                    "AWS_S3_SECRET_ACCESS_KEY": "test",
                    "AWS_STORAGE_BUCKET_NAME": "private",
                },
            ),
            mock.patch("plugins.qwen_filetrans.Minio", return_value=storage),
            mock.patch.object(session, "request", side_effect=responses) as request,
        ):
            await session.run(audio(), final)
        payload = request.call_args_list[0].kwargs["body"]
        self.assertEqual(payload["model"], MODEL)
        self.assertEqual(
            payload["input"]["file_urls"], ["https://audio.invalid/signed.wav"]
        )
        self.assertFalse(request.call_args.kwargs["auth"])
        self.assertTrue(session.provider_finished)
        self.assertEqual(session.input_samples, 1600)
        self.assertEqual(session.billed_seconds, 0.1)
        self.assertEqual(finals[0].start_ms, 10)
        storage.remove_object.assert_called_once()

    def test_realtime_and_file_workers_have_distinct_default_adapters(self):
        """An inherited constructor cannot silently switch realtime to file ASR."""
        job = {"id": str(uuid.uuid4())}
        config = QwenFileASRConfig(api_key="test")
        self.assertIs(
            CaptureAttempt(None, config, job).session_factory, QwenFileASRSession
        )
        self.assertIs(
            LiveCaptureAttempt(None, config, job).session_factory, QwenASRSession
        )

    def test_env_ignores_realtime_model(self):
        """Only the dedicated file settings select non-realtime transcription."""
        with mock.patch.dict(
            os.environ,
            {"DASHSCOPE_API_KEY": "test", "QWEN_ASR_MODEL": "streaming"},
            clear=True,
        ):
            self.assertEqual(QwenFileASRConfig.from_env().model, MODEL)
