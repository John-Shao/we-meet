"""Opt-in Linux fixture: real Beat/prefork erasure with voiceprint use disabled."""

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4


def require(value, code):
    if not value:
        raise RuntimeError("erasure_fixture_" + code)


def wait_for(check, *, seconds, code):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.2)
    raise RuntimeError("erasure_fixture_timeout_" + code)


def main():  # noqa: PLR0915 -- One opt-in fixture owns the real worker and Beat lifetimes.
    require(sys.platform == "linux" and os.getuid() == 10001, "nonroot_linux")
    require(os.environ.get("VOICEPRINT_ERASURE_PROBE") == "1", "opt_in")
    from configurations import importer  # noqa: PLC0415

    importer.install()
    import django  # noqa: PLC0415

    django.setup()
    from django.conf import settings  # noqa: PLC0415
    from django.core.management import call_command  # noqa: PLC0415
    from django.utils import timezone  # noqa: PLC0415

    from core import models  # noqa: PLC0415
    from core.services.voiceprint_encoder import FEATURE_SPACE  # noqa: PLC0415

    require(
        settings.DATABASES["default"]["NAME"] == "voiceprint_erasure_fixture",
        "database",
    )
    require(settings.CELERY_ENABLED and not settings.CELERY_TASK_ALWAYS_EAGER, "async")
    require(not settings.MEETING_VOICEPRINT_ENABLED, "use_disabled")
    require(not settings.MEETING_VOICEPRINT_KEYRING_FILE, "no_private_model_files")
    call_command("migrate", verbosity=0, interactive=False)
    require(not models.User.objects.exists(), "empty_fixture")
    old_samples, old_templates, profiles, jobs = [], [], [], []
    new_artifacts = None
    for index in range(3):
        user = models.User(
            sub="erasure-synthetic-" + uuid4().hex, full_name="Synthetic fixture"
        )
        user.set_unusable_password()
        user.save()
        organization = (
            models.Organization.objects.create(
                name="Synthetic organization", slug="erasure-" + uuid4().hex
            )
            if index == 2
            else None
        )
        consent = models.VoiceprintConsent.objects.create(
            user=user,
            organization=organization,
            generation=1 if index == 1 else 2,
            version=1 if index == 1 else 3,
            allow_enrollment=index > 0,
        )
        if index == 1:
            models.VoiceprintConsentEvent.objects.create(
                consent=consent,
                version=2,
                generation=2,
                action="delete",
                permissions={
                    "allow_enrollment": False,
                    "allow_accumulation": False,
                    "allow_identification": False,
                },
            )
        profile = models.VoiceprintProfile.objects.create(
            consent=consent,
            feature_space=FEATURE_SPACE,
            generation=2 if index == 2 else 1,
            status="active",
            encrypted_key=b"synthetic-profile-key",
        )
        sample = models.VoiceprintSample.objects.create(
            profile=profile,
            generation=1,
            consent_version=1,
            permit_id=uuid4(),
            source_type="enrollment",
            end_ms=10000,
            audio_sha256=hashlib.sha256(str(index).encode()).hexdigest(),
            encrypted_audio=b"synthetic-old-audio",
            encrypted_embedding=b"synthetic-old-embedding",
            expires_at=timezone.now() + timezone.timedelta(hours=24),
        )
        template = models.VoiceprintTemplate.objects.create(
            profile=profile,
            generation=1,
            dimension=1024,
            encrypted_vector=b"synthetic-old-template",
        )
        old_samples.append(sample.pk)
        old_templates.append(template.pk)
        profiles.append(profile)
        jobs.append(
            models.VoiceprintDeletionJob.objects.create(
                consent=consent,
                owner_id=user.pk,
                organization_id=organization.pk if organization else None,
                request_key=uuid4(),
                expected_version=1,
                revoked_generation=2,
                status="queued" if index == 0 else "succeeded",
                attempts=0 if index == 0 else 1,
            )
        )
        if index == 2:
            new_sample = models.VoiceprintSample.objects.create(
                profile=profile,
                generation=2,
                consent_version=3,
                permit_id=uuid4(),
                source_type="enrollment",
                end_ms=10000,
                audio_sha256=hashlib.sha256(b"new synthetic fixture").hexdigest(),
                encrypted_audio=b"synthetic-new-audio",
                encrypted_embedding=b"synthetic-new-embedding",
                expires_at=timezone.now() + timezone.timedelta(hours=24),
            )
            new_template = models.VoiceprintTemplate.objects.create(
                profile=profile,
                generation=2,
                dimension=1024,
                encrypted_vector=b"synthetic-new-template",
            )
            new_artifacts = (new_sample, new_template)
    paths = {"control": Path("/tmp/control.log"), "beat": Path("/tmp/beat.log")}
    processes, streams = {}, []
    try:
        commands = {
            "control": [
                sys.executable,
                "manage.py",
                "run_voiceprint_worker",
                "--role",
                "control",
            ],
            "beat": [
                "celery",
                "-A",
                "meet.celery_app",
                "beat",
                "--schedule",
                "/tmp/erasure-beat",
                "--loglevel=INFO",
            ],
        }
        for role, command in commands.items():
            stream = paths[role].open("wb")
            streams.append(stream)
            processes[role] = subprocess.Popen(
                command, stdout=stream, stderr=stream, start_new_session=True
            )  # noqa: S603 -- Fixed commands in an isolated opt-in fixture.
            if role == "control":
                wait_for(
                    lambda: b" ready." in paths[role].read_bytes(),
                    seconds=40,
                    code="worker_ready",
                )
        started = time.monotonic()

        def erased():
            require(
                all(process.poll() is None for process in processes.values()),
                "process_liveness",
            )
            return (
                models.VoiceprintDeletionJob.objects.filter(
                    pk__in=[row.pk for row in jobs], status="succeeded"
                ).count()
                == 3
                and not models.VoiceprintSample.objects.filter(
                    pk__in=old_samples
                ).exists()
                and not models.VoiceprintTemplate.objects.filter(
                    pk__in=old_templates
                ).exists()
            )

        wait_for(erased, seconds=55, code="periodic_erasure")
        elapsed = round(time.monotonic() - started, 2)
        for profile in profiles[:2]:
            profile.refresh_from_db()
            require(
                profile.status == "deleted" and not profile.encrypted_key, "old_keys"
            )
        profiles[1].consent.refresh_from_db()
        require(
            profiles[1].consent.generation == 2 and profiles[1].consent.version > 2,
            "audit_floor",
        )
        require(not profiles[1].consent.allow_enrollment, "restored_permission_denied")
        profiles[2].refresh_from_db()
        require(
            profiles[2].generation == 2
            and profiles[2].encrypted_key == b"synthetic-profile-key",
            "renewed_key",
        )
        new_sample, new_template = new_artifacts
        new_sample.refresh_from_db()
        new_template.refresh_from_db()
        require(
            new_sample.encrypted_embedding == b"synthetic-new-embedding"
            and new_template.encrypted_vector == b"synthetic-new-template",
            "renewed_artifacts",
        )
        wait_for(
            lambda: (
                b"core.tasks.voiceprint_erasure.purge_voiceprints["
                in paths["control"].read_bytes()
                and b"succeeded" in paths["control"].read_bytes()
            ),
            seconds=5,
            code="worker_completion",
        )
        require(
            b"Sending due task purge-voiceprints" in paths["beat"].read_bytes(),
            "actual_beat_publication",
        )
        result = {
            "status": "passed",
            "uid": os.getuid(),
            "jobs_erased": 3,
            "old_samples": 3,
            "old_templates": 3,
            "renewed_artifacts_preserved": 2,
            "voiceprint_enabled": False,
            "private_model_files": False,
            "real_beat": True,
            "real_prefork": True,
            "queue": "voiceprint",
            "periodic_erasure_seconds": elapsed,
        }
    finally:
        for process in reversed(list(processes.values())):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
        for stream in streams:
            stream.close()
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- Framework exceptions can contain private SQL/configuration.
        result = {"status": "failed", "error_type": type(error).__name__}
        if isinstance(error, RuntimeError) and str(error).startswith(
            "erasure_fixture_"
        ):
            result["error_code"] = str(error)
        if hasattr(error, "message_dict"):
            result["invalid_fields"] = sorted(error.message_dict)
        print(json.dumps(result))
        sys.exit(1)
