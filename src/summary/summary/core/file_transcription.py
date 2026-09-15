"""Qwen asynchronous file ASR adapter for legacy summary/webhook consumers."""

import json
import time
import uuid
from urllib.parse import urlsplit

import requests

from summary.core.shared_models import Segment, WhisperXResponse, WordSegment

MODEL = "qwen-audio-3.0-asr-flash-filetrans"


def request_json(method, url, *, api_key=None, payload=None):
    """Never retry a POST or forward credentials to a redirected/result URL."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    if method == "POST":
        headers["X-DashScope-Async"] = "enable"
    with requests.request(
        method,
        url,
        json=payload,
        headers=headers,
        timeout=(5, 45),
        allow_redirects=False,
        stream=True,
    ) as response:
        if response.status_code != 200:
            raise ValueError("file_transcription_request_failed")
        data = bytearray()
        for part in response.iter_content(65536):
            data.extend(part)
            if len(data) > 32 * 1024 * 1024:
                raise ValueError("file_transcription_result_too_large")
        return json.loads(data)


def convert(result):
    """Preserve the existing webhook schema and convert milliseconds to seconds."""
    segments, words = [], []
    for channel in result.get("transcripts", []):
        for sentence in channel.get("sentences", []):
            speaker = str(sentence["speaker_id"]) if "speaker_id" in sentence else None
            sentence_words = tuple(
                WordSegment(
                    word=item["text"] + item.get("punctuation", ""),
                    start=item["begin_time"] / 1000,
                    end=item["end_time"] / 1000,
                    speaker=speaker,
                )
                for item in sentence.get("words", [])
            )
            words.extend(sentence_words)
            segments.append(
                Segment(
                    start=sentence["begin_time"] / 1000,
                    end=sentence["end_time"] / 1000,
                    text=sentence["text"],
                    speaker=speaker,
                    words=sentence_words,
                )
            )
    return WhisperXResponse(segments=tuple(segments), word_segments=tuple(words))


def transcribe(url, settings, *, language=None, task_id, ledger):
    """Persist provider identity in Redis so Celery retries cannot resubmit audio."""
    if settings.qwen_file_asr_model != MODEL:
        raise ValueError("invalid_file_asr_model")
    if settings.qwen_file_asr_region not in {"cn-beijing", "ap-southeast-1"}:
        raise ValueError("invalid_file_asr_region")
    base = settings.qwen_file_asr_base_url or (
        "https://dashscope.aliyuncs.com/api/v1"
        if settings.qwen_file_asr_region == "cn-beijing"
        else "https://dashscope-intl.aliyuncs.com/api/v1"
    )
    parsed = urlsplit(base)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("invalid_file_asr_endpoint")
    base = base.rstrip("/")
    api_key = settings.dashscope_api_key.get_secret_value()
    if not api_key:
        raise ValueError("dashscope_api_key_required")
    key = f"qwen-filetrans:{task_id}"
    # Redis NX fences duplicate task delivery before the billable operation.
    is_new = ledger.set(key, b"submitting", nx=True, ex=172800)
    if is_new:
        parameters = {"channel_id": [0], "diarization_enabled": False}
        if language:
            parameters["language_hints"] = [language]
        response = request_json(
            "POST",
            base + "/services/audio/asr/transcription",
            api_key=api_key,
            payload={
                "model": MODEL,
                "input": {"file_urls": [url]},
                "parameters": parameters,
            },
        )
        provider_id = str(uuid.UUID(response["output"]["task_id"]))
        ledger.set(key, provider_id, ex=172800)
    else:
        saved = ledger.get(key)
        if not saved or saved == b"submitting":
            raise ValueError("file_transcription_submission_unknown")
        provider_id = str(
            uuid.UUID(saved.decode() if isinstance(saved, bytes) else saved)
        )
    deadline = time.monotonic() + 86400
    while time.monotonic() < deadline:
        result = request_json("GET", base + "/tasks/" + provider_id, api_key=api_key)
        output = result["output"]
        if output["task_status"] in {"PENDING", "RUNNING"}:
            time.sleep(5)
            continue
        files = output.get("results", [])
        if (
            output["task_status"] != "SUCCEEDED"
            or len(files) != 1
            or files[0].get("subtask_status") != "SUCCEEDED"
        ):
            raise ValueError("file_transcription_failed")
        result_url = files[0]["transcription_url"]
        parsed = urlsplit(result_url)
        if parsed.scheme != "https" or not (parsed.hostname or "").endswith(
            ".aliyuncs.com"
        ):
            raise ValueError("invalid_file_transcription_result_url")
        return convert(request_json("GET", result_url))
    raise ValueError("file_transcription_timeout")
