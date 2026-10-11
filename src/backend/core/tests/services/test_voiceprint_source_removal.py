"""Source deletion fences, physical erasure and recovery using synthetic media."""

import io
import json
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from threading import Event
from uuid import UUID

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import close_old_connections, transaction
from django.utils import timezone

import pytest
from livekit import api

from core import models
from core.services import voiceprint_consent as consent
from core.services import voiceprint_jobs as encoding
from core.services import voiceprint_sampling as sampling
from core.services import voiceprint_source_removal as removal
from core.services import voiceprint_templates as templates
from core.services.voiceprint_retention import expire_sample
from core.tasks.voiceprint_source_removal import drain_voiceprint_source_removals
from core.tests.services.test_voiceprint_devices import (
    call_baseline,
    capture,
    connection,
    feature,
    prepared,
    supplement,
)
from core.tests.services.test_voiceprint_enrollment import wav
from core.tests.services.test_voiceprint_sampling import enabled
from core.tests.services.test_voiceprint_templates import decrypt_template

pytestmark = pytest.mark.django_db
REAL_SCHEDULE = removal.schedule


@pytest.fixture(autouse=True)
def queue(monkeypatch):
    # Workers run explicitly so pre-worker fences and retries are observable.
    monkeypatch.setattr(removal, "schedule", lambda: None)


def record_for(fixture):
    return models.MeetingRecord.objects.create(
        owner=fixture.user,
        organization=fixture.organization,
        source_type="meeting",
        meeting_session=fixture.session,
        source_session_id=fixture.session.pk,
        origin_at=timezone.now(),
    )


def remove_origin(fixture, kind):
    if kind == "track":
        fixture.track.delete()
    elif kind == "session":
        fixture.session.delete()
    elif kind == "room":
        fixture.room.delete()
    else:
        record = record_for(fixture)
        if kind == "record_delete":
            record.delete()
        else:
            record.deleted_at = timezone.now()
            record.save(update_fields=["deleted_at"])
        return record
    return None


@pytest.mark.parametrize(
    "kind", ["track", "session", "room", "record_trash", "record_delete"]
)
def test_origin_removal_fences_then_erases_contributions_and_retains_quota(
    prepared, kind
):
    fixture, profile, samples, anchor = call_baseline(prepared)
    # An issued permit must also stop; its unused reservation is not refunded.
    grant = fixture.issue()
    sample_ids = [row.pk for row in samples]
    permit_ids = list(
        models.VoiceprintSamplingPermit.objects.filter(owner=fixture.user).values_list(
            "pk", flat=True
        )
    )
    session_id = fixture.session.pk
    remove_origin(fixture, kind)
    assert consent.ready_device_groups(profile) == []
    assert models.VoiceprintSample.objects.filter(pk__in=sample_ids).count() == 3
    assert models.VoiceprintContributionRemoval.objects.count() == 3
    assert (
        models.VoiceprintSamplingPermit.objects.get(pk=grant["id"]).status == "canceled"
    )
    assert removal.tick()["complete"] == 3
    assert not models.VoiceprintSample.objects.filter(pk__in=sample_ids).exists()
    assert not models.VoiceprintEncodingJob.objects.filter(
        sample_id__in=sample_ids
    ).exists()
    assert not models.VoiceprintQualityJob.objects.filter(
        sample_id__in=sample_ids
    ).exists()
    assert not models.VoiceprintSampleDecision.objects.filter(
        sample_id__in=sample_ids
    ).exists()
    anchor.refresh_from_db()
    profile.refresh_from_db()
    assert anchor.status == "paused" and not anchor.encrypted_vector
    assert profile.status == "paused"
    for permit in models.VoiceprintSamplingPermit.objects.filter(pk__in=permit_ids):
        assert permit.source_session_id == session_id and permit.owner == fixture.user
        assert permit.max_duration_ms == 10000
        assert permit.status == "canceled"
        assert permit.sample_id is permit.profile_id is permit.track_id is None
        assert not any(
            [
                permit.participant_sid,
                permit.participant_identity,
                permit.livekit_room_sid,
                permit.source_track_sid,
                permit.device_group,
            ]
        )
    assert removal.tick()["complete"] == 0


