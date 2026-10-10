"""Current trusted scope tombstones erase restored rows without deleting renewals."""

import io
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4

from django.core.management import call_command
from django.db import close_old_connections, transaction
from django.utils import timezone

import pytest
from billiard.exceptions import SoftTimeLimitExceeded

from core import models
from core.factories import UserFactory
from core.services import voiceprint_consent as consent
from core.services import voiceprint_erasure as service
from core.tasks.voiceprint_erasure import purge_voiceprints
from core.tests.services.test_voiceprint_consent import (
    activate,
    delete,
    enabled,  # Reuse the real keyring/feature fixture.
    org_for,
    profile_for,
    sample_for,
)

pytestmark = pytest.mark.django_db


def retired(organization=False):
    user = UserFactory()
    scope = org_for(user)[0] if organization else None
    profile = profile_for(user, scope)
    sample = sample_for(profile)
    template = models.VoiceprintTemplate.objects.create(
        profile=profile,
        generation=1,
        dimension=1024,
        encrypted_vector=b"synthetic-old-template",
        status="active",
    )
    template.support_samples.add(sample)
    old_key = bytes(profile.encrypted_key)
    response = delete(user, profile)
    assert response.status_code == 202
    job = consent.purge_deleted(response.data["id"])
    assert job.status == "succeeded"
    return user, scope, profile, sample, template, old_key, job


@pytest.mark.parametrize("organization", [False, True])
def test_completed_receipt_repurges_restored_audio_vector_and_key(organization):
    user, scope, profile, sample, template, key, job = retired(organization)
    sample.save(force_insert=True)
    template.save(force_insert=True)
    template.support_samples.add(sample)
    models.VoiceprintProfile.objects.filter(pk=profile.pk).update(
        status="active", encrypted_key=key
    )
    with pytest.raises(consent.VoiceprintError, match="authorization_revoked"):
        consent.authorize_profile(profile.pk, permission="allow_enrollment")
    result = consent.purge_deleted(job.pk)
    assert result.status == "succeeded" and result.attempts == 2
    assert result.receipt["samples"] == 1 and result.receipt["templates"] == 1
    assert not models.VoiceprintSample.objects.filter(pk=sample.pk).exists()
    assert not models.VoiceprintTemplate.objects.filter(pk=template.pk).exists()
    profile.refresh_from_db()
    assert profile.status == "deleted" and not profile.encrypted_key
    assert consent.purge_deleted(job.pk).attempts == 2
    assert models.VoiceprintDeletionJob.objects.get(pk=job.pk).revoked_generation == 2
    assert user.pk == profile.consent.user_id
    assert (scope.pk if scope else None) == profile.consent.organization_id


@pytest.mark.parametrize("organization", [False, True])
def test_periodic_reconciliation_preserves_renewed_generation_and_other_scopes(
    organization, settings
):
    user, scope, profile, sample, template, _key, job = retired(organization)
    consent.update_settings(
        user,
        organization_id=scope.pk if scope else None,
        expected_version=2,
        changes={"allow_enrollment": True, "allow_identification": True},
    )
    renewed = consent.ensure_profile(
        user, organization_id=scope.pk if scope else None, expected_version=3
    )
    fresh_key = bytes(renewed.encrypted_key)
    fresh_template = activate(renewed)
    fresh_samples = list(fresh_template.support_samples.all())
    fresh_vector = bytes(fresh_template.encrypted_vector)
    other_scope = None if scope else org_for(user)[0]
    other_profile = profile_for(user, other_scope)
    other_sample = sample_for(other_profile)
    other_user = profile_for(UserFactory())
    other_user_sample = sample_for(other_user)
    sample.save(force_insert=True)
    template.save(force_insert=True)
    keyring_path = settings.MEETING_VOICEPRINT_KEYRING_FILE
    settings.MEETING_VOICEPRINT_ENABLED = False
    settings.MEETING_VOICEPRINT_KEYRING_FILE = "/unavailable-private-keyring"
    assert purge_voiceprints() == {
        "succeeded": 1,
        "failed": 0,
        "busy": 0,
        "missing": 0,
    }
    assert not models.VoiceprintSample.objects.filter(pk=sample.pk).exists()
    assert not models.VoiceprintTemplate.objects.filter(pk=template.pk).exists()
    renewed.refresh_from_db()
    assert renewed.generation == 2 and bytes(renewed.encrypted_key) == fresh_key
    assert renewed.status == "active"
    assert (
        models.VoiceprintSample.objects.filter(
            pk__in=[row.pk for row in fresh_samples]
            + [other_sample.pk, other_user_sample.pk]
        ).count()
        == 5
    )
    fresh_template.refresh_from_db()
    assert bytes(fresh_template.encrypted_vector) == fresh_vector
    settings.MEETING_VOICEPRINT_ENABLED = True
    settings.MEETING_VOICEPRINT_KEYRING_FILE = keyring_path
    assert (
        consent.authorize_profile(renewed.pk, permission="allow_identification").pk
        == renewed.pk
    )
    job.refresh_from_db()
    assert job.status == "succeeded" and job.attempts == 1
    assert service.pending_ids(20) == []


