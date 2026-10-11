"""Actual local S3 HTTP/child lifetime, synthetic bytes and temporary cleanup."""

import hashlib
import threading
import time
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import pytest

from core.services import voiceprint_media_process as transport
from core.services import voiceprint_source_storage as service
from core.services import voiceprint_storage_worker as worker
from core.services.voiceprint_media_process import MediaError
from core.services.voiceprint_source_objects import ObjectReceipt
from core.services.voiceprint_storage_worker import execute


@pytest.fixture
def private_s3():
    state = SimpleNamespace(
        data=b"synthetic private object" * 100,
        mode="ok",
        requests=[],
        stopped=threading.Event(),
        etag='"synthetic-etag"',
        version="synthetic-version",
    )

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, *, head=False):
            parsed = urlsplit(self.path)
            assert parsed.path == "/private-bucket/prefix/record-uploads/synthetic.wav"
            assert self.headers["Authorization"].startswith(
                "AWS4-HMAC-SHA256 Credential=synthetic-access-key/"
            )
            state.requests.append(
                {
                    "method": self.command,
                    "match": self.headers.get("If-Match"),
                    "query": parse_qs(parsed.query),
                }
            )
            try:
                if state.mode == "slow_headers":
                    self.wfile.write(b"HTTP/1.1 200 OK\r\nX-Trickle: ")
                    self.wfile.flush()
                    while not state.stopped.wait(0.1):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                    return
                if state.mode == "missing":
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                data = (
                    state.data
                    if state.mode != "corrupt"
                    else b"wrong content".ljust(len(state.data), b"x")
                )
                size = len(data) + 1 if state.mode == "wrong_size" else len(data)
                self.send_response(200)
                self.send_header("Content-Length", str(size))
                self.send_header("Content-Type", "audio/wav")
                self.send_header(
                    "ETag",
                    '"changed"'
                    if state.mode == "changed_etag"
                    or head
                    and state.mode == "changed_head"
                    else state.etag,
                )
                self.send_header(
                    "x-amz-version-id",
                    "changed" if state.mode == "changed_version" else state.version,
                )
                if state.mode == "gzip":
                    self.send_header("Content-Encoding", "gzip")
                self.end_headers()
                if not head:
                    self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def do_GET(self):
            self.respond()

        def do_HEAD(self):
            self.respond(head=True)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.config = service.StorageConfiguration(
        "private-bucket",
        "prefix",
        "us-east-1",
        f"http://127.0.0.1:{server.server_port}",
        "synthetic-access-key",
        "synthetic-secret-key",
        addressing_style="path",
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
    created = []
    original = transport.MediaTransport.__init__

    def observe(self, *args, **kwargs):
        original(self, *args, **kwargs)
        created.append(self)

    monkeypatch.setattr(transport.MediaTransport, "__init__", observe)
    return created


def proof(server, *, kind="s3_object", version=True):
    if kind == "content_sha256":
        return ObjectReceipt(
            kind,
            "record-uploads/synthetic.wav",
            len(server.data),
            sha256=hashlib.sha256(server.data).hexdigest(),
        )
    return ObjectReceipt(
        kind,
        "record-uploads/synthetic.wav",
        len(server.data),
        etag=server.etag,
        version_id=server.version if version else None,
    )


def download(server, **changes):
    return service.download(
        proof(server),
        config=server.config,
        expires=int(time.time()) + 30,
        authorized=lambda: True,
        **changes,
    )


def test_actual_s3_worker_implementation(private_s3, tmp_path):
    result = execute(
        {
            "receipt": proof(private_s3).payload(),
            "config": private_s3.config.payload(),
            "root": str(tmp_path),
            "expires": int(time.time()) + 30,
        }
    )
    assert result["sha256"] == hashlib.sha256(private_s3.data).hexdigest()


@pytest.mark.parametrize("chunk", [b"late synthetic audio", b""])
def test_slow_read_cannot_write_after_expiry(private_s3, tmp_path, monkeypatch, chunk):
    clock = [1000]
    body = mock.Mock()

    def read(_size):
        clock[0] = 1002
        return chunk

    body.read.side_effect = read
    client = mock.Mock()
    client.get_object.return_value = {
        "ContentLength": len(private_s3.data),
        "ETag": private_s3.etag,
        "VersionId": private_s3.version,
        "Body": body,
    }
    monkeypatch.setattr(worker.boto3, "client", lambda *args, **kwargs: client)
    monkeypatch.setattr(worker.time, "time", lambda: clock[0])
    with pytest.raises(ValueError):
        execute(
            {
                "receipt": proof(private_s3).payload(),
                "config": private_s3.config.payload(),
                "root": str(tmp_path),
                "expires": 1001,
            }
        )
    assert (tmp_path / "source.media").read_bytes() == b""
    client.head_object.assert_not_called()
    body.close.assert_called_once()
    client.close.assert_called_once()


@pytest.mark.parametrize(
    ("kind", "version"),
    [("s3_object", True), ("s3_object", False), ("content_sha256", False)],
)
def test_actual_private_read_conditional_binding_and_cleanup(
    private_s3, children, kind, version
):
    receipt = proof(private_s3, kind=kind, version=version)
    with service.download(
        receipt,
        config=private_s3.config,
        expires=int(time.time()) + 30,
        authorized=lambda: True,
    ) as result:
        path = Path(result.media.path)
        assert path.read_bytes() == private_s3.data
        assert result.sha256 == hashlib.sha256(private_s3.data).hexdigest()
        assert "synthetic-secret" not in repr(result) and "source.media" not in repr(
            result
        )
    assert not path.exists() and not path.parent.exists()
    assert len(private_s3.requests) == 2
    assert [item["method"] for item in private_s3.requests] == ["GET", "HEAD"]
    if kind == "s3_object":
        assert all(item["match"] == private_s3.etag for item in private_s3.requests)
        assert all(
            item["query"] == ({"versionId": [private_s3.version]} if version else {})
            for item in private_s3.requests
        )
    assert children[0].process.poll() == 0
    assert not children[0].reader.is_alive() and not children[0].writer.is_alive()


@pytest.mark.parametrize(
    "mode",
    [
        "changed_etag",
        "changed_version",
        "wrong_size",
        "gzip",
        "missing",
        "changed_head",
    ],
)
def test_bad_object_never_yields_a_file(private_s3, children, mode):
    private_s3.mode = mode
    with pytest.raises(MediaError):
        with download(private_s3):
            pytest.fail("Invalid source must not become readable")
    assert children[0].process.poll() is not None
    assert b"synthetic-secret" not in children[0].output


def test_contents_digest_is_checked_independently_of_declared_length(private_s3):
    receipt = proof(private_s3, kind="content_sha256")
    private_s3.mode = "corrupt"
    with pytest.raises(MediaError):
        with service.download(
            receipt,
            config=private_s3.config,
            expires=int(time.time()) + 30,
            authorized=lambda: True,
        ):
            pytest.fail("Corrupt bytes must never reach the decoder")


@pytest.mark.parametrize("cancel", ["initial", "during", "deadline"])
def test_cancellation_and_hard_deadline_reap_reader(private_s3, children, cancel):
    private_s3.mode = "slow_headers"

    def authorized():
        return cancel != "initial" and (cancel != "during" or not private_s3.requests)

    with pytest.raises(
        MediaError, match="media_authorization_revoked|media_deadline_exceeded"
    ):
        with service.download(
            proof(private_s3),
            config=private_s3.config,
            expires=int(time.time()) + 30,
            authorized=authorized,
            seconds=0.5 if cancel == "deadline" else 5,
        ):
            pytest.fail("Canceled reads must never return")
    if cancel == "initial":
        assert not children and not private_s3.requests
    else:
        assert children[0].process.poll() is not None
        assert not children[0].reader.is_alive() and not children[0].writer.is_alive()


@pytest.mark.parametrize(
    "changes",
    [
        {"endpoint": "http://example.com"},
        {"endpoint": []},
        {"endpoint": {}},
        {"endpoint": 42},
        {"endpoint": "https://storage.invalid\x00"},
        {"endpoint": "https://user:secret@example.com"},
        {"endpoint": "https://example.com/?signed=value"},
        {"access_key": "short"},
        {"secret_key": "bad\nkey"},
        {"ca_bundle": False},
        {"prefix": "../other"},
        {"addressing_style": []},
        {"bucket": "other/bucket"},
    ],
)
def test_no_unsafe_storage_configuration(private_s3, changes):
    with pytest.raises(MediaError, match="configuration_invalid"):
        replace(private_s3.config, **changes).validate()
    assert not private_s3.requests
