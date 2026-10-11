"""Opt-in Linux fixture probe, using real prefork/Redis/PostgreSQL/Qwen and tones.

Run only in an isolated container with the production backend-voiceprint image,
fixture database, local encoder TLS, private files and no external network.
Cloud ASR is replaced by a strict loopback server. No human accuracy is measured.
"""

import base64
import hashlib
import io
import json
import math
import os
import signal
import struct
import subprocess
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4


def require(value, name):
    if not value:
        raise RuntimeError("fixture_probe_failed_" + name)


def wait_for(check, *, seconds=60, name):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.2)
    raise RuntimeError("fixture_probe_timeout_" + name)


def tones(slot):
    data = io.BytesIO()
    with wave.open(data, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        output.writeframes(
            b"".join(
                struct.pack(
                    "<h",
                    int(
                        (3500 + slot * 10) * math.sin(2 * math.pi * 300 * i / 24000)
                        + 1000 * math.sin(2 * math.pi * 750 * i / 24000)
                    ),
                )
                for i in range(240000)
            )
        )
    return data.getvalue()


def main():  # noqa: PLR0915 -- One isolated process lifecycle proves real consumers and crash recovery.
    require(sys.platform == "linux" and os.getuid() != 0, "linux_nonroot")
    require(os.environ.get("VOICEPRINT_SYNTHETIC_PROBE") == "1", "opt_in")
    from configurations import importer  # noqa: PLC0415

    importer.install()
    import django  # noqa: PLC0415

    django.setup()
    from django.conf import settings  # noqa: PLC0415
    from django.core.management import call_command  # noqa: PLC0415
    from django.utils import timezone  # noqa: PLC0415

    from core import models  # noqa: PLC0415
    from core.services import voiceprint_consent as consent  # noqa: PLC0415
    from core.services import voiceprint_enrollment as enrollment  # noqa: PLC0415
    from core.services import voiceprint_media as media  # noqa: PLC0415
    from core.services import voiceprint_query_files as files  # noqa: PLC0415
    from core.services import voiceprint_quality as quality  # noqa: PLC0415
    from core.tasks.voiceprint_maintenance import maintain_voiceprints  # noqa: PLC0415
    from core.tasks.voiceprint_processing import (
        identify_speakers,
        process_voiceprint_batches,
    )  # noqa: PLC0415

    require(
        settings.DATABASES["default"]["NAME"] == "voiceprint_runtime_fixture",
        "fixture_database",
    )
    require(settings.CELERY_ENABLED and not settings.CELERY_TASK_ALWAYS_EAGER, "async")
    require(not settings.MEETING_VOICEPRINT_MATCHING_ENABLED, "human_matching_disabled")
    call_command("migrate", verbosity=0, interactive=False)
    require(not models.VoiceprintSample.objects.exists(), "empty_fixture")
    prompts, hang = {}, threading.Event()
    received = threading.Event()
    key = quality.load_configuration(
        settings.MEETING_VOICEPRINT_QUALITY_CONFIG_FILE
    ).api_key.decode()
    counts = {"local_asr": 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):  # noqa: N802 -- stdlib handler interface.
            require(self.path == quality.API_PATH, "asr_path")
            require(self.headers.get("Authorization") == "Bearer " + key, "asr_auth")
            size = int(self.headers["Content-Length"])
            require(0 < size <= 660000, "asr_bound")
            body = json.loads(self.rfile.read(size))
            require(body["model"] == quality.MODEL_ID, "asr_model")
            uri = body["input"]["messages"][0]["content"][0]["input_audio"]["data"]
            audio = base64.b64decode(uri.split(",", 1)[1], validate=True)
            prompt = prompts[hashlib.sha256(audio).hexdigest()]
            require(quality.audio_duration(audio) == 10000, "asr_duration")
            counts["local_asr"] += 1
            received.set()
            if hang.is_set():
                time.sleep(6)
                return  # Deliberately no provider evidence during the crash.
            tokens = [
                token
                for token in prompt.split()
                if any(char.isalnum() for char in token)
            ]
            result = {
                "output": {
                    "sentences": [
                        {
                            "sentence_id": 1,
                            "sentence_end": True,
                            "speaker_id": 0,
                            "channel_id": 0,
                            "begin_time": 0,
                            "end_time": 10000,
                            "text": prompt,
                            "words": [
                                {
                                    "text": text,
                                    "speaker_id": 0,
                                    "begin_time": i * 10000 // len(tokens),
                                    "end_time": (i + 1) * 10000 // len(tokens),
                                }
                                for i, text in enumerate(tokens)
                            ],
                        }
                    ],
                    "text": prompt,
                },
                "request_id": str(uuid4()),
            }
            encoded = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    processes, streams = {}, []
    tmp = Path("/tmp")

    def start(role):
        path = tmp / (role + ".log")
        previous_size = path.stat().st_size if path.exists() else 0
        stream = path.open("ab")
        streams.append(stream)
        process = subprocess.Popen(
            [sys.executable, "manage.py", "run_voiceprint_worker", "--role", role],
            stdout=stream,
            stderr=stream,
            start_new_session=True,
        )  # noqa: S603 -- Fixed image command in an opt-in fixture.
        processes[role] = process
        wait_for(
            lambda: b" ready." in path.read_bytes()[previous_size:],
            name=role + "_ready",
        )
        require(process.poll() is None, role + "_alive")
        return process

    def dispatch(task, role):
        result = task.apply_async()
        expected = ("[" + result.id + "] succeeded").encode()
        wait_for(
            lambda: expected in (tmp / (role + ".log")).read_bytes(),
            name=role + "_consumed",
        )

    janitor_stream = (tmp / "janitor.log").open("wb")
    streams.append(janitor_stream)
    janitor = subprocess.Popen(
        [sys.executable, "-m", "core.services.voiceprint_query_janitor"],
        stdout=janitor_stream,
        stderr=janitor_stream,
    )  # noqa: S603 -- Fixed standalone module.
    try:
        for role in ("control", "processing", "identity"):
            start(role)
        dispatch(identify_speakers, "identity")
        owner = models.User(
            sub="synthetic-fixture-" + uuid4().hex, full_name="Synthetic fixture"
        )
        owner.set_unusable_password()
        owner.save()
        preference = consent.update_settings(
            owner,
            organization_id=None,
            expected_version=0,
            changes={"allow_enrollment": True},
        )
        registration = enrollment.begin(
            owner,
            organization_id=None,
            expected_version=preference["version"],
            request_key=uuid4(),
            locale="en",
        )
        samples = []
        for slot in range(3):
            audio = tones(slot)
            prompts[hashlib.sha256(audio).hexdigest()] = registration.challenges[slot]
            samples.append(
                enrollment.upload(
                    owner,
                    enrollment_id=registration.pk,
                    slot=slot,
                    token=enrollment.upload_token(registration, registration.profile),
                    wav=audio,
                )
            )
        for _ in range(3):
            dispatch(process_voiceprint_batches, "processing")
        require(
            models.VoiceprintEncodingJob.objects.filter(status="succeeded").count()
            == 3,
            "real_qwen_embeddings",
        )
        require(
            not models.VoiceprintTemplate.objects.exists(), "unconfirmed_no_template"
        )

        # Crash the real prefork consumer while a local provider request is pending.
        hang.set()
        received.clear()
        process_voiceprint_batches.apply_async()
        require(received.wait(15), "pending_native_quality")
        live = models.VoiceprintQualityJob.objects.get(status="running")
        original_token = live.lease_token
        os.killpg(processes["processing"].pid, signal.SIGKILL)
        processes["processing"].wait(timeout=3)
        hang.clear()
        start("processing")
        # A fresh tick must leave the live previous lease alone.
        dispatch(process_voiceprint_batches, "processing")
        live.refresh_from_db()
        require(
            live.lease_token == original_token and live.attempts == 1,
            "live_lease_not_replayed",
        )
        wait_for(
            lambda: timezone.now() >= live.lease_until,
            seconds=45,
            name="real_lease_expiry",
        )
        for _ in range(4):
            dispatch(process_voiceprint_batches, "processing")
        live.refresh_from_db()
        require(
            live.status == "succeeded" and live.attempts == 2, "expired_lease_recovered"
        )
        require(
            models.VoiceprintQualityJob.objects.filter(status="succeeded").count() == 3,
            "quality_complete",
        )
        speech_ms = 0
        for sample in samples:
            sample.refresh_from_db()
            require(
                sample.status == "ready" and sample.quality["speech_checked"],
                "quality_ready",
            )
            speech_ms += sample.quality["valid_speech_ms"]
            enrollment.decide(
                owner, sample.pk, expected_version=preference["version"], accepted=True
            )
        require(speech_ms == 30000, "local_fixture_full_speech_duration")
        dispatch(process_voiceprint_batches, "processing")
        template = models.VoiceprintTemplate.objects.get(device_group="default")
        require(
            bool(template.encrypted_vector) and template.support_samples.count() == 3,
            "confirmed_encrypted_template",
        )
        dispatch(maintain_voiceprints, "control")
        require(
            not models.VoiceprintSample.objects.exclude(encrypted_audio=None)
            .exclude(encrypted_audio=b"")
            .exists(),
            "confirmed_raw_audio_erased",
        )

        # Actual image-installed FFprobe/FFmpeg, bounded IPC and canonical output.
        with files.leased_directory(int(time.time()) + 60) as root:
            path = Path(root) / "source.media"
            path.write_bytes(tones(4))
            source = media.MediaFile(str(path), root)
            config = media.MediaConfiguration("/usr/bin/ffmpeg", "/usr/bin/ffprobe")
            expires = int(time.time()) + 50
            info = media.probe(
                source, config=config, expires=expires, authorized=lambda: True
            )
            clip = media.decode(
                source,
                info,
                config=config,
                start_ms=1000,
                end_ms=4000,
                expires=expires,
                authorized=lambda: True,
            )
            require(quality.audio_duration(clip.wav) == 3000, "native_ffmpeg_clip")
        abandoned = files.directory() / "query-crashed-fixture"
        abandoned.mkdir()
        (abandoned / "source.media").write_bytes(b"synthetic crash leftover")
        (abandoned / "lease.json").write_text(
            json.dumps({"schema": 1, "expires": int(time.time()) - 46})
        )
        wait_for(
            lambda: not abandoned.exists(),
            seconds=35,
            name="independent_janitor_cleanup",
        )
        require(janitor.poll() is None, "janitor_alive")
        version = subprocess.check_output(
            ["/usr/bin/ffmpeg", "-version"], text=True
        ).splitlines()[0]  # noqa: S603 -- Fixed image-installed binary, version only.
        print(
            json.dumps(
                {
                    "status": "passed",
                    "queues": 3,
                    "encoded_samples": 3,
                    "quality_samples": 3,
                    "encrypted_templates": 1,
                    "real_lease_recovery": True,
                    "expired_files_removed": True,
                    "local_asr_requests": counts["local_asr"],
                    "uid": os.getuid(),
                    "ffmpeg": version,
                    "human_accuracy_measured": False,
                }
            ),
            flush=True,
        )  # noqa: T201 -- Aggregate fixture output only.
    finally:
        server.shutdown()
        server.server_close()
        janitor.terminate()
        janitor.wait(timeout=3)
        for process in processes.values():
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
        for stream in streams:
            stream.close()


if __name__ == "__main__":
    main()
