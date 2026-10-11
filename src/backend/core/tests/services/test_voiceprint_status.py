"""Actual API read projections; synthetic encrypted contributions, no voices."""

from datetime import timedelta
from unittest.mock import patch

from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import voiceprint_consent as consent
from core.services.voiceprint_status import STATES
from core.tests.services.test_voiceprint_consent import (
    activate,
    delete,
    enabled,
    org_for,
    profile_for,
    sample_for,
    settings_for,
)

pytestmark = pytest.mark.django_db


def projected(profile):
    response = settings_for(profile.consent.user, profile.consent.organization)
    assert response.status_code == 200
    return response.data, next(
        row for row in response.data["profiles"] if row["id"] == str(profile.pk)
    )


def test_no_permissions_or_registration_is_not_enabled(enabled):
    user = UserFactory()
    before = models.VoiceprintConsent.objects.count()
    assert settings_for(user).data["display_state"] == "not_enabled"
    assert models.VoiceprintConsent.objects.count() == before
    profile = profile_for(user)
    settings, row = projected(profile)
    assert settings["display_state"] == row["display_state"] == "not_enabled"
    assert row["effective_device_groups"] == row["update_reasons"] == []


def test_current_candidates_collect_until_quality_is_ready_for_owner_review(enabled):
    profile = profile_for(UserFactory())
    candidate = sample_for(profile, ready=True)
    candidate.status = "pending"
    candidate.quality["speech_checked"] = False
    candidate.save()
    settings, row = projected(profile)
    assert row["display_state"] == settings["display_state"] == "collecting"
    candidate.delete()
    candidate = sample_for(profile, ready=True)
    candidate.owner_decision.delete()
    candidate.status = "ready"
    candidate.confirmed_at = None
    candidate.save()
    assert projected(profile)[1]["display_state"] == "awaiting_confirmation"
    candidate.quality["speech_checked"] = False
    candidate.save()
    assert projected(profile)[1]["display_state"] == "collecting"
    candidate.expires_at = timezone.now() - timedelta(seconds=1)
    candidate.save()
    assert projected(profile)[1]["display_state"] == "not_enabled"


def test_an_unbound_enrollment_candidate_does_not_claim_sampling_has_started(enabled):
    profile = profile_for(UserFactory())
    sample_for(profile)
    assert projected(profile)[1]["display_state"] == "not_enabled"


def test_only_current_authorized_enrollments_count_as_collection(enabled):
    profile = profile_for(UserFactory())
    candidate = sample_for(profile, ready=True)
    registration = candidate.enrollment
    candidate.delete()
    registration.status = "open"
    registration.save()
    assert projected(profile)[1]["display_state"] == "collecting"
    registration.consent_version += 1
    registration.save()
    assert projected(profile)[1]["display_state"] == "not_enabled"


def test_established_groups_use_the_same_authenticated_gate_as_identification(enabled):
    profile = profile_for(UserFactory(), identify=True)
    activate(profile)
    with CaptureQueriesContext(connection) as queries:
        settings, row = projected(profile)
    assert settings["display_state"] == row["display_state"] == "established"
    assert row["effective_device_groups"] == ["default"]
    assert row["update_reasons"] == []
    assert consent.authorize_profile(profile.pk, permission="allow_identification")
    assert not any(
        query["sql"].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
        for query in queries
    )
    assert set(row) == {
        "id",
        "status",
        "generation",
        "confirmed_at",
        "last_updated_at",
        "display_state",
        "update_reasons",
        "effective_device_groups",
    }


@pytest.mark.parametrize(
    "damage,reason",
    [
        ("old", "expired"),
        ("space", "model_changed"),
        ("contribution", "contributions_changed"),
        ("key", "storage_unavailable"),
        ("template", "contributions_changed"),
    ],
)
def test_established_metadata_never_masks_an_unusable_template(enabled, damage, reason):
    profile = profile_for(UserFactory(), identify=True)
    template = activate(profile)
    if damage == "old":
        profile.last_updated_at = timezone.now() - timedelta(days=365)
        profile.save()
    elif damage == "space":
        profile.feature_space = "other-model"
        profile.save()
    elif damage == "contribution":
        template.support_samples.first().delete()
    elif damage == "key":
        profile.encrypted_key = b""
        profile.save()
    else:
        template.encrypted_vector = b"tampered"
        template.save()
    settings, row = projected(profile)
    assert settings["display_state"] == row["display_state"] == "needs_update"
    assert row["effective_device_groups"] == [] and row["update_reasons"] == [reason]
    with pytest.raises(consent.VoiceprintError):
        consent.authorize_profile(profile.pk, permission="allow_identification")


