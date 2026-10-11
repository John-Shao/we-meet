"""Synthetic retention with real quota/provenance locks and bounded recovery."""

import io
import json
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from uuid import UUID, uuid4

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import close_old_connections, transaction
from django.utils import timezone

import pytest
from livekit import api

from core import models
from core.services import voiceprint_consent as consent
from core.services import voiceprint_jobs as encoding
from core.services import voiceprint_maintenance as service
from core.services import voiceprint_sampling as sampling
from core.services import voiceprint_source_removal as removal
from core.tests.services.test_voiceprint_consent import sample_for
from core.tests.services.test_voiceprint_devices import (
    call_baseline,
    capture,
    connection,
    feature,
    prepared,
)
from core.tests.services.test_voiceprint_enrollment import wav
from core.tests.services.test_voiceprint_sampling import enabled

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def queue(monkeypatch):
    monkeypatch.setattr(removal, "schedule", lambda: None)


def now_at(monkeypatch, instant):
    monkeypatch.setattr(service.timezone, "now", lambda: instant)


def end_session(fixture):
    fixture.session.status = "ended"
    fixture.session.ended_at = timezone.now()
    fixture.session.end_reason = "room_finished"
    fixture.session.save(update_fields=["status", "ended_at", "end_reason"])


def unpublish(fixture):
    sampling.record_track(
        participation=fixture.participant,
        track=api.TrackInfo(
            sid=fixture.track.livekit_track_sid,
            source=api.TrackSource.MICROPHONE,
            type=api.TrackType.AUDIO,
        ),
        published=False,
        event_at=timezone.now(),
    )


def test_confirmed_audio_is_cleared_promptly_without_changing_features_or_receipts(
    prepared,
):
    _, profile, samples, template = call_baseline(prepared)
    features = {row.pk: bytes(row.encrypted_embedding) for row in samples}
    receipts = {row.pk: sampling.receipt_evidence(row) for row in samples}
    cipher = bytes(template.encrypted_vector)
    result = service.tick()
    assert result["audio_cleared"] == 3 and result["sample_purged"] == 0
    for sample in samples:
        sample.refresh_from_db()
        assert sample.status == "confirmed" and not sample.encrypted_audio
        assert bytes(sample.encrypted_embedding) == features[sample.pk]
        assert sampling.receipt_evidence(sample) == receipts[sample.pk]
    template.refresh_from_db()
    assert bytes(template.encrypted_vector) == cipher and template.revision == 1
    assert consent.ready_device_groups(profile) == ["headset"]
    assert not any(service.tick().values())


def test_call_candidate_ttl_purges_jobs_and_retains_quota_for_active_session(
    prepared, monkeypatch
):
    fixture, _ = prepared
    grant = fixture.issue()
    receipt = sampling.ingest(
        UUID(grant["id"]),
        token=grant["token"],
        **fixture.wire(),
        wav=wav(101, seconds=10),
    )
    sample = models.VoiceprintSample.objects.get(pk=receipt["id"])
    lease = encoding.claim(sample.encoding_job.pk)
    now_at(monkeypatch, sample.expires_at + timezone.timedelta(seconds=1))
    result = service.tick()
    assert result["sample_purged"] == 1
    assert not models.VoiceprintSample.objects.filter(pk=sample.pk).exists()
    assert not models.VoiceprintEncodingJob.objects.filter(sample_id=sample.pk).exists()
    assert not encoding.authorized(lease)
    permit = models.VoiceprintSamplingPermit.objects.get(pk=grant["id"])
    assert permit.status == "canceled" and permit.max_duration_ms == 10000
    assert permit.track_id is permit.profile_id is permit.sample_id is None
    assert not permit.participant_identity
    job = models.VoiceprintContributionRemoval.objects.get(sample_uuid=sample.pk)
    assert job.status == "purged" and job.purged_at is not None


@pytest.mark.parametrize(
    "status", ["pending", "ready", "rejected", "expired", "deleted"]
)
def test_unconfirmed_registration_rows_and_private_decisions_are_physically_removed(
    prepared, status
):
    fixture, profile = prepared
    sample = sample_for(profile, ready=True)
    models.VoiceprintSample.objects.filter(pk=sample.pk).update(
        status=status, expires_at=timezone.now() - timezone.timedelta(seconds=1)
    )
    result = service.tick()
    assert result["sample_purged"] == 1
    assert not models.VoiceprintSample.objects.filter(pk=sample.pk).exists()
    assert not models.VoiceprintSampleDecision.objects.filter(
        sample_id=sample.pk
    ).exists()
    assert models.VoiceprintEnrollment.objects.filter(pk=sample.enrollment_id).exists()
    assert fixture.session.status == "active"