def test_restoring_record_does_not_restore_old_samples_or_capture_permissions(prepared):
    fixture, profile, _, _ = call_baseline(prepared)
    record = remove_origin(fixture, "record_trash")
    record.deleted_at = None
    record.save(update_fields=["deleted_at"])
    assert consent.ready_device_groups(profile) == []
    assert removal.session_removed(fixture.session.pk)
    with pytest.raises(consent.VoiceprintError):
        fixture.issue()
    assert removal.tick()["complete"] == 3


def test_track_tombstone_blocks_delayed_publish_and_preserves_other_tracks(prepared):
    fixture, profile, _, _ = call_baseline(prepared)
    other = connection(fixture, group="headset")
    survivor = capture(other, 910)
    removed_id, sid = fixture.track.pk, fixture.track.livekit_track_sid
    fixture.track.delete()
    tombstone = models.VoiceprintSourceRemoval.objects.get(
        kind="track", source_uuid=removed_id
    )
    assert tombstone.source_session_id is None
    assert tombstone.track_digest == removal.track_digest(sid)
    assert sid not in json.dumps(tombstone.track_digest)
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
    removal.tick()
    assert models.VoiceprintSample.objects.filter(pk=survivor.pk).exists()
    assert other.issue()


def test_removed_supplement_erases_its_cipher_without_altering_baseline(prepared):
    fixture, profile, _, anchor = call_baseline(prepared)
    first, _, samples, added = supplement(fixture, profile)
    original = bytes(anchor.encrypted_vector)
    first.track.delete()
    assert consent.ready_device_groups(profile) == ["headset"]
    assert removal.tick()["complete"] == 2
    anchor.refresh_from_db()
    added.refresh_from_db()
    assert bytes(anchor.encrypted_vector) == original and anchor.revision == 1
    assert added.status == "paused" and not added.encrypted_vector
    assert models.VoiceprintSample.objects.filter(pk=samples[-1].pk).exists()
    assert consent.ready_device_groups(profile) == ["headset"]


def test_baseline_removal_erases_dependents_before_independent_rebuild(prepared):
    fixture, profile, samples, anchor = call_baseline(prepared, count=4)
    _, _, _, added = supplement(fixture, profile)
    identifier = samples[0].pk
    permit_id = samples[0].sampling_permit.pk
    samples[0].delete()
    job = models.VoiceprintContributionRemoval.objects.get(sample_uuid=identifier)
    assert removal.purge(job.pk) == "purged"
    permit = models.VoiceprintSamplingPermit.objects.get(pk=permit_id)
    assert permit.track_id is permit.profile_id is None
    assert not permit.participant_identity and not permit.source_track_sid
    anchor.refresh_from_db()
    added.refresh_from_db()
    assert not anchor.encrypted_vector and not added.encrypted_vector
    assert removal.process_one(job.pk) == "complete"
    anchor.refresh_from_db()
    added.refresh_from_db()
    assert anchor.support_samples.count() == 3
    assert decrypt_template(anchor)
    assert decrypt_template(added)
    assert consent.ready_device_groups(profile) == ["handset", "headset"]


@pytest.mark.parametrize("rebuilt", [False, True])
def test_delayed_cleanup_wipes_paused_old_cipher_but_preserves_fresh_rebuild(
    prepared, rebuilt
):
    _, profile, samples, anchor = call_baseline(prepared, count=4)
    identifier = samples[0].pk
    samples[0].delete()
    job = models.VoiceprintContributionRemoval.objects.get(sample_uuid=identifier)
    if rebuilt:
        assert templates.build(profile.pk).status == "built"
    else:
        anchor.status = "paused"
        anchor.revision += 1
        anchor.save(update_fields=["status", "revision"])
    anchor.refresh_from_db()
    current = bytes(anchor.encrypted_vector)
    assert removal.purge(job.pk) == "purged"
    anchor.refresh_from_db()
    if rebuilt:
        assert bytes(anchor.encrypted_vector) == current
        assert consent.ready_device_groups(profile) == ["headset"]
    else:
        assert not anchor.encrypted_vector


def test_deleted_source_stops_encoding_lease_before_worker_cleanup(prepared):
    fixture, _ = prepared
    grant = fixture.issue()
    receipt = sampling.ingest(
        UUID(grant["id"]),
        token=grant["token"],
        **fixture.wire(),
        wav=wav(99, seconds=10),
    )
    sample = models.VoiceprintSample.objects.get(pk=receipt["id"])
    lease = encoding.claim(sample.encoding_job.pk)
    fixture.track.delete()
    assert not encoding.authorized(lease)
    assert not encoding.finish(lease, error=RuntimeError("private provider diagnostic"))
    assert removal.tick()["complete"] == 1
    assert not models.VoiceprintSample.objects.filter(pk=sample.pk).exists()


