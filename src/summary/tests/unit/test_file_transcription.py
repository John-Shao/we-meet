"""File-ASR wire format, legacy result conversion and retry task identity."""

import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

from pydantic import SecretStr

from summary.core import file_transcription as service


class FileTranscriptionTests(unittest.TestCase):
    """Test the provider adapter independently of the legacy HTTP application."""

    def test_conversion_preserves_words_and_millisecond_offsets(self):
        """The webhook retains seconds and provider speaker labels."""
        result = service.convert(
            {
                "transcripts": [
                    {
                        "sentences": [
                            {
                                "text": "Hello.",
                                "begin_time": 100,
                                "end_time": 900,
                                "speaker_id": 0,
                                "words": [
                                    {
                                        "text": "Hello",
                                        "punctuation": ".",
                                        "begin_time": 100,
                                        "end_time": 800,
                                    }
                                ],
                            }
                        ]
                    }
                ]
            }
        )
        self.assertEqual(result.segments[0].start, 0.1)
        self.assertEqual(result.word_segments[0].word, "Hello.")
        self.assertEqual(result.segments[0].speaker, "0")

    def test_retry_polls_persisted_task_without_another_submission(self):
        """Redis keeps the original billable identity across Celery deliveries."""
        settings = SimpleNamespace(
            qwen_file_asr_model=service.MODEL,
            qwen_file_asr_region="cn-beijing",
            qwen_file_asr_base_url="",
            dashscope_api_key=SecretStr("test"),
        )
        ledger = mock.Mock()
        ledger.set.return_value = False
        task_id = str(uuid.uuid4())
        ledger.get.return_value = task_id.encode()
        result = {
            "output": {
                "task_status": "SUCCEEDED",
                "results": [
                    {
                        "subtask_status": "SUCCEEDED",
                        "transcription_url": "https://result.oss-cn-beijing.aliyuncs.com/result.json",
                    }
                ],
            }
        }
        with mock.patch.object(
            service, "request_json", side_effect=[result, {"transcripts": []}]
        ) as request:
            service.transcribe(
                "https://audio.invalid/a.wav", settings, task_id="job", ledger=ledger
            )
        self.assertEqual(request.call_args_list[0].args[0], "GET")
        self.assertIn(task_id, request.call_args_list[0].args[1])
        self.assertNotIn("api_key", request.call_args.kwargs)

    def test_uncertain_submission_is_never_automatically_replayed(self):
        """A lost submission response is surfaced without an extra charge."""
        settings = SimpleNamespace(
            qwen_file_asr_model=service.MODEL,
            qwen_file_asr_region="cn-beijing",
            qwen_file_asr_base_url="",
            dashscope_api_key=SecretStr("test"),
        )
        ledger = mock.Mock()
        ledger.set.return_value = False
        ledger.get.return_value = b"submitting"
        with (
            mock.patch.object(service, "request_json") as request,
            self.assertRaisesRegex(ValueError, "submission_unknown"),
        ):
            service.transcribe(
                "https://audio.invalid/a.wav", settings, task_id="job", ledger=ledger
            )
        request.assert_not_called()
