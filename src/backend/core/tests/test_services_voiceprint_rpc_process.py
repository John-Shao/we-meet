"""Real subprocess/HTTP boundaries, including a child that never reads its stdin."""

import base64
import hashlib
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from uuid import uuid4

import jwt
import pytest

from core.services import voiceprint_rpc_process as service
from core.services.voiceprint_encoder import EncoderError
from core.tests.test_services_voiceprint_encoder import KEY, TOKEN, output

BODY = b"synthetic bounded transport fixture"


@pytest.fixture
def upstream():
    state = SimpleNamespace(
        mode="valid", claims=None, requests=0, stopped=threading.Event()
    )

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            assert self.headers["Authorization"] == "Bearer " + TOKEN.decode()
            claims = jwt.decode(
                self.headers["X-Voiceprint-Permit"],
                KEY,
                algorithms=["HS256"],
                audience="voiceprint-encoder",
                issuer="we-meet",
            )
            assert claims["sha256"] == hashlib.sha256(body).hexdigest()
            state.claims, state.requests = claims, state.requests + 1
            try:
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
                    encoded = b"not JSON"
                else:
                    encoded = json.dumps(
                        {**output(), "input_sha256": hashlib.sha256(body).hexdigest()}
                    ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.config = service.EncoderConfiguration(
        f"http://127.0.0.1:{server.server_port}", TOKEN, KEY
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
    processes = []
    original = service.subprocess.Popen

    def capture(*args, **kwargs):
        assert TOKEN.decode() not in str(args) and KEY.decode() not in str(args)
        assert kwargs.get("stderr") == subprocess.DEVNULL
        process = original(*args, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(service.subprocess, "Popen", capture)
    return processes


def extract(upstream, **changes):
    return service.extract(
        BODY,
        **{
            "config": upstream.config,
            "job_id": uuid4(),
            "lease_expires_at": int(time.time()) + 30,
            "authorized": lambda: True,
            **changes,
        },
    )


def test_real_child_validates_grant_and_result_and_exits(upstream, children):
    result = extract(upstream)
    assert len(result.vector) == 1024 and result.quality["speech_checked"] is False
    assert upstream.requests == 1 and upstream.claims["bytes"] == len(BODY)
    assert children and all(process.poll() == 0 for process in children)
    assert TOKEN.decode() not in repr(upstream.config) and KEY.decode() not in repr(
        upstream.config
    )


@pytest.mark.parametrize(
    "mode,code",
    [
        ("malformed", "encoder_response_invalid"),
        ("too-large", "encoder_response_too_large"),
    ],
)
def test_remote_invalid_payload_is_sanitized_and_child_reaped(
    upstream, children, mode, code
):
    upstream.mode = mode
    with pytest.raises(EncoderError, match=code):
        extract(upstream)
    assert all(process.poll() is not None for process in children)


def test_trickling_headers_cannot_extend_total_deadline(upstream, children):
    upstream.mode = "slow-headers"
    start = time.monotonic()
    with pytest.raises(EncoderError, match="encoder_deadline_exceeded"):
        extract(upstream, seconds=2)
    assert time.monotonic() - start < 4
    assert upstream.requests == 1
    assert all(process.poll() is not None for process in children)


def test_stalled_child_and_blocked_stdin_write_are_reaped(upstream, monkeypatch):
    original = service.subprocess.Popen
    processes = []

    def stall(_args, **kwargs):
        child = original(
            [sys.executable, "-c", "import time; time.sleep(120)"], **kwargs
        )
        processes.append(child)
        return child

    monkeypatch.setattr(service.subprocess, "Popen", stall)
    start = time.monotonic()
    with pytest.raises(EncoderError, match="encoder_deadline_exceeded"):
        service.extract(
            b"x" * 480000,
            config=upstream.config,
            job_id=uuid4(),
            lease_expires_at=int(time.time()) + 30,
            authorized=lambda: True,
            seconds=0.5,
        )
    assert time.monotonic() - start < 3
    assert all(process.poll() is not None for process in processes)


def test_revocation_stops_child_before_result_release(upstream, children):
    calls = []

    def revoked():
        calls.append(None)
        return len(calls) == 1

    with pytest.raises(EncoderError, match="encoder_authorization_revoked"):
        extract(upstream, authorized=revoked)
    assert children and all(process.poll() is not None for process in children)


def test_invalid_initial_authorization_never_spawns_child(upstream, children):
    with pytest.raises(EncoderError, match="encoder_authorization_revoked"):
        extract(upstream, authorized=lambda: False)
    assert not children and upstream.requests == 0


def test_child_deadline_is_independent_of_a_stalled_authorization_callback(
    upstream, children
):
    calls = []

    def slow_authorization():
        calls.append(None)
        if len(calls) > 1:
            time.sleep(0.8)
            assert children[0].poll() is not None
        return True

    with pytest.raises(EncoderError, match="encoder_deadline_exceeded"):
        extract(upstream, authorized=slow_authorization, seconds=0.3)
    assert all(process.poll() is not None for process in children)


@pytest.mark.parametrize(
    "value",
    [
        {"error": [], "retryable": False},
        {"error": "private payload error", "retryable": True},
        {"error": "encoder_response_invalid", "retryable": 1},
        [],
    ],
)
def test_child_output_schema_does_not_leak_untrusted_errors(value):
    with pytest.raises(EncoderError, match="encoder_response_invalid"):
        service.decode_output(json.dumps(value).encode(), "0" * 64)


def test_mounted_configuration_is_bounded_strict_and_private(tmp_path):
    path = tmp_path / "encoder.json"
    good = {
        "url": "https://encoder.internal",
        "api_token": TOKEN.decode(),
        "permit_key": base64.b64encode(KEY).decode(),
        "ca_bundle": True,
    }
    path.write_text(json.dumps(good))
    assert (
        service.load_configuration(path).client().url
        == "https://encoder.internal/v1/embeddings"
    )
    for contents in [
        "x" * 8193,
        "invalid",
        json.dumps({**good, "ca_bundle": False}),
        json.dumps({**good, "url": "http://encoder.internal"}),
        json.dumps({**good, "audio_url": "https://elsewhere.invalid"}),
    ]:
        path.write_text(contents)
        with pytest.raises(EncoderError, match="encoder_configuration_invalid"):
            service.load_configuration(path)