def test_feature_off_does_not_delay_physical_erasure_and_rebuild_resumes(
    prepared, settings
):
    _, profile, samples, anchor = call_baseline(prepared, count=4)
    identifier = samples[0].pk
    # Keep the row present to verify physical deletion even with the feature off.
    removal.enroll(models.VoiceprintSample.objects.filter(pk=identifier))
    settings.MEETING_VOICEPRINT_ENABLED = False
    assert removal.tick()["deferred"] == 1
    job = models.VoiceprintContributionRemoval.objects.get(sample_uuid=identifier)
    assert job.status == "purged" and job.purged_at is not None
    assert not models.VoiceprintSample.objects.filter(pk=identifier).exists()
    anchor.refresh_from_db()
    assert not anchor.encrypted_vector
    settings.MEETING_VOICEPRINT_ENABLED = True
    job.next_attempt_at = timezone.now()
    job.save(update_fields=["next_attempt_at"])
    assert removal.tick()["complete"] == 1
    assert consent.ready_device_groups(profile) == ["headset"]


def test_broker_failure_preserves_intents_for_management_recovery(
    prepared, monkeypatch, django_capture_on_commit_callbacks, caplog
):
    fixture, _, samples, _ = call_baseline(prepared)
    monkeypatch.setattr(removal, "schedule", REAL_SCHEDULE)

    def unavailable():
        raise RuntimeError("private broker details")

    monkeypatch.setattr(drain_voiceprint_source_removals, "delay", unavailable)
    with django_capture_on_commit_callbacks(execute=True):
        fixture.track.delete()
    assert "voiceprint_source_cleanup_enqueue_unavailable" in caplog.text
    assert "private broker details" not in caplog.text
    output = io.StringIO()
    call_command("purge_voiceprint_sources", limit=2, stdout=output)
    assert json.loads(output.getvalue())["complete"] == 2
    assert (
        models.VoiceprintSample.objects.filter(pk__in=[r.pk for r in samples]).count()
        == 1
    )
    call_command("purge_voiceprint_sources", stdout=io.StringIO())
    assert not models.VoiceprintSample.objects.filter(
        pk__in=[r.pk for r in samples]
    ).exists()


def test_source_transaction_rollback_does_not_persist_fences_or_intents(prepared):
    fixture, profile, _, _ = call_baseline(prepared)
    track_id = fixture.track.pk
    with pytest.raises(RuntimeError, match="rollback"):
        with transaction.atomic():
            fixture.track.delete()
            raise RuntimeError("rollback")
    assert models.VoiceprintSamplingTrack.objects.filter(pk=track_id).exists()
    assert not models.VoiceprintSourceRemoval.objects.exists()
    assert not models.VoiceprintContributionRemoval.objects.exists()
    assert consent.ready_device_groups(profile) == ["headset"]


def test_reconciliation_recovers_bulk_trash_without_recursive_dispatch(
    prepared, monkeypatch
):
    fixture, profile, _, _ = call_baseline(prepared)
    record = record_for(fixture)
    models.MeetingRecord.objects.filter(pk=record.pk).update(deleted_at=timezone.now())
    assert consent.ready_device_groups(profile) == []
    assert not models.VoiceprintContributionRemoval.objects.exists()

    def recursive_dispatch():
        pytest.fail("Recovery must stay in the current worker")

    monkeypatch.setattr(removal, "schedule", recursive_dispatch)
    assert removal.tick()["complete"] == 3


def test_reconciliation_recovers_missing_receipt_and_keeps_other_samples(prepared):
    _, profile, samples, _ = call_baseline(prepared, count=4)
    # Simulate an origin removed before this lifecycle handler was installed.
    models.VoiceprintSamplingPermit.objects.filter(sample=samples[0]).delete()
    assert removal.tick()["complete"] == 1
    assert not models.VoiceprintSample.objects.filter(pk=samples[0].pk).exists()
    assert models.VoiceprintSample.objects.filter(profile=profile).count() == 3
    assert consent.ready_device_groups(profile) == ["headset"]


