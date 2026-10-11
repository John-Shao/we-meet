"""Real isolated S3 subprocess reads of synthetic audio, with source-clock gaps."""

import hashlib
import io
import json
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest
from botocore.config import Config
from storages.backends.s3 import S3Storage

from core.services import capture_diarization_objects as objects
from core.services import capture_diarization_pcm_worker as pcm
from core.services.voiceprint_media_process import MediaError, invoke
from core.services.voiceprint_query_files import leased_directory
from core.services.voiceprint_source_storage import from_storage


def audio(value=123, milliseconds=1000):
    stream = io.BytesIO()
    with wave.open(stream, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(value.to_bytes(2, "little", signed=True) * milliseconds * 16)
    return stream.getvalue()


@pytest.fixture
def private_s3():
    state = SimpleNamespace(data={}, metadata={}, requests=[], mode="ok")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def key(self):
            parsed = urlsplit(self.path)
            assert parsed.path.startswith("/private-bucket/prefix/")
            assert self.headers["Authorization"].startswith(
                "AWS4-HMAC-SHA256 Credential=synthetic-access-key/"
            )
            key = parsed.path.removeprefix("/private-bucket/prefix/")
            query = parse_qs(parsed.query)
            state.requests.append((self.command, key, query))
            return key, query

        def do_GET(self):
            key, _ = self.key()
            body = state.data[key]
            if state.mode == "corrupt":
                body = body[:-1] + bytes([body[-1] ^ 1])
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_PUT(self):
            key, _ = self.key()
            state.data[key] = self.rfile.read(int(self.headers["Content-Length"]))
            state.metadata[key] = {
                "identity-input": self.headers["x-amz-meta-identity-input"],
                "sha256": self.headers["x-amz-meta-sha256"],
            }
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.send_header("x-amz-version-id", "fixed-version")
            self.end_headers()

        def do_HEAD(self):
            key, query = self.key()
            assert query == {"versionId": ["fixed-version"]}
            self.send_response(200)
            self.send_header("Content-Length", str(len(state.data[key])))
            self.send_header("ETag", '"fixed-etag"')
            self.send_header("x-amz-version-id", "fixed-version")
            for name, value in state.metadata[key].items():
                self.send_header("x-amz-meta-" + name, value)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.storage = S3Storage(
        bucket_name="private-bucket",
        location="prefix",
        endpoint_url=f"http://127.0.0.1:{server.server_port}",
        access_key="synthetic-access-key",
        secret_key="synthetic-secret-key",
        addressing_style="path",
        default_acl="private",
        gzip=False,
        client_config=Config(
            proxies={},
            connect_timeout=3,
            read_timeout=5,
            retries={"total_max_attempts": 1},
            s3={"addressing_style": "path"},
        ),
    )
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


def payload(state, root, *, duration=4000):
    record, capture = uuid4(), uuid4()
    chunks = []
    for sequence, start, sample in [(1, 1000, 123), (3, 3000, -456)]:
        identifier, body = uuid4(), audio(sample)
        state.data[f"capture-audio/{record}/{capture}/{identifier}.wav"] = body
        chunks.append(
            {
                "id": str(identifier),
                "sequence": sequence,
                "start_ms": start,
                "duration_ms": 1000,
                "checksum": hashlib.sha256(body).hexdigest(),
                "byte_size": len(body),
                "stored": True,
            }
        )
    return {
        "record_id": str(record),
        "capture_id": str(capture),
        "chunks": chunks,
        "duration_ms": duration,
        "config": from_storage(state.storage).payload(),
        "root": root,
        "expires": int(time.time()) + 30,
    }


def test_actual_pcm_child_preserves_leading_and_middle_gaps(private_s3):
    with leased_directory(int(time.time()) + 30) as root:
        value = payload(private_s3, root)
        result = json.loads(
            invoke(
                value,
                maximum=4096,
                expires=value["expires"],
                authorized=lambda: True,
                seconds=15,
                purpose="capture_pcm",
            )
        )
        body = (Path(root) / "source.media").read_bytes()
        assert result == {"sha256": hashlib.sha256(body).hexdigest(), "size": 128044}
        with wave.open(io.BytesIO(body), "rb") as stream:
            assert stream.getnframes() == 64000
            assert stream.readframes(16000) == bytes(32000)
            assert stream.readframes(16000) == (123).to_bytes(2, "little") * 16000
            assert stream.readframes(16000) == bytes(32000)
            assert (
                stream.readframes(16000)
                == (-456).to_bytes(2, "little", signed=True) * 16000
            )
        assert [request[0] for request in private_s3.requests] == ["GET", "GET"]


def test_actual_pcm_child_rejects_corrupt_chunk(private_s3):
    private_s3.mode = "corrupt"
    with leased_directory(int(time.time()) + 30) as root:
        value = payload(private_s3, root)
        result = json.loads(
            invoke(
                value,
                maximum=4096,
                expires=value["expires"],
                authorized=lambda: True,
                seconds=15,
                purpose="capture_pcm",
            )
        )
        assert result == {
            "error": "media_source_integrity_unavailable",
            "retryable": False,
        }
        assert len(private_s3.requests) == 1


def test_two_hour_pcm_is_streamed_with_uncompressed_trailing_silence(private_s3):
    with leased_directory(int(time.time()) + 30) as root:
        value = payload(private_s3, root, duration=7200000)
        result = pcm.execute(value)
        path = Path(root) / "source.media"
        assert result["size"] == path.stat().st_size == 230400044
        with wave.open(str(path), "rb") as stream:
            assert stream.getnframes() == 115200000
            stream.setpos(115199984)
            assert stream.readframes(16) == bytes(32)


@pytest.mark.parametrize("change", ["duplicate", "overlap", "boolean", "outside"])
def test_invalid_manifest_is_rejected_before_storage_io(private_s3, change):
    with leased_directory(int(time.time()) + 30) as root:
        value = payload(private_s3, root)
        if change == "duplicate":
            value["chunks"][1]["id"] = value["chunks"][0]["id"]
        elif change == "overlap":
            value["chunks"][1]["start_ms"] = 1500
        elif change == "boolean":
            value["duration_ms"] = True
        else:
            value["root"] = str(Path(root).parent)
        with pytest.raises(ValueError):
            pcm.execute(value)
        assert not private_s3.requests


def test_revoked_pcm_never_reads_storage(private_s3):
    with leased_directory(int(time.time()) + 30) as root:
        value = payload(private_s3, root)
        with pytest.raises(MediaError, match="authorization_revoked"):
            invoke(
                value,
                maximum=4096,
                expires=value["expires"],
                authorized=lambda: False,
                seconds=15,
                purpose="capture_pcm",
            )
        assert not private_s3.requests


@pytest.mark.parametrize("duplicate", [False, True])
def test_metadata_names_are_case_insensitive_but_ambiguous_names_are_rejected(
    duplicate,
):
    row = SimpleNamespace(pk=uuid4(), sha256="a" * 64)
    metadata = {"Identity-Input": str(row.pk), "Sha256": row.sha256}
    if duplicate:
        metadata["sha256"] = "b" * 64
    assert objects._metadata_matches({"Metadata": metadata}, row) is not duplicate


def test_dedicated_bucket_keeps_private_timeout_and_retry_bounds(
    private_s3, settings, monkeypatch
):
    settings.MEETING_CAPTURE_DIARIZATION_BUCKET_NAME = "derivative-bucket"
    settings.STORAGES = {
        "default": {
            "BACKEND": "storages.backends.s3.S3Storage",
            "OPTIONS": {
                "endpoint_url": private_s3.storage.endpoint_url,
                "access_key": "synthetic-access-key",
                "secret_key": "synthetic-secret-key",
                "location": "prefix",
                "addressing_style": "path",
            },
        }
    }
    monkeypatch.setattr(objects, "audio_storage", lambda: private_s3.storage)
    storage = objects.storage()
    assert storage.bucket_name == "derivative-bucket"
    assert storage.client_config.connect_timeout == 3
    assert storage.client_config.read_timeout == 5
    assert storage.client_config.retries["total_max_attempts"] == 1
    assert storage.client_config.proxies == {}
