"""Real PostgreSQL aggregate semantics and admin/privacy boundaries."""

import json
from datetime import timedelta
from uuid import uuid4

from django.db import DatabaseError, connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services import voiceprint_operations as service
from core.services.membership import left_transition
from core.services.voiceprint_consent import VoiceprintError
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_voiceprint_consent import (
    enabled,
    org_for,
    profile_for,
    sample_for,
)
from core.tests.test_services_voiceprint_sources import published

pytestmark = pytest.mark.django_db


def url(organization):
    return f"/api/v1.0/voiceprint/organizations/{organization.pk}/operations/"


@pytest.fixture
def admin():
    user = UserFactory()
    organization, membership = org_for(user, role=models.OrgRoleChoices.ADMIN)
    return user, organization, membership


def test_empty_operational_state_remains_readable_when_collection_disabled(
    admin, settings
):
    user, organization, _ = admin
    settings.MEETING_VOICEPRINT_ENABLED = False
    response = client_for(user).get(url(organization))
    assert response.status_code == 200
    assert response["Cache-Control"] == "private, no-store"
    assert response.data["available"] is False
    for queue in response.data["queues"].values():
        assert queue["states"]["queued"] == 0
        assert queue["request_to_finish_p95_seconds"] is None
        assert queue["oldest_pending_seconds"] is None
    assert not models.VoiceprintConsent.objects.exists()


@pytest.mark.parametrize(
    "role", [models.OrgRoleChoices.OWNER, models.OrgRoleChoices.ADMIN]
)
def test_only_active_org_admin_or_owner_allowed(role):
    user = UserFactory()
    organization, _ = org_for(user, role=role)
    assert client_for(user).get(url(organization)).status_code == 200


@pytest.mark.parametrize(
    "denial",
    ["member", "other_org", "departed", "inactive_org", "inactive_user", "device"],
)
def test_admin_boundary(denial, admin):
    user, organization, membership = admin
    if denial == "member":
        membership.org_role = models.OrgRoleChoices.MEMBER
        membership.save(update_fields=["org_role"])
    elif denial == "other_org":
        organization = OrganizationFactory()
    elif denial == "departed":
        membership.status = models.MembershipStatusChoices.LEFT
        with left_transition():
            membership.save(update_fields=["status"])
    elif denial == "inactive_org":
        organization.is_active = False
        organization.save(update_fields=["is_active"])
    else:
        if denial == "inactive_user":
            user.is_active = False
        else:
            user.is_device = True
        user.save(update_fields=["is_active", "is_device"])
    assert client_for(user).get(url(organization)).status_code in (401, 403)


def test_anonymous_owner_header_and_query_bounds(admin):
    user, organization, _ = admin
    assert APIClient().get(url(organization)).status_code in (401, 403)
    assert (
        client_for(user)
        .get(url(organization), HTTP_X_VOICEPRINT_OWNER=str(uuid4()))
        .status_code
        == 401
    )
    for query in (
        {"hours": 0},
        {"hours": 169},
        {"hours": "nan"},
        {"user_id": str(user.pk)},
    ):
        assert client_for(user).get(url(organization), query).status_code == 400


def test_queue_age_lease_and_postgres_percentile(admin, monkeypatch):
    user, organization, _ = admin
    profile = profile_for(user, organization)
    now = timezone.now()
    monkeypatch.setattr(service.timezone, "now", lambda: now)
    for duration in (10, 20, 100):
        sample = sample_for(profile)
        job = models.VoiceprintEncodingJob.objects.create(
            sample=sample,
            status="succeeded",
            expires_at=now + timedelta(hours=1),
            finished_at=now - timedelta(seconds=10),
        )
        models.VoiceprintEncodingJob.objects.filter(pk=job.pk).update(
            created_at=job.finished_at - timedelta(seconds=duration)
        )
    sample = sample_for(profile)
    pending = models.VoiceprintEncodingJob.objects.create(
        sample=sample,
        status="running",
        lease_until=now - timedelta(seconds=1),
        expires_at=now + timedelta(hours=1),
    )
    models.VoiceprintEncodingJob.objects.filter(pk=pending.pk).update(
        created_at=now - timedelta(seconds=200)
    )
    result = service.report(user, organization_id=organization.pk)["queues"]["encoding"]
    assert result["states"]["succeeded"] == 3 and result["states"]["running"] == 1
    assert result["completed_in_window"] == 3
    assert result["request_to_finish_p95_seconds"] == pytest.approx(92)
    assert result["oldest_pending_seconds"] == 200
    assert result["expired_running_leases"] == 1