def test_paused_scope_hides_effective_groups_without_modifying_a_baseline(enabled):
    user = UserFactory()
    organization, _ = org_for(user)
    profile = profile_for(user, organization, identify=True)
    template = activate(profile)
    organization.settings["voiceprint"]["enabled"] = False
    organization.save()
    settings, row = projected(profile)
    assert not settings["available"] and row["display_state"] == "paused"
    assert row["effective_device_groups"] == row["update_reasons"] == []
    template.refresh_from_db()
    assert template.status == "active"


@pytest.mark.parametrize(
    "status,state",
    [
        ("queued", "deleting"),
        ("running", "deleting"),
        ("failed", "deleting"),
        ("succeeded", "deleted"),
    ],
)
def test_cleanup_receipt_controls_deleted_display_but_never_restores_use(
    enabled, status, state
):
    profile = profile_for(UserFactory(), identify=True)
    activate(profile)
    receipt = delete(profile.consent.user, profile)
    assert receipt.status_code == 202
    models.VoiceprintDeletionJob.objects.filter(pk=receipt.data["id"]).update(
        status=status
    )
    settings, row = projected(profile)
    assert settings["display_state"] == row["display_state"] == state
    assert row["effective_device_groups"] == []
    assert not settings["allow_identification"]


def test_old_cleanup_does_not_shadow_a_reregistered_current_generation(enabled):
    profile = profile_for(UserFactory())
    delete(profile.consent.user, profile)
    profile.consent.refresh_from_db()
    consent.update_settings(
        profile.consent.user,
        organization_id=None,
        expected_version=profile.consent.version,
        changes={"allow_enrollment": True},
    )
    profile.consent.refresh_from_db()
    fresh = consent.ensure_profile(
        profile.consent.user,
        organization_id=None,
        expected_version=profile.consent.version,
    )
    settings, row = projected(fresh)
    assert settings["display_state"] == row["display_state"] == "not_enabled"
    assert row["generation"] == settings["generation"]


def test_profiles_below_external_revocation_floor_never_display_established(enabled):
    profile = profile_for(UserFactory(), identify=True)
    activate(profile)
    with patch.object(consent, "revocation_floor", return_value=profile.generation + 1):
        settings, row = projected(profile)
    assert settings["display_state"] == row["display_state"] == "deleting"
    assert row["effective_device_groups"] == []


def test_projection_does_not_load_candidate_audio_or_embedding_blobs(enabled):
    profile = profile_for(UserFactory())
    sample = sample_for(profile, ready=True)
    sample.status = "ready"
    sample.save()
    with CaptureQueriesContext(connection) as queries:
        assert projected(profile)[1]["display_state"] == "awaiting_confirmation"
    selects = [
        row["sql"] for row in queries if 'FROM "core_voiceprintsample"' in row["sql"]
    ]
    assert selects
    assert all(
        '"core_voiceprintsample"."encrypted_audio",' not in sql
        and '"core_voiceprintsample"."encrypted_embedding",' not in sql
        for sql in selects
    )


def test_other_owners_and_scopes_cannot_influence_the_display(enabled):
    owner = UserFactory()
    other = profile_for(UserFactory(), identify=True)
    activate(other)
    profile = profile_for(owner)
    assert projected(profile)[0]["display_state"] == "not_enabled"
    assert STATES == (
        "not_enabled",
        "collecting",
        "awaiting_confirmation",
        "established",
        "needs_update",
        "paused",
        "deleting",
        "deleted",
    )


def test_old_organization_policy_does_not_show_an_admissible_sample_or_registration(
    enabled,
):
    user = UserFactory()
    organization, _ = org_for(user)
    profile = profile_for(user, organization)
    sample = sample_for(profile, ready=True)
    sample.status = "ready"
    sample.save()
    sample.enrollment.status = "open"
    sample.enrollment.save()
    organization.settings["voiceprint"]["version"] += 1
    organization.save()
    assert projected(profile)[1]["display_state"] == "not_enabled"


def test_missing_rotated_key_is_reported_without_leaking_private_errors(
    enabled, settings
):
    profile = profile_for(UserFactory(), identify=True)
    activate(profile)
    settings.MEETING_VOICEPRINT_KEYRING_FILE = "missing-local-test-keyring"
    value, row = projected(profile)
    assert value["display_state"] == "needs_update"
    assert (
        row["update_reasons"] == ["storage_unavailable"]
        and row["effective_device_groups"] == []
    )
