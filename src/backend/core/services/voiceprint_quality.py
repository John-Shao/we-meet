"""Qwen short-ASR quality evidence. No Django, inferred names or text persistence."""

import base64
import hashlib
import json
import re
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import requests
from urllib3.exceptions import HTTPError as Urllib3HTTPError

from core.services.voiceprint_encoder import MAX_AUDIO_BYTES
from core.services.voiceprint_prompt import challenge_digest, prompt_matches

MODEL_ID = "qwen-audio-3.1-asr-flash"
POLICY_VERSION = "qwen-short-asr-enrollment-v1"
QUERY_POLICY_VERSION = "qwen-short-asr-query-v1"
API_PATH = "/api/v1/services/aigc/multimodal-generation/generation"
MAX_RESPONSE_BYTES = 65536
REASONS = {"passed", "insufficient_audio", "mixed_speaker", "prompt_mismatch"}
ERROR_CODES = {
    "quality_configuration_invalid",
    "quality_input_invalid",
    "quality_lease_expired",
    "quality_response_invalid",
    "quality_response_too_large",
    "quality_request_rejected",
    "quality_transport_unavailable",
    "quality_deadline_exceeded",
    "quality_authorization_revoked",
    "quality_worker_unavailable",
}


class QualityError(ValueError):
    def __init__(self, code, *, retryable=False):
        super().__init__(code)
        self.retryable = retryable


@dataclass(frozen=True)
class QualityConfiguration:
    url: str
    api_key: bytes = field(repr=False)
    ca_bundle: bool | str = True

    def validate(self):
        try:
            parsed = urlsplit(self.url)
            cloud = parsed.hostname in {
                "dashscope.aliyuncs.com",
                "dashscope-intl.aliyuncs.com",
            } or bool(
                re.fullmatch(
                    r"[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com",
                    parsed.hostname or "",
                )
            )
            local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
            if (
                parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
                or parsed.path != API_PATH
                or any(char.isspace() for char in self.url)
                or not (
                    (cloud and parsed.scheme == "https" and parsed.port in (None, 443))
                    or (
                        local
                        and parsed.scheme == "http"
                        and (parsed.port is None or 1 <= parsed.port <= 65535)
                    )
                )
                or not isinstance(self.api_key, bytes)
                or not 16 <= len(self.api_key) <= 256
                or any(byte < 33 or byte > 126 for byte in self.api_key)
                or not (
                    self.ca_bundle is True
                    or (
                        isinstance(self.ca_bundle, str) and bool(self.ca_bundle.strip())
                    )
                )
            ):
                raise ValueError
        except (ValueError, TypeError, AttributeError):
            raise QualityError("quality_configuration_invalid") from None
        return self

    def payload(self):
        return {
            "url": self.url,
            "api_key": self.api_key.decode("ascii"),
            "ca_bundle": self.ca_bundle,
        }


def configuration(value):
    try:
        if (
            not isinstance(value, dict)
            or set(value) != {"url", "api_key", "ca_bundle"}
            or not isinstance(value["api_key"], str)
        ):
            raise ValueError
        return QualityConfiguration(
            value["url"], value["api_key"].encode("ascii"), value["ca_bundle"]
        ).validate()
    except (ValueError, TypeError, UnicodeError):
        raise QualityError("quality_configuration_invalid") from None


def load_configuration(path):
    try:
        with Path(path).open("rb") as stream:
            encoded = stream.read(8193)
        if len(encoded) > 8192:
            raise ValueError
        return configuration(json.loads(encoded))
    except (OSError, TypeError, ValueError, RecursionError):
        raise QualityError("quality_configuration_invalid") from None


def audio_duration(wav):
    if (
        not isinstance(wav, bytes)
        or not 44 <= len(wav) <= MAX_AUDIO_BYTES
        or (len(wav) - 44) % 2
    ):
        raise QualityError("quality_input_invalid")
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        len(wav) - 8,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        24000,
        48000,
        2,
        16,
        b"data",
        len(wav) - 44,
    )
    duration = (len(wav) - 44) * 1000 // 48000
    if wav[:44] != header or not 3000 <= duration <= 10000:
        raise QualityError("quality_input_invalid")
    return duration


def interval(value, duration):
    begin, end = value.get("begin_time"), value.get("end_time")
    if (
        type(begin) is not int
        or type(end) is not int
        or not 0 <= begin < end <= duration
    ):
        raise QualityError("quality_response_invalid")
    return begin, end


