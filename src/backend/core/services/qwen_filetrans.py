"""DashScope file transcription protocol; credentials never follow redirects."""

import json
import re
from urllib.parse import urlsplit

from django.conf import settings

import requests

from core.services import word_alignment

MODEL = "qwen-audio-3.0-asr-flash-filetrans"
MAX_RESULT_BYTES = 32 * 1024 * 1024


class FileTranscriptionError(ValueError):
    """Only fixed diagnostics are exposed to callers."""


def base_url():
    """Keep file ASR independent from realtime and OpenAI-compatible endpoints."""
    region = settings.QWEN_FILE_ASR_REGION
    if region not in {"cn-beijing", "ap-southeast-1"}:
        raise FileTranscriptionError("invalid_region")
    url = settings.QWEN_FILE_ASR_BASE_URL or (
        "https://dashscope.aliyuncs.com/api/v1"
        if region == "cn-beijing"
        else "https://dashscope-intl.aliyuncs.com/api/v1"
    )
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise FileTranscriptionError("invalid_endpoint")
    if settings.QWEN_FILE_ASR_MODEL != MODEL:
        raise FileTranscriptionError("invalid_file_model")
    return url.rstrip("/")


def request_json(method, url, *, payload=None, authenticated=True):
    """Bound both metadata and result downloads; never expose provider error bodies."""
    headers = {}
    if authenticated:
        headers["Authorization"] = f"Bearer {settings.DASHSCOPE_API_KEY}"
    if method == "POST":
        headers["X-DashScope-Async"] = "enable"
    with requests.request(
        method,
        url,
        json=payload,
        headers=headers,
        timeout=(5, 30),
        allow_redirects=False,
        stream=True,
    ) as response:
        if method == "GET" and (
            response.status_code == 429 or response.status_code >= 500
        ):
            raise requests.ConnectionError("provider_temporarily_unavailable")
        if response.status_code != 200:
            raise FileTranscriptionError("provider_request_failed")
        data = bytearray()
        for part in response.iter_content(65536):
            data.extend(part)
            if len(data) > MAX_RESULT_BYTES:
                raise FileTranscriptionError("provider_result_too_large")
        try:
            result = json.loads(data)
        except ValueError:
            raise FileTranscriptionError("invalid_provider_result") from None
        if not isinstance(result, dict):
            raise FileTranscriptionError("invalid_provider_result")
        return result


def submit(url, options):
    """A submission is never automatically replayed after an ambiguous response."""
    source = {"file_urls": [url]}
    if options.get("context"):
        source["context"] = [
            {
                "role": "user",
                "content": [{"type": "input_text", "text": options["context"]}],
            }
        ]
    parameters = {
        "channel_id": [0],
        "diarization_enabled": options.get("diarization", False),
    }
    if options.get("hotwords"):
        parameters["vocabulary"] = dict.fromkeys(options["hotwords"], 3)
    result = request_json(
        "POST",
        base_url() + "/services/audio/asr/transcription",
        payload={"model": MODEL, "input": source, "parameters": parameters},
    )
    task_id = result.get("output", {}).get("task_id", "")
    if not isinstance(task_id, str) or not re.fullmatch(
        r"[A-Za-z0-9_-]{1,128}", task_id
    ):
        raise FileTranscriptionError("submission_unknown")
    return task_id


def poll(task_id):
    """Return None while pending, or the complete result after all subtasks succeed."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
        raise FileTranscriptionError("invalid_task_id")
    response = request_json("GET", base_url() + "/tasks/" + task_id)
    output = response.get("output", {})
    status = output.get("task_status")
    if status in {"PENDING", "RUNNING"}:
        return None
    if status != "SUCCEEDED":
        raise FileTranscriptionError("provider_task_failed")
    results = output.get("results", [])
    if len(results) != 1 or results[0].get("subtask_status") != "SUCCEEDED":
        raise FileTranscriptionError("provider_file_failed")
    url = results[0].get("transcription_url", "")
    parsed = urlsplit(url)
    # These URLs come only from DashScope. Still restrict downloads to Alibaba storage.
    if (
        parsed.scheme != "https"
        or not (parsed.hostname or "").endswith(".aliyuncs.com")
        or parsed.username
        or parsed.password
        or parsed.port not in {None, 443}
    ):
        raise FileTranscriptionError("invalid_result_url")
    result = request_json("GET", url, authenticated=False)
    result["billed_seconds"] = response.get("usage", {}).get("duration")
    return result


def sentences(result):
    """Validate a complete source before atomically publishing any of its text."""
    rows, text_bytes = [], 0
    properties = result.get("properties")
    media_end_ms = (
        properties.get("original_duration_in_milliseconds")
        if isinstance(properties, dict)
        else None
    )
    for transcript in result.get("transcripts", []):
        for sentence in transcript.get("sentences", []):
            text = sentence.get("text", "")
            start, end = sentence.get("begin_time"), sentence.get("end_time")
            if (
                not isinstance(text, str)
                or len(text) > 10000
                or type(start) is not int
                or type(end) is not int
                or not 0 <= start <= end <= 43200000
            ):
                raise FileTranscriptionError("invalid_provider_sentence")
            if not text.strip():
                continue
            text_bytes += len(text.encode())
            if len(rows) >= 20000 or text_bytes > 4000000:
                raise FileTranscriptionError("provider_text_too_large")
            alignment, alignment_status = (
                word_alignment.from_sentence(
                    sentence,
                    MODEL,
                    media_end_ms,
                )
                if settings.MEETING_WORD_ALIGNMENT_WRITE_ENABLED
                else (None, "missing")
            )
            rows.append(
                {
                    "text": text,
                    "start_ms": start,
                    "end_ms": end,
                    "speaker": str(sentence.get("speaker_id", "unknown"))[:100],
                    "language": str(sentence.get("language", ""))[:16],
                    "word_alignment": alignment,
                    "alignment_status": alignment_status,
                }
            )
    if not rows:
        raise FileTranscriptionError("no_speech")
    return sorted(rows, key=lambda row: row["start_ms"])