def test_normal_end_pause_and_preview_expiry_are_not_source_deletion(prepared):
    fixture, profile, samples, anchor = call_baseline(prepared)
    fixture.control(paused=True)
    fixture.session.status = "ended"
    fixture.session.ended_at = timezone.now()
    fixture.session.end_reason = "room_finished"
    fixture.session.save(update_fields=["status", "ended_at", "end_reason"])
    for sample in samples:
        sample.expires_at = timezone.now() - timezone.timedelta(seconds=1)
        sample.save(update_fields=["expires_at"])
        assert expire_sample(sample.pk)
    assert removal.tick()["complete"] == 0
    assert not models.VoiceprintSourceRemoval.objects.exists()
    assert consent.ready_device_groups(profile) == ["headset"]
    assert decrypt_template(anchor)


def test_confirmed_survivors_rebuild_after_new_enrollment_and_accumulation_stop(
    prepared,
):
    fixture, profile, samples, _ = call_baseline(prepared, count=4)
    consent.update_settings(
        fixture.user,
        organization_id=None,
        expected_version=2,
        changes={"allow_enrollment": False, "allow_accumulation": False},
    )
    removal.enroll(models.VoiceprintSample.objects.filter(pk=samples[0].pk))
    assert removal.tick()["complete"] == 1
    assert consent.ready_device_groups(profile) == ["headset"]


def test_failure_is_sanitized_and_retry_does_not_starve_new_work(prepared, monkeypatch):
    fixture, profile, samples, _ = call_baseline(prepared, count=4)
    removal.enroll(models.VoiceprintSample.objects.filter(pk=samples[0].pk))
    job = models.VoiceprintContributionRemoval.objects.get(sample_uuid=samples[0].pk)
    real_process = removal.process_one

    def fail(identifier):
        raise RuntimeError("private source and broker details")

    monkeypatch.setattr(removal, "process_one", fail)
    assert removal.tick(limit=1)["failed"] == 1
    job.refresh_from_db()
    assert job.error_code == "source_cleanup_unavailable" and job.attempts == 1
    assert job.next_attempt_at > timezone.now()
    monkeypatch.setattr(removal, "process_one", real_process)
    newer = capture(connection(fixture, group="computer"), 900)
    removal.enroll(models.VoiceprintSample.objects.filter(pk=newer.pk))
    assert removal.tick(limit=1)["complete"] == 1
    assert models.VoiceprintSample.objects.filter(pk=samples[0].pk).exists()
    job.next_attempt_at = timezone.now()
    job.save(update_fields=["next_attempt_at"])
    assert removal.tick(limit=1)["complete"] == 1
    assert consent.ready_device_groups(profile) == ["headset"]


def test_old_generation_cleanup_cannot_pause_or_rewrite_new_generation(prepared):
    _, profile, samples, _ = call_baseline(prepared)
    old_generation = profile.generation
    removal.enroll(models.VoiceprintSample.objects.filter(pk=samples[0].pk))
    # Simulate a later profile generation while an old cleanup intent is delayed.
    models.VoiceprintProfile.objects.filter(pk=profile.pk).update(
        generation=old_generation + 1,
        status="active",
        template_checked_at=timezone.now(),
    )
    profile.refresh_from_db()
    checked_at = profile.template_checked_at
    assert removal.tick()["complete"] == 1
    profile.refresh_from_db()
    assert profile.generation == old_generation + 1 and profile.status == "active"
    assert profile.template_checked_at == checked_at


def test_owner_cascade_leaves_fk_independent_cleanup_intents(prepared):
    fixture, profile, samples, _ = call_baseline(prepared)
    owner_id, profile_id, sample_id = fixture.user.pk, profile.pk, samples[0].pk
    fixture.user.delete()
    assert not models.VoiceprintProfile.objects.filter(pk=profile_id).exists()
    job = models.VoiceprintContributionRemoval.objects.get(sample_uuid=sample_id)
    assert job.owner_uuid == owner_id and job.profile_uuid == profile_id
    assert removal.tick()["complete"] == 3
    assert not models.VoiceprintSample.objects.filter(pk=sample_id).exists()


