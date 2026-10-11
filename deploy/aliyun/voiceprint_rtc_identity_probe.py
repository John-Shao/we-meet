"""Synthetic published-source fixture for the owned RTC acceptance network.

No templates, vectors, permits or identity jobs are fabricated here. The source
transcript is a protocol fixture; its private PCM is read by the real identity
worker. Registration and human decisions go through the existing HTTPS APIs.
"""

import hashlib
import io
import math
import os
import struct
import tempfile
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4


def require(value, code):
    if not value:
        raise RuntimeError("rtc_identity_fixture_" + code)


def synthetic_audio():
    """Distinct query clips of the same synthetic tone family as RTC enrollment."""
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(24000)
        writer.writeframes(
            b"".join(
                struct.pack(
                    "<h",
                    int(
                        (3500 + (index // 240000) * 70)
                        * math.sin(2 * math.pi * 300 * index / 24000)
                        + 1000 * math.sin(2 * math.pi * 750 * index / 24000)
                    ),
                )
                for index in range(720000)
            )
        )
    return output.getvalue()


class IdentityFixture:
    """One bounded in-memory object and source metadata, on a disposable database."""

    def __init__(self, actor):
        from django.conf import settings  # noqa: PLC0415

        from core.services import voiceprint_matching as matching  # noqa: PLC0415
        from core.services.capture_storage import audio_storage  # noqa: PLC0415
        from core.services.voiceprint_source_storage import (  # noqa: PLC0415
            from_storage,
        )

        require(
            os.environ.get("VOICEPRINT_SYNTHETIC_PROBE") == "1"
            and os.environ.get("VOICEPRINT_SYNTHETIC_IDENTITY") == "1"
            and settings.DATABASES["default"]["NAME"] == "voiceprint_rtc_fixture"
            and settings.MEETING_VOICEPRINT_MATCHING_ENABLED
            and settings.MEETING_VOICEPRINT_JOURNAL_REQUIRED,
            "scope",
        )
        policy = matching.load_policy(settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE)
        require(policy.threshold_version == "rtc-synthetic-test-only-v1", "policy")
        self.configuration = from_storage(audio_storage())
        require(
            self.configuration.endpoint == "http://127.0.0.1:9000"
            and self.configuration.bucket == "voiceprint-rtc-fixture",
            "storage",
        )
        self.actor, self.record, self.speaker = actor, None, None
        self.data = synthetic_audio()
        self.digest = hashlib.sha256(self.data).hexdigest()
        self.key = "record-uploads/synthetic-identity.wav"
        self.observations = {"heads": 0, "gets": 0}
        self.lock = threading.Lock()
        fixture = self
        expected_path = "/" + "/".join(
            value
            for value in (
                self.configuration.bucket,
                self.configuration.prefix,
                self.key,
            )
            if value
        )

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, *, head=False):
                if self.path != expected_path or not self.headers.get(
                    "Authorization", ""
                ).startswith(
                    "AWS4-HMAC-SHA256 Credential="
                    + fixture.configuration.access_key
                    + "/"
                ):
                    self.send_error(403)
                    return
                with fixture.lock:
                    fixture.observations["heads" if head else "gets"] += 1
                self.send_response(200)
                self.send_header("Content-Length", str(len(fixture.data)))
                self.send_header("Content-Type", "audio/wav")
                self.send_header("ETag", '"synthetic-identity-object"')
                self.end_headers()
                if not head:
                    self.wfile.write(fixture.data)

            def do_HEAD(self):
                self.respond(head=True)

            def do_GET(self):
                self.respond()

        self.server = ThreadingHTTPServer(("127.0.0.1", 9000), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def setup(self):
        """Publish synthetic transcript metadata, never infer or set an identity."""
        from django.utils import timezone  # noqa: PLC0415

        from core import models  # noqa: PLC0415
        from core.services.voiceprint_source_objects import (  # noqa: PLC0415
            ObjectReceipt,
        )

        require(self.record is None, "single_source")
        require(
            models.VoiceprintTemplate.objects.filter(
                profile__consent__user=self.actor, status="active"
            ).count()
            == 1,
            "registered_template",
        )
        now = timezone.now()
        self.record = models.MeetingRecord.objects.create(
            owner=self.actor,
            source_type="upload",
            retention_mode="media",
            origin_at=now,
        )
        capture = models.CaptureSession.objects.create(
            record=self.record,
            created_by=self.actor,
            device_id=str(uuid4()),
            status="stopped",
            started_at=now,
            ended_at=now,
        )
        receipt = ObjectReceipt(
            "content_sha256", self.key, len(self.data), sha256=self.digest
        )
        models.UploadedRecording.objects.create(
            record=self.record,
            capture=capture,
            key=uuid4(),
            storage_name=self.key,
            checksum=self.digest,
            size=len(self.data),
            status="succeeded",
            deadline=now + timezone.timedelta(hours=24),
            next_poll_at=now,
            configuration={
                "diarization": True,
                "_identity_source": receipt.payload(),
                "_published": {"segment_count": 3, "attempt": 1},
            },
        )
        self.speaker = models.MeetingSpeaker.objects.create(
            record=self.record,
            capture_session=capture,
            source_track_id="uploaded-file",
            source_key="0",
            label="Synthetic speaker",
            identity_type="diarized",
        )
        for index in range(3):
            models.MeetingOriginalSegment.objects.create(
                record=self.record,
                capture_session=capture,
                speaker=self.speaker,
                ingest_id=uuid4(),
                source_track_id="uploaded-file",
                source_sequence=index + 1,
                start_ms=index * 10000,
                end_ms=(index + 1) * 10000,
                text="Synthetic protocol transcript",
                payload_hash=hashlib.sha256(
                    b"Synthetic protocol transcript"
                ).hexdigest(),
            )
        return {
            "record_id": str(self.record.pk),
            "speaker_id": str(self.speaker.pk),
            "record_revision": self.record.revision,
        }

    def evidence(self):
        from core import models  # noqa: PLC0415

        require(self.record is not None, "source_created")
        self.speaker.refresh_from_db()
        jobs = models.SpeakerIdentityJob.objects.filter(record=self.record)
        suggestions = models.SpeakerIdentitySuggestion.objects.filter(job__in=jobs)
        with self.lock:
            observations = dict(self.observations)
        query_root = Path(tempfile.gettempdir()) / "we-meet-voiceprint-query"
        return {
            "jobs": jobs.count(),
            "jobs_succeeded": jobs.filter(status="succeeded").count(),
            "attempts": list(jobs.values_list("attempts", flat=True)),
            "suggestions": suggestions.count(),
            "suggested": suggestions.filter(result="suggested").count(),
            "confirmed": suggestions.filter(state="confirmed").count(),
            "has_attribution": self.speaker.user_id is not None,
            "attributed_to_owner": self.speaker.user_id == self.actor.pk,
            "decisions": self.record.identity_decisions.count(),
            "support_samples": models.VoiceprintSample.objects.count(),
            "query_clips": list(suggestions.values_list("clip_count", flat=True)),
            "query_speech_ms": list(suggestions.values_list("speech_ms", flat=True)),
            "query_temp_children": len(list(query_root.iterdir()))
            if query_root.is_dir()
            else None,
            "storage": observations,
        }

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