def test_current_confirmed_feature_and_origin_survive_audio_ttl_and_normal_end(
    prepared, monkeypatch
):
    fixture, profile, samples, _ = call_baseline(prepared)
    end_session(fixture)
    now_at(
        monkeypatch,
        max(row.expires_at for row in samples) + timezone.timedelta(seconds=1),
    )
    result = service.tick()
    assert result["audio_cleared"] == 3
    assert (
        result["permit_purged"]
        == result["track_purged"]
        == result["sample_purged"]
        == 0
    )
    assert (
        models.VoiceprintSamplingPermit.objects.filter(
            sample_id__in=[s.pk for s in samples]
        ).count()
        == 3
    )
    assert models.VoiceprintSamplingTrack.objects.filter(pk=fixture.track.pk).exists()
    assert consent.ready_device_groups(profile) == ["headset"]


def test_expired_old_generation_features_are_removed_without_mutating_new_profile(
    prepared,
):
    _, profile, samples, template = call_baseline(prepared)
    models.VoiceprintConsent.objects.filter(pk=profile.consent_id).update(
        generation=profile.generation + 1
    )
    models.VoiceprintProfile.objects.filter(pk=profile.pk).update(
        generation=profile.generation + 1
    )
    models.VoiceprintSample.objects.filter(pk__in=[s.pk for s in samples]).update(
        expires_at=timezone.now() - timezone.timedelta(seconds=1)
    )
    assert service.tick()["sample_purged"] == 3
    profile.refresh_from_db()
    template.refresh_from_db()
    assert profile.status == "active" and profile.generation == 2
    assert not template.encrypted_vector


def test_unexpired_candidate_and_unfinished_confirmed_feature_keep_audio(prepared):
    _, profile = prepared
    pending = sample_for(profile)
    unfinished = sample_for(profile)
    models.VoiceprintSample.objects.filter(pk=unfinished.pk).update(status="confirmed")
    assert not any(service.tick().values())
    pending.refresh_from_db()
    unfinished.refresh_from_db()
    assert pending.encrypted_audio and unfinished.encrypted_audio


def test_expired_permit_scrubs_private_context_preserves_nonce_and_does_not_refund_quota(
    prepared, monkeypatch
):
    fixture, _ = prepared
    key = uuid4()
    grant = fixture.issue(key)
    permit = models.VoiceprintSamplingPermit.objects.get(pk=grant["id"])
    now_at(monkeypatch, permit.expires_at + timezone.timedelta(seconds=1))
    assert service.tick()["permit_expired"] == 1
    permit.refresh_from_db()
    assert permit.status == "expired" and permit.owner == fixture.user
    assert permit.track_id == fixture.track.pk and permit.profile_id is None
    assert permit.max_duration_ms == 10000
    assert not permit.participant_identity and not permit.source_track_sid
    with pytest.raises(
        consent.VoiceprintError, match="voiceprint_sampling_permit_unavailable"
    ):
        fixture.issue(key)
    assert models.VoiceprintSamplingPermit.objects.count() == 1
    assert not any(service.tick().values())


def test_long_session_keeps_older_reservations_and_session_budget(
    prepared, monkeypatch
):
    fixture, _ = prepared
    for _ in range(6):
        grant = fixture.issue()
        models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).update(
            expires_at=timezone.now() - timezone.timedelta(seconds=1), status="expired"
        )
    now_at(monkeypatch, timezone.now() + timezone.timedelta(hours=25))
    assert service.tick()["permit_scrubbed"] == 6
    assert models.VoiceprintSamplingPermit.objects.count() == 6
    with pytest.raises(consent.VoiceprintError, match="voiceprint_sampling_quota"):
        fixture.issue()
    newer = connection(fixture)
    assert newer.issue()
    end_session(fixture)
    result = service.tick()
    assert result["permit_purged"] == 6 and result["track_purged"] == 1
    assert models.VoiceprintSamplingPermit.objects.count() == 1