def test_deleting_unconfirmed_call_sample_scrubs_receipt_after_fk_is_lost(prepared):
    fixture, _ = prepared
    sample = capture(fixture, 100, confirm=False)
    permit_id, identifier = sample.sampling_permit.pk, sample.pk
    assert not sample.templates.exists()
    sample.delete()
    assert models.VoiceprintContributionRemoval.objects.filter(
        sample_uuid=identifier
    ).exists()
    assert removal.tick()["complete"] == 1
    permit = models.VoiceprintSamplingPermit.objects.get(pk=permit_id)
    assert permit.profile_id is permit.track_id is permit.sample_id is None
    assert not permit.participant_identity and not permit.source_track_sid
    assert permit.owner == fixture.user and permit.max_duration_ms == 10000


def test_source_deletion_with_only_unused_permit_scrubs_context_and_keeps_quota(
    prepared,
):
    fixture, _ = prepared
    grant = fixture.issue()
    fixture.track.delete()
    assert removal.tick()["complete"] == 0
    permit = models.VoiceprintSamplingPermit.objects.get(pk=grant["id"])
    assert permit.status == "canceled"
    assert permit.profile_id is permit.track_id is permit.sample_id is None
    assert not permit.participant_identity and not permit.livekit_room_sid
    assert permit.owner == fixture.user and permit.max_duration_ms == 10000


def test_periodic_recovery_task_is_discoverable_and_drains_durable_intents(
    prepared, settings
):
    fixture, _, _, _ = call_baseline(prepared)
    fixture.track.delete()
    schedule = settings.CELERY_BEAT_SCHEDULE["purge-voiceprint-sources"]
    module, name = schedule["task"].rsplit(".", 1)
    task = getattr(import_module(module), name)
    assert schedule["options"]["queue"] == "voiceprint"
    assert schedule["schedule"] <= schedule["options"]["expires"]
    assert task()["complete"] == 3


@pytest.mark.parametrize("limit", [0, 101])
def test_command_rejects_unbounded_work(limit):
    with pytest.raises(CommandError):
        call_command("purge_voiceprint_sources", limit=limit, stdout=io.StringIO())


@pytest.mark.django_db(transaction=True)
def test_publish_waiting_for_source_deletion_cannot_recreate_removed_track(
    prepared, monkeypatch
):
    fixture, _ = prepared
    sid = fixture.track.livekit_track_sid
    locking = Event()
    manager = models.MeetingSession.objects
    real_lock = manager.select_for_update

    def notify_lock(*args, **kwargs):
        locking.set()
        return real_lock(*args, **kwargs)

    def publish():
        close_old_connections()
        try:
            sampling.record_track(
                participation=fixture.participant,
                track=api.TrackInfo(
                    sid=sid, source=api.TrackSource.MICROPHONE, type=api.TrackType.AUDIO
                ),
                published=True,
                event_at=timezone.now(),
            )
        except consent.VoiceprintError as error:
            return str(error)
        finally:
            close_old_connections()
        return "published"

    with ThreadPoolExecutor(max_workers=1) as executor:
        with transaction.atomic():
            real_lock().get(pk=fixture.session.pk)
            fixture.track.delete()
            monkeypatch.setattr(manager, "select_for_update", notify_lock)
            future = executor.submit(publish)
            assert locking.wait(timeout=10)
        assert future.result(timeout=10) == "voiceprint_sampling_track_removed"
    assert not models.VoiceprintSamplingTrack.objects.filter(
        livekit_track_sid=sid
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_busy_owner_defers_without_blocking_then_resumes(prepared):
    fixture, _, samples, _ = call_baseline(prepared)
    identifier = samples[0].pk
    removal.enroll(models.VoiceprintSample.objects.filter(pk=identifier))
    job = models.VoiceprintContributionRemoval.objects.get(sample_uuid=identifier)

    def attempt():
        close_old_connections()
        try:
            return removal.tick()
        finally:
            close_old_connections()

    with transaction.atomic():
        models.User.objects.select_for_update().get(pk=fixture.user.pk)
        with ThreadPoolExecutor(max_workers=1) as executor:
            assert executor.submit(attempt).result(timeout=10)["busy"] == 1
    assert models.VoiceprintSample.objects.filter(pk=identifier).exists()
    job.refresh_from_db()
    job.next_attempt_at = timezone.now()
    job.save(update_fields=["next_attempt_at"])
    assert removal.tick()["complete"] == 1
