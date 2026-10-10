"""Opt-in isolated backend fixture: real HTTP, webhook, prefork and Qwen encoder.

Run with a disposable database and internal Docker network only. Synthetic users
receive test-created login sessions; cloud speech evidence is a loopback fixture.
No permit, source projection, embedding or template result is fabricated.
"""

# Container-only listeners/tmpfs and fixed CLI evidence are intentional here.
# ruff: noqa: S104, S108, T201

import base64
import io
import json
import os
import signal
import ssl
import subprocess
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from uuid import uuid4
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server


def require(value, code):
    """Keep failures in fixtures fixed and free of private data."""
    if not value:
        raise RuntimeError("rtc_fixture_" + code)


def permit_binding_valid(permit):
    """A janitor may scrub terminal context, never its quota/nonce origin."""
    if permit.track is None:
        return False
    participation = permit.track.participation
    if (
        permit.source_session_id != participation.session_id
        or permit.owner_id != participation.user_id
    ):
        return False
    if permit.profile_id is None:
        return (
            permit.status in {"canceled", "expired"}
            and permit.sample_id is None
            and not any(
                (
                    permit.livekit_room_sid,
                    permit.participant_sid,
                    permit.participant_identity,
                    permit.source_track_sid,
                    permit.device_group,
                )
            )
        )
    return (
        permit.livekit_room_sid == participation.session.livekit_room_sid
        and permit.participant_sid == participation.livekit_participant_sid
        and permit.participant_identity == participation.identity
        and permit.source_track_sid == permit.track.livekit_track_sid
    )


