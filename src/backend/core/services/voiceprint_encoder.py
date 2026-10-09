"""Private encoder RPC, invoked only after a voiceprint job's authorization checks.

This transport neither grants consent nor enrolls a person. Its short-lived grant
is bounded to one payload and model space; job/source/profile leases must still
be rechecked before any result is persisted by the job service.
"""

import hashlib
import json
import math
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import jwt
import requests
from urllib3.exceptions import HTTPError as Urllib3HTTPError

MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
MODEL_REVISION = "5d83992436eae1d760afd27aff78a71d676296fc"
PREPROCESS_VERSION = "qwen3tts-24k-mel128-fp32-l2-v1"
FEATURE_SPACE = (
    "qwen3tts-speaker:2ce8c66530f607837b8cdb4f95ce4a359bfee604dc2a2731adc46b89866c5df5"
)
MAX_AUDIO_BYTES = 484096
MAX_RESULT_BYTES = 65536
DIMENSION = 1024
RPC_SECONDS = 30


class EncoderError(ValueError):
    """Sanitized failure code; never expose request data or upstream tracebacks."""

    def __init__(self, code, *, retryable=False):
        super().__init__(code)
        self.retryable = retryable


@dataclass(frozen=True)
class EncoderResult:
    vector: tuple[float, ...] = field(repr=False)
    quality: dict = field(repr=False)
    input_sha256: str = field(repr=False)
    feature_space: str = FEATURE_SPACE


def read_response(response, *, deadline, expires):
    if (
        response.headers.get("Content-Type", "").split(";", 1)[0] != "application/json"
        or response.headers.get("Content-Encoding", "identity") != "identity"
    ):
        raise EncoderError("encoder_response_invalid")
    payload_bytes = bytearray()
    while True:
        if time.monotonic() >= deadline or time.time() >= expires:
            raise EncoderError("encoder_deadline_exceeded", retryable=True)
        # Return available bytes instead of filling a chunk from a slow response.
        chunk = response.raw.read1(8192, decode_content=False)
        if time.monotonic() >= deadline or time.time() >= expires:
            raise EncoderError("encoder_deadline_exceeded", retryable=True)
        if not chunk:
            break
        payload_bytes.extend(chunk)
        if len(payload_bytes) > MAX_RESULT_BYTES:
            raise EncoderError("encoder_response_too_large")
    try:
        return json.loads(payload_bytes)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise EncoderError("encoder_response_invalid") from error


def decode_result(body, expected_digest):
    if not isinstance(body, dict):
        raise EncoderError("encoder_response_invalid")
    expected = {
        "feature_space": FEATURE_SPACE,
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "preprocess_version": PREPROCESS_VERSION,
        "dimension": DIMENSION,
        "sample_rate": 24000,
        "normalization": "l2",
        "input_sha256": expected_digest,
    }
    if any(
        type(body.get(key)) is not type(value) or body[key] != value
        for key, value in expected.items()
    ):
        raise EncoderError("encoder_response_invalid")
    vector = body.get("vector")
    if not isinstance(vector, list) or len(vector) != DIMENSION:
        raise EncoderError("encoder_response_invalid")
    if any(
        type(value) not in (float, int)
        or abs(value) > 1.00001
        or not math.isfinite(value)
        for value in vector
    ):
        raise EncoderError("encoder_response_invalid")
    if abs(math.sqrt(math.fsum(float(value) ** 2 for value in vector)) - 1) > 1e-4:
        raise EncoderError("encoder_response_invalid")
    quality = body.get("quality")
    if not isinstance(quality, dict) or set(quality) != {
        "duration_ms",
        "rms_dbfs",
        "ac_rms_dbfs",
        "clipped_fraction",
        "validation",
        "speech_checked",
        "speaker_consistency_checked",
    }:
        raise EncoderError("encoder_response_invalid")
    if (
        type(quality["duration_ms"]) is not int
        or not 3000 <= quality["duration_ms"] <= 10000
        or quality["validation"] != "signal-only-v1"
        or quality["speech_checked"] is not False
        or quality["speaker_consistency_checked"] is not False
        or any(
            type(quality[key]) not in (int, float)
            or abs(quality[key]) > 240
            or not math.isfinite(quality[key])
            for key in ("rms_dbfs", "ac_rms_dbfs", "clipped_fraction")
        )
        or not -240 <= quality["rms_dbfs"] <= 0
        or not -60.001 <= quality["ac_rms_dbfs"] <= 0
        or not 0 <= quality["clipped_fraction"] <= 0.02
    ):
        raise EncoderError("encoder_response_invalid")
    return EncoderResult(
        tuple(float(value) for value in vector), dict(quality), expected_digest
    )