def speech_evidence(body, *, duration):
    if not isinstance(body, dict) or not isinstance(body.get("output"), dict):
        raise QualityError("quality_response_invalid")
    sentences = body["output"].get("sentences")
    if not isinstance(sentences, list) or len(sentences) > 64:
        raise QualityError("quality_response_invalid")
    speakers, identifiers, spans, texts = set(), set(), [], []
    words_count = 0
    for sentence in sentences:
        if (
            not isinstance(sentence, dict)
            or sentence.get("sentence_end") is not True
            or type(sentence.get("sentence_id")) is not int
            or sentence["sentence_id"] < 1
            or sentence["sentence_id"] in identifiers
            or type(sentence.get("channel_id")) is not int
            or sentence["channel_id"] != 0
            or type(sentence.get("speaker_id")) is not int
            or not 0 <= sentence["speaker_id"] <= 50
            or not isinstance(sentence.get("words"), list)
            or not sentence["words"]
        ):
            raise QualityError("quality_response_invalid")
        identifiers.add(sentence["sentence_id"])
        speakers.add(sentence["speaker_id"])
        begin, end = interval(sentence, duration)
        words_count += len(sentence["words"])
        if words_count > 512:
            raise QualityError("quality_response_invalid")
        for word in sentence["words"]:
            if (
                isinstance(word, dict)
                and isinstance(word.get("text"), str)
                and 0 < len(word["text"]) <= 512
                and word["text"].strip()
                and not any(char.isalnum() for char in word["text"])
            ):
                continue  # Punctuation/separators never contribute speech time.
            if (
                not isinstance(word, dict)
                or type(word.get("speaker_id")) is not int
                or not 0 <= word["speaker_id"] <= 50
                or not isinstance(word.get("text"), str)
                or not word["text"].strip()
                or len(word["text"]) > 512
            ):
                raise QualityError("quality_response_invalid")
            start, stop = interval(word, duration)
            if not begin <= start < stop <= end:
                raise QualityError("quality_response_invalid")
            speakers.add(word["speaker_id"])
            spans.append((start, stop))
            texts.append((start, stop, word["text"]))
    speech_ms, previous_end = 0, 0
    for start, end in sorted(spans):
        speech_ms += max(0, end - max(previous_end, start))
        previous_end = max(previous_end, end)
    words = [row[2] for row in sorted(texts, key=lambda row: (row[0], row[1]))]
    if sum(len(word) for word in words) > 4096:
        raise QualityError("quality_response_invalid")
    return speech_ms, len(speakers), words


def interpret(body, *, duration, locale, prompt):
    speech_ms, speaker_count, words = speech_evidence(body, duration=duration)
    text = "".join(words) if locale == "zh-CN" else " ".join(words)
    if len(text) > 4096:
        raise QualityError("quality_response_invalid")
    if speaker_count > 1:
        reason = "mixed_speaker"
    elif speech_ms < 3000:
        reason = "insufficient_audio"
    elif not prompt_matches(text, locale=locale, prompt=prompt):
        reason = "prompt_mismatch"
    else:
        reason = "passed"
    return {
        "policy": POLICY_VERSION,
        "model_id": MODEL_ID,
        "passed": reason == "passed",
        "reason": reason,
        "valid_speech_ms": speech_ms,
        "speaker_count": speaker_count,
        "prompt_sha256": challenge_digest(locale, prompt),
    }


def interpret_query(body, *, duration):
    speech_ms, speaker_count, _words = speech_evidence(body, duration=duration)
    reason = (
        "mixed_speaker"
        if speaker_count > 1
        else "insufficient_audio"
        if speech_ms < 3000
        else "passed"
    )
    return {
        "policy": QUERY_POLICY_VERSION,
        "model_id": MODEL_ID,
        "passed": reason == "passed",
        "reason": reason,
        "valid_speech_ms": speech_ms,
        "speaker_count": speaker_count,
    }


def decode_result(body, *, digest, prompt_digest, duration):
    expected = {
        "policy": POLICY_VERSION,
        "model_id": MODEL_ID,
        "input_sha256": digest,
        "prompt_sha256": prompt_digest,
    }
    return decode_evidence(body, expected=expected, duration=duration, reasons=REASONS)


def decode_query_result(body, *, digest, duration):
    expected = {
        "policy": QUERY_POLICY_VERSION,
        "model_id": MODEL_ID,
        "input_sha256": digest,
    }
    return decode_evidence(
        body,
        expected=expected,
        duration=duration,
        reasons=REASONS - {"prompt_mismatch"},
    )