def test_exact_24_hour_boundary_keeps_daily_reservation_then_releases_closed_session(
    prepared, monkeypatch, settings
):
    fixture, _ = prepared
    settings.MEETING_VOICEPRINT_SAMPLING_DAILY_MS = 10000
    base = timezone.now()
    now_at(monkeypatch, base)
    grant = fixture.issue()
    end_session(fixture)
    now_at(monkeypatch, base + timezone.timedelta(hours=24))
    assert service.tick()["permit_purged"] == 0
    newer = connection(fixture)
    with pytest.raises(consent.VoiceprintError, match="voiceprint_sampling_quota"):
        newer.issue()
    now_at(monkeypatch, base + timezone.timedelta(hours=24, microseconds=1))
    assert service.tick()["permit_purged"] == 1
    assert not models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).exists()
    assert newer.issue()


@pytest.mark.parametrize("closure", ["unpublished", "left", "ended"])
def test_unreferenced_closed_track_prunes_with_persistent_late_publish_fence(
    prepared, closure
):
    fixture, _ = prepared
    identifier, sid = fixture.track.pk, fixture.track.livekit_track_sid
    if closure == "unpublished":
        unpublish(fixture)
    elif closure == "left":
        models.MeetingParticipation.objects.filter(pk=fixture.participant.pk).update(
            left_at=timezone.now()
        )
    else:
        end_session(fixture)
    assert service.tick()["track_purged"] == 1
    assert not models.VoiceprintSamplingTrack.objects.filter(pk=identifier).exists()
    assert models.VoiceprintSourceRemoval.objects.filter(
        kind="track", source_uuid=identifier, track_digest=removal.track_digest(sid)
    ).exists()
    with pytest.raises(
        consent.VoiceprintError, match="voiceprint_sampling_track_removed"
    ):
        sampling.record_track(
            participation=fixture.participant,
            track=api.TrackInfo(
                sid=sid, source=api.TrackSource.MICROPHONE, type=api.TrackType.AUDIO
            ),
            published=True,
            event_at=timezone.now(),
        )


def test_live_track_and_closed_track_with_sample_reference_are_never_pruned(prepared):
    fixture, _ = prepared
    assert not any(service.tick().values())
    sample = capture(fixture, 103, confirm=False)
    models.VoiceprintSamplingPermit.objects.filter(sample=sample).delete()
    unpublish(fixture)
    assert service.clean_track(fixture.track.pk) == "retained"
    assert fixture.track.pk not in service.track_ids(20)
    assert models.VoiceprintSamplingTrack.objects.filter(pk=fixture.track.pk).exists()


def test_feature_off_and_missing_keyring_do_not_delay_erasure(prepared, settings):
    fixture, profile = prepared
    sample = sample_for(profile)
    models.VoiceprintSample.objects.filter(pk=sample.pk).update(
        expires_at=timezone.now() - timezone.timedelta(seconds=1)
    )
    grant = fixture.issue()
    settings.MEETING_VOICEPRINT_ENABLED = False
    settings.MEETING_VOICEPRINT_KEYRING_FILE = "does-not-exist"
    models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).update(
        expires_at=timezone.now()
    )
    result = service.tick()
    assert result["sample_purged"] == result["permit_expired"] == 1
    assert result["failed"] == 0


def test_batch_limit_covers_each_category_and_does_not_repeat_terminal_rows(prepared):
    _, profile = prepared
    samples = [sample_for(profile) for _ in range(3)]
    models.VoiceprintSample.objects.filter(pk__in=[s.pk for s in samples]).update(
        expires_at=timezone.now() - timezone.timedelta(seconds=1)
    )
    assert service.tick(limit=1)["sample_purged"] == 1
    assert (
        models.VoiceprintSample.objects.filter(pk__in=[s.pk for s in samples]).count()
        == 2
    )
    assert service.tick(limit=2)["sample_purged"] == 2
    assert not any(service.tick().values())