def test_sample_volume_handles_corrupt_json_and_keeps_scope_boundary(admin):
    user, organization, _ = admin
    profile = profile_for(user, organization)
    for value in (5000, "9000", 9000.5, None, True, 100000, {"private": "text"}):
        sample = sample_for(profile)
        sample.quality = {
            "valid_speech_ms": value,
            "speech_checked": True,
            "speaker_consistency_checked": True,
            "speaker_count": 1,
        }
        sample.save(update_fields=["quality"])
    personal = profile_for(user)
    sample_for(personal)
    other_user = UserFactory()
    other_org, _ = org_for(other_user)
    sample_for(profile_for(other_user, other_org))
    with CaptureQueriesContext(connection) as queries:
        result = service.report(user, organization_id=organization.pk)
    assert result["samples"]["pending"] == 7
    assert result["samples_in_window"]["submitted_audio_ms"] == 70000
    assert result["samples_in_window"]["declared_quality_speech_ms"] == 5000
    sql = "\n".join(query["sql"] for query in queries)
    for field in (
        "encrypted_audio",
        "encrypted_embedding",
        "encrypted_key",
        "encrypted_vector",
    ):
        assert field not in sql
    output = json.dumps(result)
    assert str(user.pk) not in output and str(profile.pk) not in output
    assert "private" not in output


def test_cleanup_backlog_survives_missing_profile_and_old_history_excluded(admin):
    user, organization, _ = admin
    now = timezone.now()
    job = models.VoiceprintDeletionJob.objects.create(
        owner_id=user.pk,
        organization_id=organization.pk,
        request_key=uuid4(),
        expected_version=1,
        revoked_generation=2,
        status="failed",
        error_code="private-name-that-must-not-be-displayed",
        finished_at=now - timedelta(days=2),
    )
    models.VoiceprintDeletionJob.objects.filter(pk=job.pk).update(
        created_at=now - timedelta(days=3)
    )
    models.VoiceprintContributionRemoval.objects.create(
        sample_uuid=uuid4(),
        profile_uuid=uuid4(),
        owner_uuid=user.pk,
        organization_uuid=organization.pk,
        generation=1,
        status="purged",
        templates={str(uuid4()): {"revision": 1, "digest": "a" * 64}},
    )
    result = service.report(user, organization_id=organization.pk)
    assert result["queues"]["deletion"]["states"]["failed"] == 1
    assert result["queues"]["deletion"]["completed_in_window"] == 0
    assert result["contribution_cleanup"]["purged"] == 1
    assert "private-name" not in json.dumps(result)


def test_suggestions_use_job_scope_without_serializing_identity(admin, published):
    user, organization, _ = admin
    actor, record, _, speaker = published
    job = models.SpeakerIdentityJob.objects.create(
        record=record,
        speaker=speaker,
        requester=actor,
        organization=organization,
        requested_users=[str(actor.pk)],
        request_key=uuid4(),
        record_revision=1,
        expires_at=timezone.now() + timedelta(hours=1),
        intent_digest="a" * 64,
        source_digest="b" * 64,
        candidate_digest="c" * 64,
        threshold_digest="d" * 64,
        threshold_version="synthetic",
        feature_space="synthetic",
    )
    suggestion = models.SpeakerIdentitySuggestion.objects.create(
        job=job,
        candidate=actor,
        result="suggested",
        reason="consistent_identity",
        state="rejected",
        decided_at=timezone.now(),
        score=0.999,
        margin=0.8,
    )
    models.SpeakerIdentitySuggestion.objects.filter(pk=suggestion.pk).update(
        created_at=timezone.now() - timedelta(days=2)
    )
    result = service.report(user, organization_id=organization.pk)
    assert result["suggestions_in_window"]["results"]["suggested"] == 0
    assert result["suggestions_in_window"]["human_rejected_suggestions"] == 1
    assert str(actor.pk) not in json.dumps(result)
    assert "0.999" not in json.dumps(result)


def test_departure_during_aggregation_discards_response(admin, monkeypatch):
    user, organization, membership = admin
    actual = service.sample_summary

    def revoke(rows):
        result = actual(rows)
        membership.org_role = models.OrgRoleChoices.MEMBER
        membership.save(update_fields=["org_role"])
        return result

    monkeypatch.setattr(service, "sample_summary", revoke)
    with pytest.raises(VoiceprintError, match="admin_required"):
        service.report(user, organization_id=organization.pk)


def test_database_failure_is_sanitized(admin, monkeypatch):
    user, organization, _ = admin

    def fail(*args, **kwargs):
        raise DatabaseError("private-dsn-and-name")

    monkeypatch.setattr(service, "report", fail)
    response = client_for(user).get(url(organization))
    assert response.status_code == 503
    assert response.data == {"code": "voiceprint_operations_unavailable"}