def decode_evidence(body, *, expected, duration, reasons):
    if (
        not isinstance(body, dict)
        or set(body)
        != {*expected, "passed", "reason", "valid_speech_ms", "speaker_count"}
        or any(body.get(key) != value for key, value in expected.items())
        or type(body.get("passed")) is not bool
        or not isinstance(body.get("reason"), str)
        or body["reason"] not in reasons
        or type(body.get("valid_speech_ms")) is not int
        or not 0 <= body["valid_speech_ms"] <= duration
        or type(body.get("speaker_count")) is not int
        or not 0 <= body["speaker_count"] <= 51
        or body["passed"] != (body["reason"] == "passed")
        or (
            body["passed"]
            and (body["valid_speech_ms"] < 3000 or body["speaker_count"] != 1)
        )
        or (body["reason"] == "mixed_speaker" and body["speaker_count"] < 2)
        or (
            body["reason"] == "insufficient_audio"
            and (body["valid_speech_ms"] >= 3000 or body["speaker_count"] > 1)
        )
        or (
            body["reason"] == "prompt_mismatch"
            and (body["valid_speech_ms"] < 3000 or body["speaker_count"] != 1)
        )
    ):
        raise QualityError("quality_response_invalid")
    return dict(body)


def read_response(response, *, deadline, expires):
    if (
        response.headers.get("Content-Type", "").split(";", 1)[0] != "application/json"
        or response.headers.get("Content-Encoding", "identity") != "identity"
    ):
        raise QualityError("quality_response_invalid")
    encoded = bytearray()
    while True:
        if time.monotonic() >= deadline or time.time() >= expires:
            raise QualityError("quality_deadline_exceeded", retryable=True)
        chunk = response.raw.read1(8192, decode_content=False)
        if time.monotonic() >= deadline or time.time() >= expires:
            raise QualityError("quality_deadline_exceeded", retryable=True)
        if not chunk:
            break
        encoded.extend(chunk)
        if len(encoded) > MAX_RESPONSE_BYTES:
            raise QualityError("quality_response_too_large")
    try:
        return json.loads(encoded)
    except (ValueError, UnicodeError, RecursionError):
        raise QualityError("quality_response_invalid") from None


def check(wav, *, config, locale, prompt, expires):
    if not isinstance(prompt, str) or not prompt_matches(
        prompt, locale=locale, prompt=prompt
    ):
        raise QualityError("quality_input_invalid")
    body, duration, expires, deadline = request_evidence(
        wav, config=config, expires=expires
    )
    result = interpret(body, duration=duration, locale=locale, prompt=prompt)
    return bind_evidence(result, wav=wav, expires=expires, deadline=deadline)


def check_query(wav, *, config, expires):
    body, duration, expires, deadline = request_evidence(
        wav, config=config, expires=expires
    )
    result = interpret_query(body, duration=duration)
    return bind_evidence(result, wav=wav, expires=expires, deadline=deadline)


def bind_evidence(result, *, wav, expires, deadline):
    result["input_sha256"] = hashlib.sha256(wav).hexdigest()
    if time.time() >= expires or time.monotonic() >= deadline:
        raise QualityError("quality_deadline_exceeded", retryable=True)
    return result


def request_evidence(wav, *, config, expires):
    config.validate()
    duration = audio_duration(wav)
    if type(expires) is not int or expires <= time.time():
        raise QualityError("quality_lease_expired")
    expires = min(expires, int(time.time()) + 30)
    deadline = time.monotonic() + min(30, expires - time.time())
    payload = {
        "model": MODEL_ID,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": "data:audio/wav;base64,"
                                + base64.b64encode(wav).decode("ascii")
                            },
                        }
                    ],
                }
            ]
        },
        "parameters": {
            "format": "wav",
            "sample_rate": "24000",
            "speaker_diarization_enabled": True,
        },
    }
    try:
        with requests.Session() as session:
            session.trust_env = False
            if time.time() >= expires or time.monotonic() >= deadline:
                raise QualityError("quality_deadline_exceeded", retryable=True)
            with session.post(
                config.url,
                json=payload,
                stream=True,
                allow_redirects=False,
                verify=config.ca_bundle,
                timeout=(3, min(30, expires - time.time())),
                headers={
                    "Authorization": "Bearer " + config.api_key.decode("ascii"),
                    "Content-Type": "application/json",
                    "Accept-Encoding": "identity",
                    "X-DashScope-SSE": "disable",
                    "Cache-Control": "no-store",
                },
            ) as response:
                if response.status_code != 200:
                    raise QualityError(
                        "quality_request_rejected",
                        retryable=response.status_code
                        in {408, 429, 500, 502, 503, 504},
                    )
                body = read_response(response, deadline=deadline, expires=expires)
    except (requests.RequestException, Urllib3HTTPError):
        raise QualityError("quality_transport_unavailable", retryable=True) from None
    if time.time() >= expires or time.monotonic() >= deadline:
        raise QualityError("quality_deadline_exceeded", retryable=True)
    return body, duration, expires, deadline