@pytest.mark.parametrize("damage", ["key", "profile_status", "consent"])
def test_metadata_only_restore_is_detected_and_denied_permissions_stay_denied(damage):
    user, _scope, profile, _sample, _template, key, job = retired()
    if damage == "key":
        models.VoiceprintProfile.objects.filter(pk=profile.pk).update(encrypted_key=key)
    elif damage == "profile_status":
        models.VoiceprintProfile.objects.filter(pk=profile.pk).update(status="pending")
    else:
        models.VoiceprintConsent.objects.filter(pk=profile.consent_id).update(
            generation=1,
            version=1,
            allow_enrollment=True,
            allow_accumulation=True,
            allow_identification=True,
        )
    assert list(service.restored_jobs().values_list("pk", flat=True)) == [job.pk]
    assert service.tick()["succeeded"] == 1
    profile.refresh_from_db()
    profile.consent.refresh_from_db()
    assert profile.status == "deleted" and not profile.encrypted_key
    assert profile.consent.generation == 2 and profile.consent.version >= 2
    assert not any(getattr(profile.consent, name) for name in consent.PERMISSIONS)
    if damage == "consent":
        with pytest.raises(consent.VoiceprintError, match="settings_changed"):
            consent.update_settings(
                user,
                organization_id=None,
                expected_version=1,
                changes={"allow_enrollment": True},
            )
        # Restoring the floor allows a fresh explicit enrollment, never old data.
        consent.update_settings(
            user,
            organization_id=None,
            expected_version=profile.consent.version,
            changes={"allow_enrollment": True},
        )
        renewed = consent.ensure_profile(
            user, organization_id=None, expected_version=profile.consent.version + 1
        )
        assert renewed.generation == 2 and bytes(renewed.encrypted_key) != key
        assert not models.VoiceprintSample.objects.filter(profile=renewed).exists()


@pytest.mark.parametrize("organization", [False, True])
def test_restored_permit_and_upload_scope_are_closed_without_refunding_quota(
    organization,
):
    user, scope, profile, _sample, _template, _key, job = retired(organization)
    # A restored receipt may legitimately have lost its nullable track FK.
    permit = models.VoiceprintSamplingPermit(
        owner=user,
        profile=profile,
        source_session_id=uuid4(),
        source_track_sid="TR_synthetic",
        livekit_room_sid="RM_synthetic",
        participant_sid="PA_synthetic",
        participant_identity="synthetic-private-identity",
        request_key=uuid4(),
        consent_version=1,
        generation=1,
        policy_version=1,
        control_revision=1,
        device_group="headset",
        max_duration_ms=10000,
        expires_at=timezone.now() + timezone.timedelta(minutes=1),
    )
    models.VoiceprintSamplingPermit.objects.bulk_create([permit])
    enrollment = models.VoiceprintEnrollment.objects.create(
        owner_id=user.pk,
        organization_id=scope.pk if scope else None,
        profile=profile,
        request_key=uuid4(),
        consent_version=1,
        generation=1,
        challenges=["synthetic prompt"],
        expires_at=timezone.now() + timezone.timedelta(minutes=1),
        status="closed",
    )
    quota = (
        permit.owner_id,
        permit.source_session_id,
        permit.max_duration_ms,
        permit.created_at,
    )
    assert service.tick()["succeeded"] == 1
    permit.refresh_from_db()
    enrollment.refresh_from_db()
    assert permit.status == "canceled" and permit.profile_id is None
    assert permit.track_id is None and permit.sample_id is None
    assert not any(
        getattr(permit, field)
        for field in (
            "source_track_sid",
            "livekit_room_sid",
            "participant_sid",
            "participant_identity",
            "device_group",
        )
    )
    assert (
        permit.owner_id,
        permit.source_session_id,
        permit.max_duration_ms,
        permit.created_at,
    ) == quota
    assert enrollment.status == "canceled"
    assert service.pending_ids(20) == []
    job.refresh_from_db()
    assert "synthetic-private" not in json.dumps(job.receipt)


