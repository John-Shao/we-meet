"""Opt-in nonroot Linux fixture: replay after a real full PostgreSQL restore.

All identities, quality records and vectors are synthetic. No model is called.
The host controls pg_dump/pg_restore; independent files stay in private tmpfs.
"""

# The private container tmpfs and aggregate-only JSON output are intentional.
# ruff: noqa: S108, T201, PLC0415

import base64
import copy
import hashlib
import io
import json
import os
import sys
import time
from pathlib import Path
from uuid import uuid4


def require(value, code):
    if not value:
        raise RuntimeError("recovery_fixture_" + code)


def rendezvous(redis, connection, phase, expected):
    connection.close()
    redis.set("recovery:phase", phase)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if redis.get("recovery:command") == expected.encode():
            return
        time.sleep(0.2)
    raise RuntimeError("recovery_fixture_host_timeout")


def main():  # noqa: PLR0915 -- One isolated lifetime includes the source snapshot and full restored target.
    require(sys.platform == "linux" and os.getuid() == 10001, "nonroot_linux")
    require(os.environ.get("VOICEPRINT_RECOVERY_PROBE") == "1", "opt_in")
    from configurations import importer

    importer.install()
    import django

    django.setup()
    from django.conf import settings
    from django.core.management import call_command
    from django.db import connection
    from django.utils import timezone

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from redis import Redis

    from core import models
    from core.services import voiceprint_consent as consent
    from core.services import voiceprint_recovery as recovery
    from core.services import voiceprint_source_removal as removal
    from core.services.voiceprint_crypto import load_keyring
    from core.services.voiceprint_encoder import FEATURE_SPACE
    from core.services.voiceprint_enrollment import QUALITY_MODEL_ID, QUALITY_POLICY
    from core.services.voiceprint_prompt import challenge_digest
    from core.services.voiceprint_templates import (
        POLICY_VERSION,
        supports_digest,
        template_payload,
    )
    from core.services.voiceprint_vectors import sample_payload

    require(
        settings.DATABASES["default"]["NAME"] == "voiceprint_recovery_fixture",
        "database",
    )
    require(not settings.MEETING_VOICEPRINT_KEYRING_FILE, "no_operator_keys")
    recovery.offline()
    call_command("migrate", verbosity=0, interactive=False)
    require(not models.User.objects.exists(), "empty_fixture")
    root = Path("/tmp/recovery")
    root.mkdir(mode=0o700)
    keyring_path = root / "keyring.json"
    recovery.write_private(
        keyring_path,
        {
            "active": "fixture",
            "keys": {"fixture": base64.b64encode(os.urandom(32)).decode()},
        },
    )
    settings.MEETING_VOICEPRINT_KEYRING_FILE = str(keyring_path)
    ring = load_keyring()
    unit = (1.0, *([0.0] * 1023))

    def baseline():
        user = models.User(
            sub="recovery-synthetic-" + uuid4().hex, full_name="Synthetic fixture"
        )
        user.set_unusable_password()
        user.save()
        scope = models.VoiceprintConsent.objects.create(
            user=user,
            generation=1,
            version=1,
            allow_enrollment=True,
            allow_identification=True,
        )
        profile = models.VoiceprintProfile(
            consent=scope,
            feature_space=FEATURE_SPACE,
            generation=1,
            status="active",
            confirmed_at=timezone.now(),
            last_updated_at=timezone.now(),
        )
        profile.encrypted_key = ring.create_profile_key(profile)
        profile.save()
        prompt = "This is my synthetic fixture. The numbers are 10 20 30 40 50 60."
        registration = models.VoiceprintEnrollment.objects.create(
            owner_id=user.pk,
            profile=profile,
            request_key=uuid4(),
            consent_version=1,
            generation=1,
            challenges=[prompt] * 6,
            status="closed",
            expires_at=timezone.now() + timezone.timedelta(minutes=10),
        )
        samples = []
        for index in range(3):
            sample = models.VoiceprintSample.objects.create(
                profile=profile,
                generation=1,
                consent_version=1,
                permit_id=registration.pk,
                enrollment=registration,
                enrollment_slot=index,
                source_type="enrollment",
                end_ms=10000,
                audio_sha256=hashlib.sha256(os.urandom(32)).hexdigest(),
                encrypted_audio=b"",
                expires_at=timezone.now() + timezone.timedelta(hours=24),
                status="confirmed",
                quality={
                    "speech_checked": True,
                    "speaker_consistency_checked": True,
                    "valid_speech_ms": 10000,
                    "speech_validation": QUALITY_POLICY,
                    "asr_model_id": QUALITY_MODEL_ID,
                    "speaker_count": 1,
                    "prompt_checked": True,
                    "prompt_sha256": challenge_digest(registration.locale, prompt),
                },
            )
            sample.confirmed_at = timezone.now()
            sample.encrypted_audio = ring.encrypt(
                profile,
                b"synthetic fixture bytes, not a human recording",
                kind="audio",
                object_id=sample.pk,
            )
            sample.encrypted_embedding = ring.encrypt(
                profile,
                sample_payload(sample, unit),
                kind="embedding",
                object_id=sample.pk,
            )
            sample.save()
            models.VoiceprintSampleDecision.objects.create(
                sample=sample,
                owner_id=user.pk,
                accepted=True,
                consent_version=1,
                generation=1,
            )
            samples.append(sample)
        template = models.VoiceprintTemplate(
            profile=profile,
            generation=1,
            dimension=1024,
            policy_version=POLICY_VERSION,
            support_digest=supports_digest(samples),
        )
        template.encrypted_vector = ring.encrypt(
            profile,
            template_payload(template, unit),
            kind="template",
            object_id=template.pk,
        )
        template.save()
        template.support_samples.add(*samples)
        return profile, template, samples

    deleted, valid, permission, source = [baseline() for _ in range(4)]
    rejected = models.VoiceprintSample.objects.create(
        profile=valid[0],
        generation=1,
        consent_version=1,
        permit_id=uuid4(),
        source_type="enrollment",
        end_ms=10000,
        audio_sha256=hashlib.sha256(b"synthetic rejected sample").hexdigest(),
        encrypted_audio=b"synthetic pending bytes",
        status="pending",
        expires_at=timezone.now() + timezone.timedelta(hours=24),
    )
    settings.MEETING_VOICEPRINT_ENABLED = True
    for profile, _template, _samples in (deleted, valid, permission, source):
        consent.authorize_profile(profile.pk, permission="allow_identification")
    settings.MEETING_VOICEPRINT_ENABLED = False
    redis = Redis.from_url(settings.CELERY_BROKER_URL)
    rendezvous(redis, connection, "seeded", "backed_up")
    settings.MEETING_VOICEPRINT_ENABLED = True
    job = consent.delete_profile(
        deleted[0].consent.user,
        profile_id=deleted[0].pk,
        expected_version=1,
        request_key=uuid4(),
    )
    consent.purge_deleted(job.pk)
    consent.update_settings(
        permission[0].consent.user,
        organization_id=None,
        expected_version=1,
        changes={"allow_identification": False},
    )
    models.VoiceprintSample.objects.filter(pk=rejected.pk).update(
        status="rejected",
        encrypted_audio=b"",
        encrypted_embedding=b"",
    )
    removal.enroll(
        models.VoiceprintSample.objects.filter(pk=source[2][0].pk), dispatch=False
    )
    source_job = models.VoiceprintContributionRemoval.objects.get(
        sample_uuid=source[2][0].pk
    )
    require(removal.purge(source_job.pk) == "purged", "source_erased")
    models.VoiceprintSourceRemoval.objects.create(
        kind="track",
        source_uuid=uuid4(),
        track_digest=removal.track_digest("TR_synthetic_recovery"),
    )
    settings.MEETING_VOICEPRINT_ENABLED = False
    recovery.offline()
    signing = Ed25519PrivateKey.generate()
    common = {
        "v": 1,
        "deployment_id": str(uuid4()),
        "encryption_key": base64.b64encode(os.urandom(32)).decode(),
    }
    writer_path, reader_path, request_path, bundle_path, receipt_path = (
        root / name
        for name in (
            "writer.json",
            "reader.json",
            "request.json",
            "bundle.json",
            "receipt.json",
        )
    )
    recovery.write_private(
        writer_path,
        {
            **common,
            "signing_key": base64.b64encode(
                signing.private_bytes(
                    serialization.Encoding.Raw,
                    serialization.PrivateFormat.Raw,
                    serialization.NoEncryption(),
                )
            ).decode(),
        },
    )
    recovery.write_private(
        reader_path,
        {
            **common,
            "verification_key": base64.b64encode(
                signing.public_key().public_bytes(
                    serialization.Encoding.Raw,
                    serialization.PublicFormat.Raw,
                )
            ).decode(),
        },
    )
    call_command(
        "request_voiceprint_recovery",
        config=str(reader_path),
        output=str(request_path),
        stdout=io.StringIO(),
    )
    call_command(
        "export_voiceprint_recovery",
        config=str(writer_path),
        request=str(request_path),
        output=str(bundle_path),
        stdout=io.StringIO(),
    )
    writer_path.unlink()
    del signing
    # Reject a FIFO without waiting for a writer; all exported files are private.
    fifo = root / "fifo"
    os.mkfifo(fifo, 0o600)
    try:
        recovery.read_private(fifo)
    except recovery.RecoveryError:
        pass
    else:
        raise RuntimeError("recovery_fixture_fifo_accepted")
    rendezvous(redis, connection, "exported", "restored")
    require(
        not models.VoiceprintDeletionJob.objects.exists(),
        "restored_without_current_floor",
    )
    require(
        not models.VoiceprintContributionRemoval.objects.exists(),
        "restored_without_current_proof",
    )
    settings.MEETING_VOICEPRINT_ENABLED = True
    consent.authorize_profile(deleted[0].pk, permission="allow_identification")
    consent.authorize_profile(source[0].pk, permission="allow_identification")
    settings.MEETING_VOICEPRINT_ENABLED = False
    reader = recovery.configuration(reader_path, "reader")
    request, bundle = (
        recovery.read_private(request_path),
        recovery.read_private(bundle_path),
    )
    broken = copy.deepcopy(bundle)
    signature = bytearray(base64.b64decode(broken["signature"]))
    signature[0] ^= 1
    broken["signature"] = base64.b64encode(signature).decode()
    try:
        recovery.restore_snapshot(reader, request, broken)
    except recovery.RecoveryError:
        pass
    else:
        raise RuntimeError("recovery_fixture_tamper_accepted")
    require(not models.VoiceprintDeletionJob.objects.exists(), "tamper_wrote_floor")
    output = io.StringIO()
    call_command(
        "restore_voiceprint_recovery",
        config=str(reader_path),
        request=str(request_path),
        bundle=str(bundle_path),
        receipt=str(receipt_path),
        stdout=output,
    )
    result = json.loads(output.getvalue())
    require(result == recovery.read_private(receipt_path), "receipt")
    deleted[0].refresh_from_db()
    deleted[0].consent.refresh_from_db()
    require(
        deleted[0].status == "deleted" and not deleted[0].encrypted_key,
        "deleted_key_erased",
    )
    require(
        deleted[0].consent.generation == 2
        and not deleted[0].consent.allow_identification,
        "deleted_consent_revoked",
    )
    require(
        not models.VoiceprintSample.objects.filter(
            pk__in=[s.pk for s in deleted[2]]
        ).exists(),
        "deleted_samples_erased",
    )
    require(
        not models.VoiceprintTemplate.objects.filter(pk=deleted[1].pk).exists(),
        "deleted_template_erased",
    )
    require(
        not models.VoiceprintSample.objects.filter(
            pk__in=[rejected.pk, source[2][0].pk]
        ).exists(),
        "individual_samples_erased",
    )
    source[0].refresh_from_db()
    source[1].refresh_from_db()
    require(
        source[0].status == "paused" and not source[1].encrypted_vector,
        "source_baseline_erased",
    )
    permission[0].consent.refresh_from_db()
    require(not permission[0].consent.allow_identification, "permission_revoked")
    valid[1].refresh_from_db()
    settings.MEETING_VOICEPRINT_ENABLED = True
    consent.authorize_profile(valid[0].pk, permission="allow_identification")
    require(
        ring.decrypt(
            valid[0], valid[1].encrypted_vector, kind="template", object_id=valid[1].pk
        )
        == template_payload(valid[1], unit),
        "valid_ciphertext_kept",
    )
    settings.MEETING_VOICEPRINT_ENABLED = False
    repeated = recovery.restore_snapshot(reader, request, bundle)
    require(repeated["permissions_restricted"] == 0, "idempotent_permissions")
    require(models.VoiceprintDeletionJob.objects.count() == 1, "idempotent_floor")
    recovery.offline()
    return {
        "status": "passed",
        "uid": os.getuid(),
        "offline": True,
        "old_profile_authorized_before_replay": True,
        "signature_tamper_rejected_before_projection": True,
        "deleted_samples_erased": 3,
        "deleted_templates_erased": 1,
        "individual_samples_erased": 2,
        "revoked_permissions_preserved": True,
        "valid_other_profile_authorized_after_replay": True,
        "independent_packet_survived_full_restore": True,
        "reader_has_no_signing_key": "signing_key" not in reader
        and not writer_path.exists(),
        "replay_idempotent": True,
        "fifo_rejected_without_blocking": True,
        "human_audio_used": False,
        "model_requests": 0,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(main(), sort_keys=True))
    except Exception as error:  # noqa: BLE001 -- Never disclose private framework/SQL/key errors.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__}))
        raise SystemExit(1)