def main():  # noqa: PLR0912, PLR0915 -- Keep servers, fixture guards and owned processes in one lifetime.
    """Launch genuine services, exposing only authenticated fixture observations."""
    require(sys.platform == "linux" and os.getuid() == 10001, "linux_uid")
    require(os.environ.get("VOICEPRINT_SYNTHETIC_PROBE") == "1", "opt_in")
    from configurations import importer  # noqa: PLC0415

    importer.install()
    import django  # noqa: PLC0415

    django.setup()
    from django.conf import settings  # noqa: PLC0415
    from django.core.management import call_command  # noqa: PLC0415
    from django.core.wsgi import get_wsgi_application  # noqa: PLC0415
    from django.db import close_old_connections  # noqa: PLC0415
    from django.middleware.csrf import _get_new_csrf_string  # noqa: PLC0415
    from django.test import Client  # noqa: PLC0415

    from core import models  # noqa: PLC0415
    from core.services import voiceprint_devices as devices  # noqa: PLC0415
    from core.services import voiceprint_quality as quality  # noqa: PLC0415
    from core.services import voiceprint_vectors as vectors  # noqa: PLC0415
    from core.services.voiceprint_crypto import load_keyring  # noqa: PLC0415
    from core.tasks.voiceprint_maintenance import maintain_voiceprints  # noqa: PLC0415

    require(
        settings.DATABASES["default"]["NAME"] == "voiceprint_rtc_fixture", "database"
    )
    require(settings.CELERY_ENABLED and not settings.CELERY_TASK_ALWAYS_EAGER, "async")
    require(not settings.MEETING_VOICEPRINT_MATCHING_ENABLED, "matching_disabled")
    require(
        settings.LIVEKIT_CONFIGURATION["url"] == "http://livekit:7880", "local_livekit"
    )
    call_command("migrate", verbosity=0, interactive=False)
    require(not models.User.objects.exists(), "empty_database")
    users = []
    for _index in range(2):
        user = models.User(sub=str(uuid4()), full_name="Synthetic RTC fixture")
        user.set_unusable_password()
        user.save()
        client = Client()
        client.force_login(user, backend="django.contrib.auth.backends.ModelBackend")
        users.append(
            {
                "id": str(user.pk),
                "identity": str(user.sub),
                "cookie": client.cookies[settings.SESSION_COOKIE_NAME].value,
                "csrf": _get_new_csrf_string(),
            }
        )
    room = models.Room.objects.create(name="Synthetic RTC fixture")
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda _signal, _frame: stopped.set())
    key = quality.load_configuration(
        settings.MEETING_VOICEPRINT_QUALITY_CONFIG_FILE
    ).api_key.decode()
    driver_token = os.environ["VOICEPRINT_PROBE_DRIVER_TOKEN"]
    boundaries = os.environ.get("VOICEPRINT_RTC_MEDIA_BOUNDARIES") == "1"
    capacity_room = (
        models.Room.objects.create(name="Synthetic capacity fixture")
        if boundaries
        else None
    )
    observations = {"local_asr": 0, "webhook_requests": 0, "webhook_success": 0}
    lock = threading.Lock()

    class AsrHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            require(self.path == quality.API_PATH, "asr_path")
            require(self.headers.get("Authorization") == "Bearer " + key, "asr_auth")
            length = int(self.headers["Content-Length"])
            require(0 < length <= 660000, "asr_bound")
            body = json.loads(self.rfile.read(length))
            require(body["model"] == quality.MODEL_ID, "asr_model")
            require(
                body["parameters"]["speaker_diarization_enabled"] is True,
                "asr_speakers",
            )
            uri = body["input"]["messages"][0]["content"][0]["input_audio"]["data"]
            audio = base64.b64decode(uri.split(",", 1)[1], validate=True)
            duration = quality.audio_duration(audio)
            require(duration == 10000, "asr_duration")
            words = "Synthetic local speech evidence has one speaker and bounded timestamps".split()
            response = {
                "output": {
                    "text": " ".join(words),
                    "sentences": [
                        {
                            "sentence_id": 1,
                            "sentence_end": True,
                            "speaker_id": 0,
                            "channel_id": 0,
                            "begin_time": 0,
                            "end_time": duration,
                            "text": " ".join(words),
                            "words": [
                                {
                                    "text": text,
                                    "speaker_id": 0,
                                    "begin_time": i * duration // len(words),
                                    "end_time": (i + 1) * duration // len(words),
                                }
                                for i, text in enumerate(words)
                            ],
                        }
                    ],
                },
                "request_id": str(uuid4()),
            }
            with lock:
                observations["local_asr"] += 1
            encoded = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    def inspect():
        samples = list(models.VoiceprintSample.objects.select_related("profile"))
        encrypted = True
        for sample in samples:
            if sample.encrypted_audio:
                clear = load_keyring().decrypt(
                    sample.profile,
                    sample.encrypted_audio,
                    kind="audio",
                    object_id=sample.pk,
                )
                require(bytes(sample.encrypted_audio) != clear, "audio_encrypted")
                with wave.open(io.BytesIO(clear), "rb") as audio:
                    require(
                        (
                            audio.getframerate(),
                            audio.getnchannels(),
                            audio.getsampwidth(),
                            audio.getnframes(),
                        )
                        == (24000, 1, 2, 240000),
                        "native_pcm",
                    )
                encrypted = encrypted and not bytes(sample.encrypted_audio).startswith(
                    b"RIFF"
                )
        templates = list(models.VoiceprintTemplate.objects.all())
        confirmed = [sample for sample in samples if sample.status == "confirmed"]
        pair_cosines = []
        if confirmed:
            decoded = [
                vectors.read_sample_vector(
                    sample,
                    load_keyring().decrypt(
                        sample.profile,
                        sample.encrypted_embedding,
                        kind="embedding",
                        object_id=sample.pk,
                    ),
                )
                for sample in confirmed
            ]
            pair_cosines = [
                vectors.cosine(left, right)
                for index, left in enumerate(decoded)
                for right in decoded[index + 1 :]
            ]
        with lock:
            stats = dict(observations)
        permits = list(
            models.VoiceprintSamplingPermit.objects.select_related(
                "track__participation__session"
            )
        )
        return {
            **stats,
            "sessions": models.MeetingSession.objects.count(),
            "tracks": models.VoiceprintSamplingTrack.objects.count(),
            "candidates": len(samples),
            "confirmed": sum(sample.status == "confirmed" for sample in samples),
            "encrypted_audio": encrypted,
            "audio_present": sum(bool(sample.encrypted_audio) for sample in samples),
            "encrypted_embeddings": sum(
                bool(sample.encrypted_embedding) for sample in samples
            ),
            "encoding_succeeded": models.VoiceprintEncodingJob.objects.filter(
                status="succeeded"
            ).count(),
            "quality_succeeded": models.VoiceprintQualityJob.objects.filter(
                status="succeeded"
            ).count(),
            "consumed_permits": models.VoiceprintSamplingPermit.objects.filter(
                status="consumed"
            ).count(),
            "canceled_permits": models.VoiceprintSamplingPermit.objects.filter(
                status="canceled"
            ).count(),
            "permits": len(permits),
            "scrubbed_terminal_permits": sum(
                permit.profile_id is None and permit_binding_valid(permit)
                for permit in permits
            ),
            "permit_bindings_consistent": all(
                permit_binding_valid(permit) for permit in permits
            ),
            "ended_sessions": models.MeetingSession.objects.filter(
                ended_at__isnull=False
            ).count(),
            "beat_running": len(processes) == 3
            and all(process.poll() is None for process in processes),
            "dispatch_started": models.VoiceprintSamplingDispatch.objects.filter(
                outcome__in=("created", "existing")
            ).count(),
            "templates": len(templates),
            "support_samples": [
                template.support_samples.count() for template in templates
            ],
            "encrypted_templates": all(
                bool(template.encrypted_vector) for template in templates
            ),
            "basis_roles": [template.basis.get("role") for template in templates],
            "confirmed_speech_ms": sum(
                sample.quality.get("valid_speech_ms", 0) for sample in confirmed
            ),
            "eligible_headset_samples": len(
                devices.eligible(confirmed[0].profile, "headset")
            )
            if confirmed
            else 0,
            "minimum_synthetic_pair_cosine": min(pair_cosines)
            if pair_cosines
            else None,
            "denied_owner_candidates": models.VoiceprintSample.objects.filter(
                profile__consent__user_id=users[1]["id"]
            ).count(),
        }

    class FixtureHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def handle_request(self, mutation=False):
            if self.headers.get("X-Fixture-Driver-Token") != driver_token:
                self.send_error(403)
                return
            close_old_connections()
            try:
                if self.path == "/fixture" and not mutation:
                    result = {
                        "room": str(room.pk),
                        "capacity_room": str(capacity_room.pk)
                        if capacity_room
                        else None,
                        "users": users,
                        "cookie_name": settings.SESSION_COOKIE_NAME,
                        "csrf_cookie_name": settings.CSRF_COOKIE_NAME,
                    }
                elif self.path == "/state" and not mutation:
                    result = inspect()
                elif self.path == "/maintain" and mutation:
                    maintain_voiceprints.apply_async()
                    result = {"status": "queued"}
                elif self.path == "/finish" and mutation:
                    result = inspect()
                    require(
                        result["candidates"]
                        == result["confirmed"]
                        == result["encoding_succeeded"]
                        == result["quality_succeeded"]
                        == result["consumed_permits"]
                        == 3,
                        "complete_candidates",
                    )
                    require(
                        result["templates"] == 1
                        and result["support_samples"] == [3]
                        and result["encrypted_templates"]
                        and result["basis_roles"] == ["baseline"],
                        "owner_baseline",
                    )
                    require(
                        result["audio_present"] == 0
                        and result["denied_owner_candidates"] == 0,
                        "cleanup_and_denial",
                    )
                    require(
                        3 <= result["local_asr"] <= 9
                        and result["webhook_success"] >= 5,
                        "real_protocol",
                    )
                    require(
                        result["canceled_permits"] >= 1
                        and result["ended_sessions"] == (5 if boundaries else 2)
                        and result["beat_running"],
                        "beat_occurrence_pause",
                    )
                    require(
                        result["permit_bindings_consistent"],
                        "immutable_source_bindings",
                    )
                    if boundaries:
                        require(
                            result["canceled_permits"] >= 7 and result["permits"] >= 10,
                            "native_media_boundaries",
                        )
                    print(json.dumps({"status": "passed", **result}), flush=True)
                    stopped.set()
                else:
                    self.send_error(404)
                    return
                encoded = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            except Exception:  # noqa: BLE001 -- Never expose private fixture failures in HTTP error text.
                self.send_error(500, "fixture_operation_failed")
            finally:
                close_old_connections()

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request(mutation=True)

    # Only the isolated plain-HTTP LiveKit webhook listener is exempted. User and
    # sampler traffic use the actual HTTPS listener and production CSRF/session.
    settings.SECURE_REDIRECT_EXEMPT = [
        *settings.SECURE_REDIRECT_EXEMPT,
        "^api/v1.0/rooms/webhooks-livekit/$",
    ]
    django_application = get_wsgi_application()

    def application(environ, start_response):
        webhook = environ.get("PATH_INFO") == "/api/v1.0/rooms/webhooks-livekit/"
        if webhook:
            with lock:
                observations["webhook_requests"] += 1

        def response(status, headers, exc_info=None):
            if webhook and status.startswith("200"):
                with lock:
                    observations["webhook_success"] += 1
            return start_response(status, headers, exc_info)

        return django_application(environ, response)

    class ThreadedServer(ThreadingMixIn, WSGIServer):
        daemon_threads = True

    class RequestHandler(WSGIRequestHandler):
        def log_message(self, *_args):
            pass

        def get_environ(self):
            environ = super().get_environ()
            if self.server.secure:
                environ["HTTPS"] = "on"
                environ["HTTP_X_FORWARDED_PROTO"] = "https"
            return environ

    servers, processes, streams = [], [], []
    try:
        for port in (8000, 8001):
            server = make_server(
                "0.0.0.0",
                port,
                application,
                server_class=ThreadedServer,
                handler_class=RequestHandler,
            )
            server.secure = port == 8000
            if server.secure:
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(
                    "/run/voiceprint-backend/backend.crt",
                    "/run/voiceprint-backend/backend.key",
                )
                server.socket = context.wrap_socket(server.socket, server_side=True)
            servers.append(server)
        servers.extend(
            (
                ThreadingHTTPServer(("127.0.0.1", 8765), AsrHandler),
                ThreadingHTTPServer(("0.0.0.0", 8766), FixtureHandler),
            )
        )
        for server in servers:
            server.daemon_threads = True
            threading.Thread(target=server.serve_forever, daemon=True).start()
        for role in ("control", "processing", "beat"):
            path = Path("/tmp") / (role + ".log")
            stream = path.open("wb")
            streams.append(stream)
            command = (
                [
                    sys.executable,
                    "-m",
                    "celery",
                    "-A",
                    "meet.celery_app",
                    "beat",
                    "--loglevel=info",
                    "--schedule=/tmp/beat-schedule",
                ]
                if role == "beat"
                else [
                    sys.executable,
                    "manage.py",
                    "run_voiceprint_worker",
                    "--role",
                    role,
                ]
            )
            process = subprocess.Popen(  # noqa: S603 -- Only the fixed consumer/beat argv above is executed.
                command,
                stdout=stream,
                stderr=stream,
                start_new_session=True,
            )
            processes.append(process)
            deadline = time.monotonic() + 30
            marker = b"beat: Starting..." if role == "beat" else b" ready."
            while marker not in path.read_bytes():
                require(
                    process.poll() is None and time.monotonic() < deadline,
                    "consumer_start",
                )
                time.sleep(0.1)
        print(json.dumps({"event": "rtc_backend_fixture_ready"}), flush=True)
        require(stopped.wait(660), "driver_deadline")
    finally:
        diagnostic_path = Path("/probe-diagnostics")
        try:
            for role in ("control", "processing", "beat"):
                path = Path("/tmp") / (role + ".log")
                if path.exists():
                    (diagnostic_path / (role + ".log")).write_bytes(path.read_bytes())
            (diagnostic_path / "state.json").write_text(
                json.dumps(inspect()), encoding="utf-8"
            )
        finally:
            try:
                for process in processes:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGTERM)
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait(timeout=3)
            finally:
                for stream in streams:
                    stream.close()
                for server in servers:
                    server.shutdown()
                    server.server_close()


if __name__ == "__main__":
    main()