@pytest.mark.parametrize("sweeper", ["maintenance", "source_recovery"])
def test_current_tombstone_repurges_restored_sample_without_erasing_rebuilt_template(
    prepared, sweeper
):
    _, profile, samples, template = call_baseline(prepared, count=4)
    snapshot = models.VoiceprintSample.objects.filter(pk=samples[0].pk).values().get()
    identifier = snapshot["id"]
    samples[0].delete()
    assert removal.tick()["complete"] == 1
    job = models.VoiceprintContributionRemoval.objects.get(sample_uuid=identifier)
    assert job.status == "complete"
    template.refresh_from_db()
    cipher, revision = bytes(template.encrypted_vector), template.revision
    # Simulate an old row restored while the current trusted tombstone remains.
    models.VoiceprintSample.objects.bulk_create([models.VoiceprintSample(**snapshot)])
    assert removal.sample_removed(identifier)
    if sweeper == "maintenance":
        assert service.tick()["sample_purged"] == 1
        job.refresh_from_db()
        assert job.status == "purged" and job.completed_at is None
        assert removal.tick()["complete"] == 1
    else:
        assert removal.tick()["complete"] == 1
    assert not models.VoiceprintSample.objects.filter(pk=identifier).exists()
    template.refresh_from_db()
    assert bytes(template.encrypted_vector) == cipher and template.revision == revision
    assert consent.ready_device_groups(profile) == ["headset"]


def test_prune_rechecks_closure_and_references_after_batch_selection(prepared):
    fixture, _ = prepared
    unpublish(fixture)
    assert fixture.track.pk in service.track_ids(20)
    models.VoiceprintSamplingTrack.objects.filter(pk=fixture.track.pk).update(
        unpublished_at=None
    )
    assert service.clean_track(fixture.track.pk) == "retained"
    assert models.VoiceprintSamplingTrack.objects.filter(pk=fixture.track.pk).exists()
    assert not models.VoiceprintSourceRemoval.objects.exists()


def test_malformed_legacy_track_sid_does_not_block_private_metadata_cleanup(prepared):
    fixture, _ = prepared
    unpublish(fixture)
    models.VoiceprintSamplingTrack.objects.filter(pk=fixture.track.pk).update(
        livekit_track_sid="旧轨道引用"
    )
    assert service.tick()["track_purged"] == 1
    assert models.VoiceprintSourceRemoval.objects.filter(
        kind="track",
        source_uuid=fixture.track.pk,
        track_digest=removal.track_digest("旧轨道引用"),
    ).exists()


def test_expired_orphaned_permit_does_not_require_a_valid_profile_or_track(prepared):
    fixture, _ = prepared
    grant = fixture.issue()
    models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).update(
        profile=None, track=None, expires_at=timezone.now()
    )
    assert service.tick()["permit_expired"] == 1
    permit = models.VoiceprintSamplingPermit.objects.get(pk=grant["id"])
    assert permit.status == "expired" and permit.max_duration_ms == 10000
    assert not permit.participant_identity


def test_periodic_task_discovery_command_and_private_failure_output(
    prepared, settings, monkeypatch
):
    fixture, _ = prepared
    grant = fixture.issue()
    models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).update(
        expires_at=timezone.now()
    )
    schedule = settings.CELERY_BEAT_SCHEDULE["maintain-voiceprints"]
    module, name = schedule["task"].rsplit(".", 1)
    task = getattr(import_module(module), name)
    assert schedule["options"]["queue"] == "voiceprint"
    assert schedule["schedule"] <= schedule["options"]["expires"]
    assert task()["permit_expired"] == 1
    models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).update(
        status="issued"
    )

    def fail(identifier):
        raise RuntimeError("private participant identity or provider details")

    monkeypatch.setattr(service, "clean_permit", fail)
    output = io.StringIO()
    call_command("maintain_voiceprints", stdout=output)
    assert json.loads(output.getvalue())["failed"] == 1
    assert "private" not in output.getvalue()


@pytest.mark.parametrize("limit", [0, 101])
def test_invalid_batch_limit_is_rejected(limit):
    with pytest.raises(CommandError):
        call_command("maintain_voiceprints", limit=limit, stdout=io.StringIO())


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("locked", ["owner", "session", "track"])
def test_busy_owner_or_session_skips_without_erasure_and_resumes(prepared, locked):
    fixture, _ = prepared
    grant = fixture.issue()
    models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).update(
        expires_at=timezone.now()
    )

    def attempt():
        close_old_connections()
        try:
            return service.tick()
        finally:
            close_old_connections()

    with transaction.atomic():
        if locked == "owner":
            models.User.objects.select_for_update().get(pk=fixture.user.pk)
        elif locked == "session":
            models.MeetingSession.objects.select_for_update().get(pk=fixture.session.pk)
        else:
            models.VoiceprintSamplingTrack.objects.select_for_update().get(
                pk=fixture.track.pk
            )
        with ThreadPoolExecutor(max_workers=1) as executor:
            assert executor.submit(attempt).result(timeout=10)["busy"] == 1
    assert service.tick()["permit_expired"] == 1
