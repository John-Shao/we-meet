"""Killable encoder transport; no Django, audio files, payload logs or secrets in argv."""

import base64
import binascii
import hashlib
import json
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from core.services.voiceprint_encoder import (
    DIMENSION,
    FEATURE_SPACE,
    MAX_AUDIO_BYTES,
    MAX_RESULT_BYTES,
    MODEL_ID,
    MODEL_REVISION,
    PREPROCESS_VERSION,
    EncoderClient,
    EncoderError,
    decode_result,
)

MAX_INPUT_BYTES = MAX_AUDIO_BYTES * 4 // 3 + 16384
MAX_PROCESS_SECONDS = 35
ERROR_CODES = frozenset(
    {
        "audio_size_invalid",
        "encoder_configuration_invalid",
        "encoder_job_invalid",
        "encoder_lease_expired",
        "encoder_response_invalid",
        "encoder_deadline_exceeded",
        "encoder_response_too_large",
        "encoder_request_rejected",
        "encoder_transport_unavailable",
        "encoder_worker_input_invalid",
    }
)


@dataclass(frozen=True)
class EncoderConfiguration:
    url: str
    api_token: bytes = field(repr=False)
    permit_key: bytes = field(repr=False)
    ca_bundle: bool | str = True

    def client(self):
        return EncoderClient(
            self.url,
            api_token=self.api_token,
            permit_key=self.permit_key,
            ca_bundle=self.ca_bundle,
        )

    def payload(self):
        return {
            "url": self.url,
            "api_token": self.api_token.decode("ascii"),
            "permit_key": base64.b64encode(self.permit_key).decode("ascii"),
            "ca_bundle": self.ca_bundle,
        }


def configuration(value):
    try:
        if not isinstance(value, dict) or set(value) != {
            "url",
            "api_token",
            "permit_key",
            "ca_bundle",
        }:
            raise ValueError
        if not isinstance(value["api_token"], str) or not isinstance(
            value["permit_key"], str
        ):
            raise ValueError
        result = EncoderConfiguration(
            value["url"],
            value["api_token"].encode("ascii"),
            base64.b64decode(value["permit_key"], validate=True),
            value["ca_bundle"],
        )
        result.client()
        return result
    except (ValueError, UnicodeError, binascii.Error):
        raise EncoderError("encoder_configuration_invalid") from None


def load_configuration(path):
    try:
        with Path(path).open("rb") as stream:
            encoded = stream.read(8193)
        if len(encoded) > 8192:
            raise ValueError
        return configuration(json.loads(encoded))
    except (OSError, TypeError, ValueError, RecursionError):
        raise EncoderError("encoder_configuration_invalid") from None


def result_payload(result):
    return {
        "feature_space": FEATURE_SPACE,
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "preprocess_version": PREPROCESS_VERSION,
        "dimension": DIMENSION,
        "sample_rate": 24000,
        "normalization": "l2",
        "input_sha256": result.input_sha256,
        "vector": list(result.vector),
        "quality": result.quality,
    }


class ProcessTransport:
    """Own the only child and bounded pipes, including cancellation cleanup."""

    def __init__(self, payload, *, deadline, purpose="encoder"):
        modules = {
            "encoder": "core.services.voiceprint_rpc_process",
            "quality": "core.services.voiceprint_quality_process",
        }
        if purpose not in modules:
            raise EncoderError("encoder_configuration_invalid")
        self.payload = payload
        self.output = b""
        self.read_done = threading.Event()
        self.expired = threading.Event()
        try:
            self.process = subprocess.Popen(  # noqa: S603 -- Fixed module, bounded stdin IPC.
                [sys.executable, "-m", modules[purpose]],
                cwd=str(Path(__file__).resolve().parents[2]),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW
                if sys.platform == "win32"
                else 0,
            )
        except OSError:
            raise EncoderError("encoder_worker_unavailable", retryable=True) from None
        self.writer = threading.Thread(target=self.write_input, daemon=True)
        self.reader = threading.Thread(target=self.read_output, daemon=True)
        self.timer = threading.Timer(max(0, deadline - time.monotonic()), self.expire)
        self.timer.daemon = True

    def expire(self):
        # A database authorization callback may itself stall. Terminate the
        # transport independently of the parent thread's next polling step.
        self.expired.set()
        try:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def write_input(self):
        try:
            self.process.stdin.write(self.payload)
        except OSError:
            pass
        finally:
            try:
                self.process.stdin.close()
            except OSError:
                pass

    def read_output(self):
        try:
            self.output = self.process.stdout.read(MAX_RESULT_BYTES + 1)
        except OSError:
            self.output = b""
        finally:
            self.process.stdout.close()
            self.read_done.set()

    def __enter__(self):
        self.timer.start()
        self.writer.start()
        self.reader.start()
        return self

    def __exit__(self, *_exception):
        self.timer.cancel()
        try:
            if self.process.poll() is None:
                self.process.kill()
        except OSError:
            pass  # It may have exited between poll and kill.
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            raise EncoderError("encoder_worker_unavailable", retryable=True) from None
        self.writer.join(timeout=0.5)
        self.reader.join(timeout=0.5)
        self.timer.join(timeout=0.5)