def test_cli_rechecks_successful_receipt_and_remains_idempotent():
    _user, _scope, _profile, sample, _template, _key, job = retired()
    sample.save(force_insert=True)
    for expected in (1, 0):
        output = io.StringIO()
        call_command("purge_voiceprints", limit=1, stdout=output)
        assert json.loads(output.getvalue()) == {"failed": 0, "succeeded": expected}
    job.refresh_from_db()
    assert job.attempts == 1
    assert not models.VoiceprintSample.objects.filter(pk=sample.pk).exists()


def test_periodic_cleanup_has_bounded_sanitized_retries(monkeypatch, caplog):
    user = UserFactory()
    profile = profile_for(user)
    response = delete(user, profile)

    def fail(_identifier):
        raise RuntimeError("private voice or vector must not be logged")

    monkeypatch.setattr(service, "purge_deleted", fail)
    for _ in range(3):
        assert service.tick() == {"succeeded": 0, "failed": 1, "busy": 0, "missing": 0}
    assert service.tick() == {"succeeded": 0, "failed": 0, "busy": 0, "missing": 0}
    job = models.VoiceprintDeletionJob.objects.get(pk=response.data["id"])
    assert job.attempts == 3 and job.error_code == "cleanup_unavailable"
    assert "private" not in json.dumps(consent.deletion_snapshot(job))
    assert "voiceprint_erasure_failed count=1" in caplog.text
    assert "private voice" not in caplog.text and str(profile.pk) not in caplog.text
    assert str(user.pk) not in caplog.text


def test_soft_timeout_stops_batch_without_exhausting_cleanup_retries(monkeypatch):
    _user, _scope, _profile, sample, _template, _key, job = retired()
    sample.save(force_insert=True)
    original = service.process_one

    def timeout(_identifier):
        raise SoftTimeLimitExceeded()

    monkeypatch.setattr(service, "process_one", timeout)
    with pytest.raises(SoftTimeLimitExceeded):
        service.tick()
    job.refresh_from_db()
    assert job.status == "queued" and job.attempts == 0
    assert models.VoiceprintSample.objects.filter(pk=sample.pk).exists()
    monkeypatch.setattr(service, "process_one", original)
    assert service.tick()["succeeded"] == 1


@pytest.mark.parametrize("limit", [0, 1001, True, "20"])
def test_invalid_erasure_bound_never_selects_data(limit, django_assert_num_queries):
    with django_assert_num_queries(0), pytest.raises(ValueError, match="limit_invalid"):
        service.tick(limit)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("locked", ["user", "organization", "consent", "job"])
def test_busy_scope_defers_without_retry_or_lock_inversion(locked):
    user, scope, profile, sample, _template, _key, job = retired(True)
    sample.save(force_insert=True)
    # Queue reconciliation before acquiring a competing lock.
    assert service.pending_ids(20) == [job.pk]
    models_and_keys = {
        "user": (models.User, user.pk),
        "organization": (models.Organization, scope.pk),
        "consent": (models.VoiceprintConsent, profile.consent_id),
        "job": (models.VoiceprintDeletionJob, job.pk),
    }
    held, release = Event(), Event()

    def hold():
        close_old_connections()
        try:
            with transaction.atomic():
                model, key = models_and_keys[locked]
                model.objects.select_for_update().get(pk=key)
                held.set()
                assert release.wait(10)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(hold)
        try:
            assert held.wait(5)
            assert service.tick() == {
                "succeeded": 0,
                "failed": 0,
                "busy": 1,
                "missing": 0,
            }
        finally:
            release.set()
        future.result(timeout=10)
    job.refresh_from_db()
    assert job.attempts == 0 and job.status == "queued"
    assert models.VoiceprintSample.objects.filter(pk=sample.pk).exists()
    assert service.tick()["succeeded"] == 1


def test_bound_is_per_batch_and_completed_receipts_are_not_requeued_forever():
    jobs = [retired() for _ in range(3)]
    for _user, _scope, _profile, sample, _template, _key, _job in jobs:
        sample.save(force_insert=True)
    for _ in jobs:
        assert service.tick(limit=1)["succeeded"] == 1
    assert service.tick(limit=1)["succeeded"] == 0
    assert not models.VoiceprintSample.objects.exists()
