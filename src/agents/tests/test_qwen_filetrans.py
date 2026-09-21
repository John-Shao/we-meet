"""File ASR upload, polling, final delivery and private-object cleanup."""

import os
import unittest
import uuid
import wave
from datetime import timedelta
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from capture_live_transcriber import LiveCaptureAttempt
from capture_transcriber import CaptureAttempt
from plugins.qwen_asr import QwenASRSession
from plugins.qwen_filetrans import (
    MODEL,
    QwenFileASRConfig,
    QwenFileASRSession,
    storage_client,
)


class FileTranscriptionTests(unittest.IsolatedAsyncioTestCase):
    """Exercise the complete adapter without making any provider requests."""

    def test_oss_signs_bucket_hostname_without_location_discovery(self):
        """Both private uploads and public signatures use the configured region."""
        with mock.patch.dict(
            os.environ,
            {
                "AWS_S3_ACCESS_KEY_ID": "test",
                "AWS_S3_SECRET_ACCESS_KEY": "test",
                "AWS_S3_REGION_NAME": "cn-shenzhen",
                "AWS_S3_ADDRESSING_STYLE": "virtual",
            },
            clear=True,
        ):
            for endpoint in (
                "https://oss-cn-shenzhen-internal.aliyuncs.com",
                "https://oss-cn-shenzhen.aliyuncs.com",
            ):
                client = storage_client(endpoint)
                with mock.patch.object(
                    client, "_url_open", side_effect=AssertionError("network")
                ):
                    url = client.presigned_get_object(
                        "private",
                        "filetrans-temporary/test.wav",
                        expires=timedelta(minutes=1),
                    )
                parsed = urlsplit(url)
                self.assertEqual(
                    parsed.hostname, "private." + urlsplit(endpoint).hostname
                )
                self.assertEqual(parsed.path, "/filetrans-temporary/test.wav")
                self.assertIn(
                    "/cn-shenzhen/s3/", parse_qs(parsed.query)["X-Amz-Credential"][0]
                )

    def test_oss_requires_region_before_any_storage_io(self):
        """Virtual style alone still triggers an incompatible location query."""
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch("plugins.qwen_filetrans.Minio") as client,
        ):
            with self.assertRaisesRegex(ValueError, "oss_region_and_virtual"):
                storage_client("oss-cn-shenzhen.aliyuncs.com")
            client.assert_not_called()

    def test_local_minio_keeps_path_style(self):
        """The OSS fix must not require wildcard DNS for development MinIO."""
        with mock.patch.dict(
            os.environ,
            {
                "AWS_S3_ACCESS_KEY_ID": "test",
                "AWS_S3_SECRET_ACCESS_KEY": "test",
                "AWS_S3_REGION_NAME": "us-east-1",
                "AWS_S3_SECURE_ACCESS": "false",
            },
            clear=True,
        ):
            url = storage_client("minio:9000").presigned_get_object(
                "private", "test.wav", expires=timedelta(minutes=1)
            )
        self.assertEqual(urlsplit(url).netloc, "minio:9000")
        self.assertEqual(urlsplit(url).scheme, "http")
        self.assertEqual(urlsplit(url).path, "/private/test.wav")

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