def wait_output(transport, *, deadline, authorized):
    next_authorization = 0.0
    while True:
        now = time.monotonic()
        if now >= deadline:
            raise EncoderError("encoder_deadline_exceeded", retryable=True)
        if now >= next_authorization:
            if not authorized():
                raise EncoderError("encoder_authorization_revoked")
            next_authorization = now + 0.25
        if transport.read_done.is_set() and len(transport.output) > MAX_RESULT_BYTES:
            raise EncoderError("encoder_response_too_large")
        if transport.expired.is_set() or time.monotonic() >= deadline:
            raise EncoderError("encoder_deadline_exceeded", retryable=True)
        if transport.process.poll() is not None and transport.read_done.is_set():
            break
        time.sleep(min(0.05, max(0, deadline - now)))
    if transport.process.returncode != 0 or not transport.output:
        raise EncoderError("encoder_worker_unavailable", retryable=True)
    if not authorized():
        raise EncoderError("encoder_authorization_revoked")
    return transport.output


def decode_output(encoded, digest):
    try:
        result = json.loads(encoded)
    except (ValueError, UnicodeError, RecursionError):
        raise EncoderError("encoder_response_invalid") from None
    if isinstance(result, dict) and set(result) == {"error", "retryable"}:
        if (
            not isinstance(result["error"], str)
            or result["error"] not in ERROR_CODES
            or type(result["retryable"]) is not bool
        ):
            raise EncoderError("encoder_response_invalid")
        raise EncoderError(result["error"], retryable=result["retryable"])
    return decode_result(result, digest)


def extract(  # noqa: PLR0913 -- Explicit private request and authorization lease.
    wav, *, config, job_id, lease_expires_at, authorized, seconds=MAX_PROCESS_SECONDS
):
    """Total deadline includes startup, upload, headers, body and native waits."""
    if type(seconds) not in (float, int) or not 0 < seconds <= MAX_PROCESS_SECONDS:
        raise EncoderError("encoder_configuration_invalid")
    if not isinstance(wav, bytes) or not 1 <= len(wav) <= MAX_AUDIO_BYTES:
        raise EncoderError("audio_size_invalid")
    if type(lease_expires_at) is not int or lease_expires_at <= time.time():
        raise EncoderError("encoder_lease_expired")
    if not authorized():
        raise EncoderError("encoder_authorization_revoked")
    deadline = time.monotonic() + min(seconds, lease_expires_at - time.time())
    payload = json.dumps(
        {
            "config": config.payload(),
            "wav": base64.b64encode(wav).decode("ascii"),
            "job_id": str(job_id),
            "lease_expires_at": lease_expires_at,
        },
        separators=(",", ":"),
    ).encode("ascii")
    if len(payload) > MAX_INPUT_BYTES:
        raise EncoderError("encoder_worker_input_invalid")
    with ProcessTransport(payload, deadline=deadline) as transport:
        encoded = wait_output(transport, deadline=deadline, authorized=authorized)
    if time.monotonic() >= deadline:
        raise EncoderError("encoder_deadline_exceeded", retryable=True)
    return decode_output(encoded, hashlib.sha256(wav).hexdigest())


def main():
    """One-shot child entry point; stdout is bounded machine IPC, never a log."""
    try:
        encoded = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(encoded) > MAX_INPUT_BYTES:
            raise ValueError
        value = json.loads(encoded)
        if not isinstance(value, dict) or set(value) != {
            "config",
            "wav",
            "job_id",
            "lease_expires_at",
        }:
            raise ValueError
        if not isinstance(value["wav"], str):
            raise ValueError
        wav = base64.b64decode(value["wav"], validate=True)
        client = configuration(value["config"]).client()
        result = client.extract(
            wav, job_id=value["job_id"], lease_expires_at=value["lease_expires_at"]
        )
        response = result_payload(result)
    except EncoderError as error:
        response = {
            "error": str(error)
            if str(error) in ERROR_CODES
            else "encoder_worker_input_invalid",
            "retryable": error.retryable,
        }
    except (ValueError, TypeError, UnicodeError, RecursionError, binascii.Error):
        response = {"error": "encoder_worker_input_invalid", "retryable": False}
    encoded = json.dumps(response, separators=(",", ":"), allow_nan=False).encode(
        "ascii"
    )
    if len(encoded) > MAX_RESULT_BYTES:
        encoded = b'{"error":"encoder_response_too_large","retryable":false}'
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
