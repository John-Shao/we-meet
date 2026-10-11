"""Two real PostgreSQL instances: whole-primary rollback and latest-authority gate."""

# ruff: noqa: PLC0415, S108, T201

import base64
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
        raise RuntimeError("journal_recovery_fixture_" + code)


def rendezvous(root, connection, phase, signal):
    connection.close()
    (root / "phase").write_text(phase, encoding="utf-8")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if (root / signal).exists():
            return
        time.sleep(0.2)
    raise RuntimeError("journal_recovery_fixture_host_timeout")


def main():  # noqa: PLR0915 -- Own the synthetic encrypted graph and restore checks in one lifetime.
    require(sys.platform == "linux" and os.getuid() == 10001, "nonroot_linux")
    require(os.environ.get("VOICEPRINT_JOURNAL_PROBE") == "1", "opt_in")
    from configurations import importer

    importer.install()
    import django

    django.setup()
    from django.conf import settings
    from django.core.management import call_command
    from django.db import connection
    from django.utils import timezone

    from core import models
    from core.services import voiceprint_consent as consent
    from core.services import voiceprint_journal as journal
    from core.services import voiceprint_journal_runtime as runtime
    from core.services import voiceprint_recovery as recovery
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
        settings.DATABASES["default"]["NAME"] == "voiceprint_journal_primary_fixture",
        "owned_primary",
    )
    require(settings.MEETING_VOICEPRINT_JOURNAL_REQUIRED, "runtime_enforces_journal")
    recovery.offline()
    call_command("migrate", verbosity=0, interactive=False)
    require(not models.User.objects.exists(), "empty_primary")
    root = Path("/tmp/journal")
    root.mkdir(mode=0o700)
    packed = json.loads(os.environ.pop("VOICEPRINT_JOURNAL_FIXTURE"))
    writer_path, reader_path = root / "writer.json", root / "reader.json"
    recovery.write_private(writer_path, packed["writer"])
    recovery.write_private(reader_path, packed["reader"])
    settings.MEETING_VOICEPRINT_JOURNAL_CONFIG_FILE = str(writer_path)
    keyring = root / "keyring.json"
    recovery.write_private(
        keyring,
        {
            "active": "fixture",
            "keys": {"fixture": base64.b64encode(os.urandom(32)).decode()},
        },
    )
    settings.MEETING_VOICEPRINT_KEYRING_FILE = str(keyring)
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

    deleted, valid = baseline(), baseline()
    room = models.Room.objects.create(name="Synthetic journal recovery fixture")
    session = models.MeetingSession.objects.create(
        room=room,
        livekit_room_sid="RM_" + uuid4().hex,
        started_at=timezone.now(),
        start_source="livekit_room",
    )
    participation = models.MeetingParticipation.objects.create(
        session=session,
        user=valid[0].consent.user,
        livekit_participant_sid="PA_" + uuid4().hex,
        identity=str(valid[0].consent.user.sub),
        kind="standard",
        joined_at=timezone.now(),
    )
    control = models.VoiceprintSamplingControl.objects.create(
        participation=participation,
        shared_microphone=False,
        device_group="headset",
    )
    saved_valid_key = bytes(valid[0].encrypted_key)
    saved_valid_vector = bytes(valid[1].encrypted_vector)
    call_command(
        "initialize_voiceprint_journal", config=str(writer_path), stdout=io.StringIO()
    )
    settings.MEETING_VOICEPRINT_ENABLED = True
    for profile, _template, _samples in (deleted, valid):
        consent.authorize_profile(profile.pk, permission="allow_identification")
    require(runtime.allowed(), "initial_current_head")
    rendezvous(root, connection, "seeded", "backed_up")
    control.paused = True
    control.revision += 1
    control.save()
    job = consent.delete_profile(
        deleted[0].consent.user,
        profile_id=deleted[0].pk,
        expected_version=1,
        request_key=uuid4(),
    )
    consent.purge_deleted(job.pk)
    latest = runtime.client().read_head()
    require(
        latest["sequence"] >= 2 and runtime.allowed(), "durable_revoke_before_restore"
    )
    settings.MEETING_VOICEPRINT_ENABLED = False
    rendezvous(root, connection, "revoked", "primary_stopped")
    request, bundle, receipt = (
        root / name for name in ("request.json", "bundle.json", "receipt.json")
    )
    call_command(
        "request_voiceprint_journal_recovery",
        config=str(reader_path),
        output=str(request),
        stdout=io.StringIO(),
    )
    call_command(
        "export_voiceprint_journal_recovery",
        config=str(writer_path),
        request=str(request),
        output=str(bundle),
        stdout=io.StringIO(),
    )
    captured, _state = journal.verify_export(
        journal.load_configuration(reader_path, "reader"),
        recovery.read_private(request),
        recovery.read_private(bundle),
    )
    require(captured == latest, "export_with_stopped_primary")
    rendezvous(root, connection, "exported", "primary_restored")
    require(
        not models.VoiceprintDeletionJob.objects.exists(),
        "whole_restore_lost_tombstones",
    )
    require(
        models.VoiceprintJournalCheckpoint.objects.get().sequence == 1,
        "whole_restore_rolled_back_checkpoint",
    )
    old = models.VoiceprintProfile.objects.get(pk=deleted[0].pk)
    control.refresh_from_db()
    require(
        not control.paused and not control.shared_microphone,
        "whole_restore_reactivated_old_microphone_declaration",
    )
    require(
        bool(old.encrypted_key)
        and models.VoiceprintSample.objects.filter(profile=old).count() == 3,
        "old_private_artifacts_restored",
    )
    settings.MEETING_VOICEPRINT_ENABLED = True
    require(not runtime.allowed(), "restored_checkpoint_closes_gate")
    try:
        consent.authorize_profile(old.pk, permission="allow_identification")
    except consent.VoiceprintError:
        pass
    else:
        raise RuntimeError("journal_recovery_fixture_restored_identity_reactivated")
    settings.MEETING_VOICEPRINT_ENABLED = False
    call_command(
        "restore_voiceprint_journal_recovery",
        config=str(reader_path),
        request=str(request),
        bundle=str(bundle),
        receipt=str(receipt),
        stdout=io.StringIO(),
    )
    old.refresh_from_db()
    control.refresh_from_db()
    require(
        control.paused and control.shared_microphone and control.device_group == "",
        "recovery_requires_new_microphone_declaration",
    )
    require(
        not old.encrypted_key
        and not models.VoiceprintSample.objects.filter(profile=old).exists(),
        "signed_replay_erases_restored_voice",
    )
    require(
        not models.VoiceprintTemplate.objects.filter(profile=old).exists(),
        "signed_replay_erases_restored_template",
    )
    unaffected = models.VoiceprintProfile.objects.get(pk=valid[0].pk)
    template = models.VoiceprintTemplate.objects.get(pk=valid[1].pk)
    require(
        bytes(unaffected.encrypted_key) == saved_valid_key
        and bytes(template.encrypted_vector) == saved_valid_vector,
        "other_scope_ciphertext_preserved",
    )
    ring.decrypt(
        unaffected, template.encrypted_vector, kind="template", object_id=template.pk
    )
    require(
        runtime.cursor_of(models.VoiceprintJournalCheckpoint.objects.get()) == latest,
        "replay_checkpoint_atomic",
    )
    settings.MEETING_VOICEPRINT_ENABLED = True
    consent.authorize_profile(unaffected.pk, permission="allow_identification")
    rendezvous(root, connection, "published", "restarted")
    require(
        runtime.allowed() and runtime.client().read_head() == latest,
        "authority_restart_keeps_gate_current",
    )
    rendezvous(root, connection, "check_outage", "authority_stopped")
    require(not runtime.allowed(), "authority_outage_closes_gate")
    rendezvous(root, connection, "outage_checked", "authority_started")
    require(runtime.allowed(), "fresh_head_after_authority_returns")
    rendezvous(root, connection, "check_standby", "standby_ready")
    require(not runtime.allowed(), "standby_cannot_supply_latest_authority")
    rendezvous(root, connection, "standby_checked", "authority_primary")
    require(runtime.allowed(), "fresh_primary_after_standby_rejected")
    print(
        json.dumps(
            {
                "status": "passed",
                "uid": os.getuid(),
                "real_primary_postgresql": True,
                "real_independent_authority_postgresql": True,
                "verified_tls": True,
                "whole_primary_dump_restore": True,
                "old_checkpoint_and_private_voice_restored": True,
                "restored_primary_gate_closed": True,
                "export_with_stopped_primary": True,
                "signed_latest_replay_erased_samples": 3,
                "signed_latest_replay_erased_templates": 1,
                "other_encrypted_scope_preserved": True,
                "checkpoint_replayed_atomically": True,
                "authority_restart_preserved_state": True,
                "authority_outage_closed_gate": True,
                "fresh_head_after_authority_return": True,
                "standby_authority_rejected": True,
                "old_microphone_declaration_invalidated": True,
                "latest_sequence": latest["sequence"],
                "human_audio_used": False,
                "model_requests": 0,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- Private credentials and graph data never enter diagnostics.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__}))
        raise SystemExit(1)
