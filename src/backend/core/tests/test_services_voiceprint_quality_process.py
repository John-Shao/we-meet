"""Actual loopback HTTP/subprocess cancellation; synthetic provider evidence only."""

import base64
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from core.services import voiceprint_quality as quality
from core.services import voiceprint_quality_process as service
from core.services import voiceprint_rpc_process as transport
from core.tests.services.test_voiceprint_enrollment import wav
from core.tests.test_services_voiceprint_quality import output, prompt_for

KEY = b"synthetic-quality-key-0123456789"


@pytest.fixture
def short_asr():
    state = SimpleNamespace(
        requests=0,
        mode="ok",
        prompt=prompt_for(),
        duration=3000,
        stopped=threading.Event(),
    )

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            assert self.path == quality.API_PATH
            assert self.headers["Authorization"] == "Bearer " + KEY.decode()
            assert self.headers["X-DashScope-SSE"] == "disable"
            length = int(self.headers["Content-Length"])
            assert 0 < length <= 660000
            value = json.loads(self.rfile.read(length))
            assert set(value) == {"model", "input", "parameters"}
            assert value["model"] == quality.MODEL_ID
            assert value["parameters"] == {
                "format": "wav",
                "sample_rate": "24000",
                "speaker_diarization_enabled": True,
            }
            message = value["input"]["messages"][0]
            assert message["role"] == "user" and len(message["content"]) == 1
            content = message["content"][0]
            assert (
                set(content) == {"type", "input_audio"}
                and content["type"] == "input_audio"
            )
            uri = content["input_audio"]["data"]
            assert uri.startswith("data:audio/wav;base64,")
            audio = base64.b64decode(uri.split(",", 1)[1], validate=True)
            assert quality.audio_duration(audio) == state.duration
            state.requests += 1
            state.input_digest = hashlib.sha256(audio).hexdigest()
            try:
                if state.mode == "delayed-headers":
                    state.stopped.wait(4)
                if state.mode == "slow-headers":
                    self.wfile.write(b"HTTP/1.1 200 OK\r\nX-Trickle: ")
                    self.wfile.flush()
                    while not state.stopped.wait(0.1):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                    return
                if state.mode == "too-large":
                    encoded = b"x" * 65537
                elif state.mode == "malformed":
                    encoded = b"not JSON; private provider diagnostic"
                elif state.mode in {"503", "401", "302"}:
                    encoded = b'{"message":"private provider diagnostic"}'
                else:
                    encoded = json.dumps(
                        output(state.prompt, duration=state.duration)
                    ).encode()
                self.send_response(int(state.mode) if state.mode.isdigit() else 200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                if state.mode == "compressed":
                    self.send_header("Content-Encoding", "gzip")
                if state.mode == "302":
                    self.send_header("Location", "http://example.invalid/private-audio")
                self.end_headers()
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.config = quality.QualityConfiguration(
        f"http://127.0.0.1:{server.server_port}" + quality.API_PATH, KEY
    )
    try:
        yield state
    finally:
        state.stopped.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.fixture
def children(monkeypatch):
    original, processes = transport.subprocess.Popen, []

    def capture(*args, **kwargs):
        assert KEY.decode() not in str(args)
        assert "voiceprint_quality_process" in str(args)
        assert kwargs["stderr"] == transport.subprocess.DEVNULL
        child = original(*args, **kwargs)
        processes.append(child)
        return child

    monkeypatch.setattr(transport.subprocess, "Popen", capture)
    return processes


def extract(short_asr, **changes):
    return service.extract(
        wav(seconds=short_asr.duration // 1000),
        **{
            "config": short_asr.config,
            "locale": "en",
            "prompt": short_asr.prompt,
            "expires": int(time.time()) + 30,
            "authorized": lambda: True,
            **changes,
        },
    )


def test_real_child_sends_no_answer_and_returns_only_fixed_evidence(
    short_asr, children
):
    result = extract(short_asr)
    assert result["passed"] and result["input_sha256"] == short_asr.input_digest
    assert short_asr.requests == 1 and all(child.poll() == 0 for child in children)
    assert "text" not in result and short_asr.prompt not in repr(result)


def test_provider_compute_can_take_more_than_three_seconds(short_asr, children):
    short_asr.mode = "delayed-headers"
    result = extract(short_asr)
    assert result["passed"] and short_asr.requests == 1
    assert all(child.poll() == 0 for child in children)


@pytest.mark.parametrize(
    "mode,code,retryable",
    [
        ("malformed", "quality_response_invalid", False),
        ("too-large", "quality_response_too_large", False),
        ("compressed", "quality_response_invalid", False),
        ("503", "quality_request_rejected", True),
        ("401", "quality_request_rejected", False),
        ("302", "quality_request_rejected", False),
    ],
)
def test_failure_contracts_do_not_leak_provider_body_or_credentials(
    short_asr, children, mode, code, retryable
):
    short_asr.mode = mode
    with pytest.raises(quality.QualityError, match=code) as error:
        extract(short_asr)
    assert error.value.retryable is retryable
    assert "private provider" not in str(error.value)
    assert all(child.poll() is not None for child in children)


def test_trickling_headers_have_a_total_deadline_and_child_is_reaped(
    short_asr, children
):
    short_asr.mode = "slow-headers"
    started = time.monotonic()
    with pytest.raises(quality.QualityError, match="quality_deadline_exceeded"):
        extract(short_asr, seconds=1.5)
    assert time.monotonic() - started < 4
    assert all(child.poll() is not None for child in children)


def test_revocation_never_releases_a_late_quality_result(short_asr, children):
    short_asr.mode = "slow-headers"
    started = time.monotonic()
    with pytest.raises(quality.QualityError, match="quality_authorization_revoked"):
        extract(short_asr, authorized=lambda: time.monotonic() - started < 0.75)
    assert all(child.poll() is not None for child in children)


def test_initial_revocation_never_starts_a_child_or_upload(short_asr, children):
    with pytest.raises(quality.QualityError, match="quality_authorization_revoked"):
        extract(short_asr, authorized=lambda: False)
    assert not children and short_asr.requests == 0
