"""Actual S3 HTTP/media workers across preflight and publication; no paid ASR."""

import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

import pytest
from botocore.config import Config
from storages.backends.s3 import S3Storage

from core import models
from core.factories import UserFactory
from core.services import recording_import_inputs as inputs
from core.services import uploaded_recordings as uploads
from core.services import voiceprint_media as media
from core.services import voiceprint_query_files as query_files
from core.services import voiceprint_source_storage as source_storage
from core.services import voiceprint_sources as sources
from core.services.voiceprint_source_objects import ObjectReceipt
from core.tests.services.test_recording_identity_preflight import (
    import_enabled,
    options,
)
from core.tests.services.test_voiceprint_candidates import matching_enabled, register
from core.tests.services.test_voiceprint_consent import enabled
from core.tests.test_services_voiceprint_media import config, tones

pytestmark = pytest.mark.django_db


@pytest.fixture
def storage_server():
    state = SimpleNamespace(objects={}, versions={}, metadata={}, requests=[])

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def object_key(self):
            parsed = urlsplit(self.path)
            prefix = "/private-bucket/prefix/"
            assert parsed.path.startswith(prefix)
            key = parsed.path[len(prefix) :]
            state.requests.append(
                {"method": self.command, "key": key, "query": parse_qs(parsed.query)}
            )
            return key

        def do_PUT(self):
            key = self.object_key()
            state.objects[key] = self.rfile.read(int(self.headers["Content-Length"]))
            state.versions[key] = "v-mono"
            state.metadata[key] = {
                "identity-input": self.headers["x-amz-meta-identity-input"],
                "sha256": self.headers["x-amz-meta-sha256"],
            }
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.send_header("x-amz-version-id", "v-mono")
            self.end_headers()

        def respond(self, head=False):
            key = self.object_key()
            assert state.requests[-1]["query"] == {"versionId": [state.versions[key]]}
            self.send_response(200)
            self.send_header("Content-Length", str(len(state.objects[key])))
            self.send_header("ETag", '"' + state.versions[key] + '"')
            self.send_header("x-amz-version-id", state.versions[key])
            for name, value in state.metadata.get(key, {}).items():
                self.send_header("x-amz-meta-" + name, value)
            self.end_headers()
            if not head:
                self.wfile.write(state.objects[key])

        def do_HEAD(self):
            self.respond(head=True)

        def do_GET(self):
            self.respond()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.storage = S3Storage(
        bucket_name="private-bucket",
        location="prefix",
        access_key="synthetic-access-key",
        secret_key="synthetic-secret-key",
        endpoint_url=f"http://127.0.0.1:{server.server_port}",
        addressing_style="path",
        custom_domain=None,
        client_config=Config(
            signature_version="s3v4",
            proxies={},
            connect_timeout=3,
            read_timeout=3,
            s3={"addressing_style": "path"},
        ),
    )
    try:
        yield state
    finally:
        state.storage.connection.meta.client.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


@pytest.mark.parametrize("channels", [1, 2])
def test_native_preflight_asr_and_identity_use_one_pinned_input(  # noqa: PLR0913 -- Isolated HTTP, native binaries, filesystem and rollout fixtures.
    storage_server,
    config,
    tmp_path,
    monkeypatch,
    settings,
    channels,
):
    actor = UserFactory()
    register(actor)
    original = tones(tmp_path / "synthetic.wav", rate=24000, channels=channels)
    original_bytes = Path(original.path).read_bytes()
    job = uploads.create(
        actor,
        uuid4(),
        SimpleUploadedFile("synthetic.wav", original_bytes, "audio/wav"),
        options(actor),
    )
    parent = ObjectReceipt(
        "s3_object",
        job.storage_name,
        job.size,
        etag='"v-original"',
        version_id="v-original",
    )
    job.configuration["_identity_source"] = parent.payload()
    job.save(update_fields=["configuration"])
    storage_server.objects[job.storage_name] = original_bytes
    storage_server.versions[job.storage_name] = "v-original"
    settings.QWEN_FILE_ASR_STORAGE_ENDPOINT_URL = ""
    config_path = tmp_path / "actual-media.json"
    config_path.write_text(json.dumps(config.payload()))
    settings.MEETING_VOICEPRINT_MEDIA_CONFIG_FILE = str(config_path)
    private_root = tmp_path / "private-query"
    private_root.mkdir(mode=0o700)
    monkeypatch.setattr(query_files, "directory", lambda: private_root)
    with (
        mock.patch.object(
            uploads, "audio_storage", return_value=storage_server.storage
        ),
        mock.patch.object(
            uploads.preflight, "audio_storage", return_value=storage_server.storage
        ),
        mock.patch.object(
            uploads.provider, "submit", return_value="local-contract-task"
        ) as paid,
    ):
        uploads.process(job.pk)
        paid.assert_not_called()
        job.refresh_from_db()
        assert job.status == "queued" and job.identity_state == "ready"
        assert not list(private_root.iterdir())
        uploads.process(job.pk)
        assert paid.call_count == 1
        signed = urlsplit(paid.call_args.args[0])
        input_key = (
            inputs.name(job.identity_inputs.get())
            if channels == 2
            else job.storage_name
        )
        input_version = "v-mono" if channels == 2 else "v-original"
        assert signed.path == "/private-bucket/prefix/" + input_key
        assert parse_qs(signed.query)["versionId"] == [input_version]
        models.UploadedRecording.objects.filter(pk=job.pk).update(
            next_poll_at=timezone.now()
        )
        with mock.patch.object(
            uploads.provider,
            "poll",
            return_value={
                "properties": {"original_duration_in_milliseconds": 8000},
                "transcripts": [
                    {
                        "sentences": [
                            {
                                "text": "Synthetic",
                                "begin_time": 0,
                                "end_time": 8000,
                                "speaker_id": 0,
                            }
                        ]
                    }
                ],
            },
        ):
            uploads.process(job.pk)
    job.refresh_from_db()
    assert job.status == "succeeded"
    receipt = sources.header(job.record_id, actor.pk, job.record.revision)[2]
    assert receipt.key == input_key and receipt.version_id == input_version
    with source_storage.download(
        receipt,
        config=source_storage.from_storage(storage_server.storage),
        expires=int(time.time()) + 30,
        authorized=lambda: True,
    ) as downloaded:
        info = media.probe(
            downloaded.media,
            config=config,
            expires=int(time.time()) + 20,
            authorized=lambda: True,
        )
        assert (info.channels, info.duration_ms) == (1, 8000)
        assert (
            downloaded.sha256
            == hashlib.sha256(storage_server.objects[input_key]).hexdigest()
        )
    assert not list(private_root.iterdir())
    assert storage_server.objects[job.storage_name] == original_bytes
    assert sum(request["method"] == "PUT" for request in storage_server.requests) == (
        1 if channels == 2 else 0
    )