class EncoderClient:
    def __init__(self, url, *, api_token: bytes, permit_key: bytes, ca_bundle=True):
        try:
            if not isinstance(url, str) or any(char.isspace() for char in url):
                raise ValueError
            parsed = urlsplit(url)
            if parsed.port is not None and not 1 <= parsed.port <= 65535:
                raise ValueError
        except ValueError:
            raise EncoderError("encoder_configuration_invalid") from None
        if (
            not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
            or parsed.scheme not in ("http", "https")
            or (
                parsed.scheme == "http"
                and parsed.hostname not in ("localhost", "127.0.0.1", "::1")
            )
            or not isinstance(api_token, bytes)
            or not 32 <= len(api_token) <= 256
            or any(byte < 33 or byte > 126 for byte in api_token)
            or not isinstance(permit_key, bytes)
            or not 32 <= len(permit_key) <= 4096
            or api_token == permit_key
            or not (
                ca_bundle is True
                or (isinstance(ca_bundle, str) and bool(ca_bundle.strip()))
            )
        ):
            raise EncoderError("encoder_configuration_invalid")
        self.url = url.rstrip("/") + "/v1/embeddings"
        self.api_token = api_token
        self.permit_key = permit_key
        self.ca_bundle = ca_bundle

    def extract(self, wav: bytes, *, job_id, lease_expires_at) -> EncoderResult:
        if not isinstance(wav, bytes) or not 1 <= len(wav) <= MAX_AUDIO_BYTES:
            raise EncoderError("audio_size_invalid")
        try:
            identifier = str(UUID(str(job_id)))
        except (ValueError, TypeError, AttributeError) as error:
            raise EncoderError("encoder_job_invalid") from error
        now = int(time.time())
        if type(lease_expires_at) is not int or lease_expires_at <= now:
            raise EncoderError("encoder_lease_expired")
        expires = min(lease_expires_at, now + 120)
        deadline = time.monotonic() + min(RPC_SECONDS, expires - time.time())
        digest = hashlib.sha256(wav).hexdigest()
        permit = jwt.encode(
            {
                "iss": "we-meet",
                "aud": "voiceprint-encoder",
                "sub": identifier,
                "jti": str(uuid4()),
                "iat": now,
                "nbf": now,
                "exp": expires,
                "scope": "embedding",
                "sha256": digest,
                "bytes": len(wav),
                "space": FEATURE_SPACE,
            },
            self.permit_key,
            algorithm="HS256",
        )
        try:
            # Avoid proxy/environment redirects of sensitive audio and credentials.
            with requests.Session() as session:
                session.trust_env = False
                with session.post(
                    self.url,
                    data=wav,
                    stream=True,
                    allow_redirects=False,
                    verify=self.ca_bundle,
                    timeout=(3, min(3, expires - now)),
                    headers={
                        "Authorization": "Bearer " + self.api_token.decode("ascii"),
                        "X-Voiceprint-Permit": permit,
                        "Content-Type": "audio/wav",
                        "Cache-Control": "no-store",
                        "Accept-Encoding": "identity",
                    },
                ) as response:
                    if response.status_code != 200:
                        raise EncoderError(
                            "encoder_request_rejected",
                            retryable=response.status_code
                            in (408, 429, 500, 502, 503, 504),
                        )
                    payload = read_response(
                        response, deadline=deadline, expires=expires
                    )
        except (requests.RequestException, Urllib3HTTPError):
            raise EncoderError(
                "encoder_transport_unavailable", retryable=True
            ) from None
        if time.time() >= expires:
            raise EncoderError("encoder_lease_expired")
        return decode_result(payload, digest)
