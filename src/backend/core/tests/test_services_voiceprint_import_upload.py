"""Real native worker and signed local HTTP PUT; synthetic audio only."""

import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest

from core.services import voiceprint_media_process as transport
from core.services.voiceprint_media import MediaFile
from core.services.voiceprint_media_process import MediaError
from core.services.voiceprint_source_storage import StorageConfiguration
from core.tests.services.test_recording_import_inputs import mono_wav


@pytest.fixture
def private_put():
    state = SimpleNamespace(
        identifier=uuid4(),
        data=None,
        requests=[],
        mode="ok",
        stopped=threading.Event(),
        put_started=threading.Event(),
        version="pinned-native-version",
    )

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def identity(self):
            parsed = urlsplit(self.path)
            assert (
                parsed.path
                == f"/private-bucket/prefix/record-uploads/identity-input-{state.identifier}.wav"
            )
            assert self.headers["Authorization"].startswith(
                "AWS4-HMAC-SHA256 Credential=synthetic-access-key/"
            )
            state.requests.append(
                {"method": self.command, "query": parse_qs(parsed.query)}
            )

        def do_PUT(self):
            self.identity()
            state.put_started.set()
            try:
                state.data = self.rfile.read(int(self.headers["Content-Length"]))
                state.metadata = {
                    "identity-input": self.headers["x-amz-meta-identity-input"],
                    "sha256": self.headers["x-amz-meta-sha256"],
                }
                if state.mode == "slow_headers":
                    self.wfile.write(b"HTTP/1.1 200 OK\r\nX-Trickle: ")
                    self.wfile.flush()
                    while not state.stopped.wait(0.1):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                    return
                self.send_response(200)
                self.send_header("Content-Length", "0")
                if state.mode != "unversioned":
                    self.send_header("x-amz-version-id", state.version)
                self.end_headers()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def do_HEAD(self):
            self.identity()
            assert state.requests[-1]["query"] == {"versionId": [state.version]}
            self.send_response(200)
            self.send_header("Content-Length", str(len(state.data)))
            self.send_header("ETag", '"native-fixed"')
            self.send_header("x-amz-version-id", state.version)
            for key, value in state.metadata.items():
                self.send_header("x-amz-meta-" + key, value)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.config = StorageConfiguration(
        "private-bucket",
        "prefix",
        None,
        f"http://127.0.0.1:{server.server_port}",
        "synthetic-access-key",
        "synthetic-secret-key",
        addressing_style="path",
    ).validate()
    try:
        yield state
    finally:
        state.stopped.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


def payload(state, tmp_path):
    source = tmp_path / "diarization.wav"
    source.write_bytes(mono_wav())
    return {
        "source": MediaFile(str(source), str(tmp_path)).payload(),
        "config": state.config.payload(),
        "expires": int(time.time()) + 15,
        "input_id": str(state.identifier),
    }


def test_actual_put_worker_streams_only_synthetic_file_and_pins_head(
    private_put, tmp_path
):
    value = payload(private_put, tmp_path)
    result = json.loads(
        transport.invoke(
            value,
            maximum=4096,
            expires=value["expires"],
            authorized=lambda: True,
            seconds=10,
            purpose="import_upload",
        )
    )
    assert private_put.data == mono_wav()
    assert result["sha256"] == hashlib.sha256(mono_wav()).hexdigest()
    assert result["receipt"]["version_id"] == private_put.version
    assert [request["method"] for request in private_put.requests] == ["PUT", "HEAD"]


def test_actual_unversioned_put_cannot_create_receipt(private_put, tmp_path):
    private_put.mode = "unversioned"
    value = payload(private_put, tmp_path)
    with pytest.raises(MediaError, match="decode_unavailable"):
        transport.invoke(
            value,
            maximum=4096,
            expires=value["expires"],
            authorized=lambda: True,
            seconds=10,
            purpose="import_upload",
        )
    assert [request["method"] for request in private_put.requests] == ["PUT"]


@pytest.mark.parametrize("stop", ["revoke", "timeout"])
def test_actual_slow_put_worker_is_terminal_on_revoke_or_timeout(
    private_put, tmp_path, monkeypatch, stop
):
    private_put.mode = "slow_headers"
    value = payload(private_put, tmp_path)
    processes = []
    original = transport.MediaTransport

    class ObservedTransport(original):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            processes.append(self.process)

    monkeypatch.setattr(transport, "MediaTransport", ObservedTransport)
    started = time.monotonic()
    with pytest.raises(
        MediaError,
        match="authorization_revoked" if stop == "revoke" else "deadline_exceeded",
    ):
        transport.invoke(
            value,
            maximum=4096,
            expires=value["expires"],
            authorized=lambda: stop != "revoke" or not private_put.put_started.is_set(),
            seconds=3,
            purpose="import_upload",
        )
    assert time.monotonic() - started < 6
    assert processes and processes[0].poll() is not None
    assert private_put.put_started.is_set()
    assert not any(request["method"] == "HEAD" for request in private_put.requests)
