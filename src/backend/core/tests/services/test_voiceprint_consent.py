"""Real DB/API authorization, encryption, revocation and cleanup regression."""

import base64
import io
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

from django.core.management import call_command
from django.db import IntegrityError, close_old_connections, transaction
from django.db.models import QuerySet
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services import voiceprint_consent as service
from core.services.voiceprint_crypto import VoiceprintCryptoError, load_keyring
from core.services.voiceprint_prompt import challenge_digest
from core.services.voiceprint_quality import MODEL_ID as QUALITY_MODEL_ID
from core.services.voiceprint_quality import POLICY_VERSION as QUALITY_POLICY
from core.services.voiceprint_retention import expire_sample
from core.services.voiceprint_templates import (
    POLICY_VERSION,
    supports_digest,
    template_payload,
)
from core.services.voiceprint_vectors import sample_payload
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/voiceprint/settings/"


@pytest.fixture(autouse=True)
def enabled(settings, tmp_path):
    settings.MEETING_VOICEPRINT_ENABLED = True
    path = tmp_path / "fixture-keyring.json"
    path.write_text(
        json.dumps(
            {
                "active": "fixture",
                "keys": {"fixture": base64.b64encode(os.urandom(32)).decode()},
            }
        )
    )
    settings.MEETING_VOICEPRINT_KEYRING_FILE = str(path)


def org_for(user, *, role=models.OrgRoleChoices.MEMBER, enabled=True):
    organization = OrganizationFactory(
        settings={"voiceprint": {"enabled": enabled, "version": 1}}
    )
    membership = MembershipFactory(user=user, organization=organization, org_role=role)
    return organization, membership


def change(user, organization=None, version=0, **flags):
    return client_for(user).patch(
        URL,
        {
            "organization_id": str(organization.pk) if organization else None,
            "expected_version": version,
            **flags,
        },
        format="json",
    )


def settings_for(user, organization=None):
    return client_for(user).get(
        URL, {"organization_id": str(organization.pk)} if organization else {}
    )


def profile_for(user, organization=None, *, identify=False):
    response = change(
        user, organization, allow_enrollment=True, allow_identification=identify
    )
    assert response.status_code == 200
    return service.ensure_profile(
        user,
        organization_id=organization.pk if organization else None,
        expected_version=response.data["version"],
    )


def sample_for(profile, *, ready=False):
    identifier = uuid4()
    sample = models.VoiceprintSample.objects.create(
        id=identifier,
        profile=profile,
        generation=profile.generation,
        consent_version=profile.consent.version,
        permit_id=uuid4(),
        source_type="enrollment",
        end_ms=10000,
        audio_sha256=uuid4().hex * 2,
        encrypted_audio=load_keyring().encrypt(
            profile,
            b"synthetic private audio fixture",
            kind="audio",
            object_id=identifier,
        ),
        encrypted_embedding=b"",
        quality={
            "speech_checked": ready,
            "speaker_consistency_checked": ready,
            "valid_speech_ms": 10000 if ready else 0,
        },
        status="confirmed" if ready else "pending",
        confirmed_at=timezone.now() if ready else None,
        expires_at=timezone.now() + timedelta(hours=24),
    )
    if ready:
        registration = models.VoiceprintEnrollment.objects.create(
            owner_id=profile.consent.user_id,
            organization_id=profile.consent.organization_id,
            profile=profile,
            request_key=uuid4(),
            consent_version=profile.consent.version,
            generation=profile.generation,
            policy_version=service.organization_policy(profile.consent.organization)[
                "version"
            ]
            if profile.consent.organization_id
            else 0,
            challenges=[
                "Please read in your own voice: I am recording a voice sample for my account. The numbers for this recording are: 10 20 30 40 50 60."
            ]
            * 6,
            expires_at=timezone.now() + timedelta(minutes=10),
            status="closed",
        )
        sample.enrollment = registration
        sample.enrollment_slot = 0
        sample.permit_id = registration.pk
        sample.confirmed_at = timezone.now()
        sample.quality.update(
            {
                "speech_validation": QUALITY_POLICY,
                "asr_model_id": QUALITY_MODEL_ID,
                "speaker_count": 1,
                "prompt_checked": True,
                "prompt_sha256": challenge_digest(
                    registration.locale, registration.challenges[0]
                ),
            }
        )
        sample.encrypted_embedding = load_keyring().encrypt(
            profile,
            sample_payload(sample, (1.0, *([0.0] * 1023))),
            kind="embedding",
            object_id=sample.pk,
        )
        sample.save()
        models.VoiceprintSampleDecision.objects.create(
            sample=sample,
            owner_id=profile.consent.user_id,
            accepted=True,
            consent_version=sample.consent_version,
            generation=sample.generation,
        )
    return sample


def activate(profile):
    samples = [sample_for(profile, ready=True) for _ in range(3)]
    identifier = uuid4()
    template = models.VoiceprintTemplate.objects.create(
        id=identifier,
        profile=profile,
        generation=profile.generation,
        dimension=1024,
        policy_version=POLICY_VERSION,
        support_digest=supports_digest(samples),
    )
    template.support_samples.add(*samples)
    template.encrypted_vector = load_keyring().encrypt(
        profile,
        template_payload(template, (1.0, *([0.0] * 1023))),
        kind="template",
        object_id=identifier,
    )
    template.save()
    profile.status = "active"
    profile.confirmed_at = profile.last_updated_at = timezone.now()
    profile.save()
    return template


def delete(user, profile, *, version=None, key=None):
    return client_for(user).delete(
        f"/api/v1.0/voiceprint/profiles/{profile.pk}/",
        {
            "expected_version": version or profile.consent.version,
            "request_key": str(key or uuid4()),
        },
        format="json",
    )


def test_default_read_is_private_noncreating_and_independent_of_asr(settings):
    settings.MEETING_RECORDS_ENABLED = False
    user = UserFactory()
    response = settings_for(user)
    assert (
        response.status_code == 200 and response["Cache-Control"] == "private, no-store"
    )
    assert response.data == {
        "organization_id": None,
        "available": True,
        "version": 0,
        "generation": 0,
        **dict.fromkeys(service.PERMISSIONS, False),
        "profiles": [],
    }
    assert not models.VoiceprintConsent.objects.exists()
    assert change(user, allow_enrollment=False).data == response.data
    assert not models.VoiceprintConsent.objects.exists()
    assert APIClient().get(URL).status_code in (401, 403)


def test_three_permissions_are_independent_and_history_only_appends_changes():
    user = UserFactory()
    first = change(user, allow_enrollment=True)
    assert first.data["allow_accumulation"] is False
    assert first.data["allow_identification"] is False
    second = change(user, version=1, allow_accumulation=True)
    third = change(user, version=2, allow_enrollment=False, allow_identification=True)
    assert third.data["allow_accumulation"] is True
    assert third.data["allow_enrollment"] is False
    assert third.data["generation"] == first.data["generation"] == 1
    assert change(user, version=3, allow_identification=True).data == third.data
    assert second.data["version"] == 2
    assert list(
        models.VoiceprintConsentEvent.objects.order_by("version").values_list(
            "version", flat=True
        )
    ) == [1, 2, 3]


def test_stale_write_never_restores_revoked_permission():
    user = UserFactory()
    change(user, allow_enrollment=True)
    change(user, version=1, allow_enrollment=False)
    stale = change(user, version=1, allow_enrollment=True)
    assert stale.status_code == 409 and stale.data == {
        "code": "voiceprint_settings_changed"
    }
    assert settings_for(user).data["allow_enrollment"] is False


@pytest.mark.parametrize(
    "extra",
    [
        {"user_id": str(uuid4())},
        {"vector": [0]},
        {"allow_enrollment": "true"},
        {"allow_enrollment": 1},
        {"expected_version": True},
        {"expected_version": 0.0},
    ],
)
def test_strict_payload_cannot_select_another_owner_or_coerce_permission(extra):
    response = client_for(UserFactory()).patch(
        URL,
        {
            "organization_id": None,
            "expected_version": 0,
            "allow_enrollment": True,
            **extra,
        },
        format="json",
    )
    assert response.status_code == 400
    assert not models.VoiceprintConsent.objects.exists()


def test_organization_opt_in_and_active_membership_are_required():
    user = UserFactory()
    organization, membership = org_for(user, enabled=False)
    assert settings_for(user, organization).data["available"] is False
    assert change(user, organization, allow_enrollment=True).status_code == 403
    organization.settings["voiceprint"]["enabled"] = True
    organization.save()
    assert change(user, organization, allow_enrollment=True).status_code == 200
    assert settings_for(UserFactory(), organization).status_code == 404
    membership.status = models.MembershipStatusChoices.LEFT
    membership.save()
    assert settings_for(user, organization).data["allow_enrollment"] is False
    assert (
        change(user, organization, version=2, allow_enrollment=True).status_code == 403
    )


def test_disabled_function_still_allows_owner_revocation_and_deletion(settings):
    user = UserFactory()
    profile = profile_for(user)
    settings.MEETING_VOICEPRINT_ENABLED = False
    assert settings_for(user).data["available"] is False
    assert change(user, version=1, allow_accumulation=True).status_code == 403
    assert change(user, version=1, allow_enrollment=False).status_code == 200
    assert delete(user, profile, version=2).status_code == 202
    assert settings_for(user).data["version"] == 3


def test_directory_rules_cannot_cross_scope_and_public_settings_never_return_keys():
    user, other = UserFactory.create_batch(2)
    first_org, _ = org_for(user)
    second_org, _ = org_for(user)
    first = profile_for(user, first_org)
    second = profile_for(user, second_org)
    personal = profile_for(user)
    assert first.encrypted_key != second.encrypted_key != personal.encrypted_key
    first_data = settings_for(user, first_org).data
    assert [row["id"] for row in first_data["profiles"]] == [str(first.pk)]
    assert "encrypted" not in json.dumps(first_data) and "vector" not in json.dumps(
        first_data
    )
    assert delete(other, first).status_code == 404
    assert delete(user, first).status_code == 202
    second.refresh_from_db()
    personal.refresh_from_db()
    assert second.status == personal.status == "pending"
    assert second.encrypted_key and personal.encrypted_key


def test_old_inflight_version_and_recognition_opt_out_are_rejected_immediately():
    user = UserFactory()
    profile = profile_for(user, identify=True)
    activate(profile)
    assert (
        service.authorize_profile(
            profile.pk, permission="allow_identification", version=1
        ).pk
        == profile.pk
    )
    assert change(user, version=1, allow_identification=False).status_code == 200
    with pytest.raises(
        service.VoiceprintError, match="voiceprint_authorization_revoked"
    ):
        service.authorize_profile(
            profile.pk, permission="allow_identification", version=1
        )
    # Disabling identification keeps independent explicit enrollment usable.
    assert (
        service.authorize_profile(
            profile.pk, permission="allow_enrollment", version=2
        ).pk
        == profile.pk
    )
    with pytest.raises(
        service.VoiceprintError, match="voiceprint_authorization_revoked"
    ):
        service.authorize_profile(profile.pk, permission="allow_enrollment", version=1)


def test_pending_or_stale_or_unverified_templates_cannot_match():
    user = UserFactory()
    profile = profile_for(user, identify=True)
    with pytest.raises(service.VoiceprintError, match="voiceprint_profile_not_ready"):
        service.authorize_profile(profile.pk, permission="allow_identification")
    template = activate(profile)
    template.support_samples.update(
        quality={"speech_checked": False, "speaker_consistency_checked": False}
    )
    with pytest.raises(service.VoiceprintError, match="voiceprint_profile_not_ready"):
        service.authorize_profile(profile.pk, permission="allow_identification")
    template.support_samples.update(
        quality={
            "speech_checked": True,
            "speaker_consistency_checked": True,
            "valid_speech_ms": 10000,
        }
    )
    models.VoiceprintProfile.objects.filter(pk=profile.pk).update(
        last_updated_at=timezone.now() - timedelta(days=366)
    )
    with pytest.raises(service.VoiceprintError, match="voiceprint_profile_not_ready"):
        service.authorize_profile(profile.pk, permission="allow_identification")


@pytest.mark.parametrize(
    "damage",
    [
        "one_clip",
        "missing_embedding",
        "wrong_dimension",
        "wrong_space",
        "short_speech",
        "coerced_speech",
        "duplicate_audio",
        "foreign_support",
        "old_generation",
        "unconfirmed_support",
    ],
)
def test_incomplete_or_incompatible_template_cannot_authorize_identity(damage):
    user = UserFactory()
    profile = profile_for(user, identify=True)
    template = activate(profile)
    samples = list(template.support_samples.order_by("id"))
    if damage == "one_clip":
        template.support_samples.set(samples[:1])
    elif damage == "missing_embedding":
        template.support_samples.update(encrypted_embedding=b"")
    elif damage == "wrong_dimension":
        template.dimension = 192
        template.save()
    elif damage == "wrong_space":
        profile.feature_space = "another-model-space"
        profile.save()
    elif damage in {"short_speech", "coerced_speech"}:
        sample = samples[0]
        sample.quality["valid_speech_ms"] = 9000 if damage == "short_speech" else True
        sample.save()
    elif damage == "duplicate_audio":
        template.support_samples.update(audio_sha256=samples[0].audio_sha256)
    elif damage == "foreign_support":
        foreign = profile_for(UserFactory())
        template.support_samples.add(sample_for(foreign, ready=True))
    elif damage == "old_generation":
        samples[0].generation += 1
        samples[0].save()
    elif damage == "unconfirmed_support":
        samples[0].status = "ready"
        samples[0].save()
    with pytest.raises(service.VoiceprintError, match="voiceprint_profile_not_ready"):
        service.authorize_profile(profile.pk, permission="allow_identification")


def test_confirmed_audio_expiry_does_not_invalidate_sufficient_feature_support():
    profile = profile_for(UserFactory(), identify=True)
    template = activate(profile)
    template.support_samples.update(
        encrypted_audio=b"", expires_at=timezone.now() - timedelta(hours=1)
    )
    assert (
        service.authorize_profile(profile.pk, permission="allow_identification").pk
        == profile.pk
    )


@pytest.mark.parametrize("damage", ["invalid_active_group", "too_many_groups"])
def test_invalid_or_excess_active_device_groups_cannot_enter_matching(damage):
    profile = profile_for(UserFactory(), identify=True)
    original = activate(profile)
    for index in range(1 if damage == "invalid_active_group" else 5):
        template = models.VoiceprintTemplate.objects.create(
            profile=profile,
            generation=profile.generation,
            device_group=f"device-{index}",
            dimension=192 if damage == "invalid_active_group" else 1024,
            encrypted_vector=b"synthetic-template-envelope",
        )
        template.support_samples.add(*original.support_samples.all())
    with pytest.raises(service.VoiceprintError, match="voiceprint_profile_not_ready"):
        service.authorize_profile(profile.pk, permission="allow_identification")


def test_delete_rotates_generation_clears_key_and_cleanup_preserves_new_enrollment():
    user = UserFactory()
    profile = profile_for(user)
    previous_key = bytes(profile.encrypted_key)
    sample = sample_for(profile)
    key = uuid4()
    response = delete(user, profile, key=key)
    assert response.status_code == 202
    assert response.data["revoked_generation"] == 2
    profile.refresh_from_db()
    assert not profile.encrypted_key and profile.status == "deleted"
    assert models.VoiceprintSample.objects.filter(pk=sample.pk).exists()
    assert settings_for(user).data["version"] == 2
    assert delete(user, profile, version=1, key=key).data == response.data
    assert delete(user, profile, version=2, key=key).status_code == 409
    assert change(user, version=2, allow_enrollment=True).status_code == 200
    renewed = service.ensure_profile(user, organization_id=None, expected_version=3)
    assert renewed.pk == profile.pk and renewed.generation == 2
    assert bytes(renewed.encrypted_key) != previous_key
    new_sample = sample_for(renewed)
    job = service.purge_deleted(response.data["id"])
    assert job.status == "succeeded" and job.receipt["samples"] == 1
    assert not models.VoiceprintSample.objects.filter(pk=sample.pk).exists()
    assert models.VoiceprintSample.objects.filter(pk=new_sample.pk).exists()
    renewed.refresh_from_db()
    assert renewed.encrypted_key and renewed.status == "pending"
    assert service.purge_deleted(job.pk).attempts == 1
    assert delete(user, renewed, version=1, key=key).data["id"] == str(job.pk)
    renewed.refresh_from_db()
    assert renewed.encrypted_key


def test_cleanup_status_is_owner_only_and_job_receipt_has_no_biometric_data():
    user = UserFactory()
    profile = profile_for(user)
    sample_for(profile)
    response = delete(user, profile)
    url = f"/api/v1.0/voiceprint/deletions/{response.data['id']}/"
    assert client_for(UserFactory()).get(url).status_code == 404
    output = io.StringIO()
    call_command("purge_voiceprints", stdout=output)
    assert json.loads(output.getvalue()) == {"succeeded": 1, "failed": 0}
    assert client_for(user).get(url).data["status"] == "succeeded"
    assert not models.VoiceprintSample.objects.exists()


@pytest.mark.parametrize("loss", ["inactive", "device", "left", "membership_delete"])
def test_account_or_last_membership_loss_invalidates_scope(loss):
    user = UserFactory()
    organization, membership = org_for(user)
    profile = profile_for(user, organization)
    if loss in {"inactive", "device"}:
        setattr(
            user, "is_active" if loss == "inactive" else "is_device", loss == "device"
        )
        user.save()
    elif loss == "left":
        membership.status = models.MembershipStatusChoices.LEFT
        membership.save()
    else:
        membership.delete()
    profile.refresh_from_db()
    profile.consent.refresh_from_db()
    assert profile.status == "deleted" and not profile.encrypted_key
    assert profile.consent.generation == 2
    with pytest.raises(
        service.VoiceprintError, match="voiceprint_authorization_revoked"
    ):
        service.authorize_profile(profile.pk, permission="allow_enrollment", version=1)


def test_departure_from_one_department_does_not_revoke_other_active_membership():
    user = UserFactory()
    organization, first = org_for(user)
    second = MembershipFactory(user=user, organization=organization)
    profile = profile_for(user, organization)
    first.delete()
    profile.refresh_from_db()
    assert profile.encrypted_key
    second.delete()
    profile.refresh_from_db()
    assert not profile.encrypted_key


@pytest.mark.parametrize("target", ["user", "organization", "consent"])
def test_hard_removal_keeps_uuid_tombstone_without_fk_or_ciphertext(target):
    user = UserFactory()
    organization, _ = org_for(user)
    profile = profile_for(user, organization)
    sample_for(profile)
    identifier = user.pk
    {"user": user, "organization": organization, "consent": profile.consent}[
        target
    ].delete()
    assert not models.VoiceprintProfile.objects.exists()
    assert not models.VoiceprintSample.objects.exists()
    tombstone = models.VoiceprintDeletionJob.objects.get(owner_id=identifier)
    assert tombstone.consent_id is None and tombstone.revoked_generation == 2
    assert service.purge_deleted(tombstone.pk).status == "succeeded"


def test_tombstone_blocks_restored_old_scope_and_recreation_starts_above_floor():
    user = UserFactory()
    profile = profile_for(user)
    response = delete(user, profile)
    # A simulated restored old DB row must not override the current tombstone.
    models.VoiceprintConsent.objects.filter(pk=profile.consent_id).update(
        generation=1, allow_enrollment=True
    )
    models.VoiceprintProfile.objects.filter(pk=profile.pk).update(
        status="pending", encrypted_key=b"old-fixture"
    )
    with pytest.raises(
        service.VoiceprintError, match="voiceprint_authorization_revoked"
    ):
        service.authorize_profile(profile.pk, permission="allow_enrollment")
    assert change(user, version=2, allow_enrollment=True).status_code == 409
    profile.consent.delete()
    fresh = change(user, allow_enrollment=True)
    assert (
        fresh.status_code == 200
        and fresh.data["generation"] >= response.data["revoked_generation"]
    )


def test_organization_admin_cannot_grant_personal_permissions_or_change_other_scope():
    admin, member = UserFactory.create_batch(2)
    organization, _ = org_for(admin, role=models.OrgRoleChoices.ADMIN, enabled=False)
    MembershipFactory(user=member, organization=organization)
    url = f"/api/v1.0/voiceprint/organizations/{organization.pk}/settings/"
    assert (
        client_for(member)
        .patch(url, {"enabled": True, "expected_version": 1}, format="json")
        .status_code
        == 403
    )
    assert (
        client_for(admin)
        .patch(url, {"enabled": True, "expected_version": 1}, format="json")
        .status_code
        == 200
    )
    assert not models.VoiceprintConsent.objects.exists()
    assert (
        models.AuditLog.objects.filter(
            action=models.AuditActionChoices.VOICEPRINT_POLICY_CHANGED,
            organization=organization,
            actor=admin,
        ).count()
        == 1
    )
    assert (
        change(
            admin, organization, allow_enrollment=True, user_id=str(member.pk)
        ).status_code
        == 400
    )
    other_org = OrganizationFactory()
    assert (
        client_for(admin)
        .get(f"/api/v1.0/voiceprint/organizations/{other_org.pk}/settings/")
        .status_code
        == 403
    )
    assert (
        client_for(admin)
        .patch(url, {"enabled": False, "expected_version": 1}, format="json")
        .status_code
        == 409
    )


def test_profile_ciphertext_cannot_be_swapped_across_scope():
    user = UserFactory()
    first_org, _ = org_for(user)
    second_org, _ = org_for(user)
    first = profile_for(user, first_org)
    second = profile_for(user, second_org)
    sample = sample_for(first)
    with pytest.raises(VoiceprintCryptoError):
        load_keyring().decrypt(
            second, sample.encrypted_audio, kind="audio", object_id=sample.pk
        )
    second.encrypted_key = first.encrypted_key
    with pytest.raises(VoiceprintCryptoError):
        load_keyring().profile_key(second)


@pytest.mark.parametrize("loss", ["account", "membership", "organization"])
def test_bulk_changes_are_denied_immediately_and_reconcile_revokes_persisted_data(loss):
    user = UserFactory()
    organization, membership = org_for(user)
    profile = profile_for(user, organization)
    if loss == "account":
        models.User.objects.filter(pk=user.pk).update(is_active=False)
    elif loss == "membership":
        models.Membership.objects.filter(pk=membership.pk).update(
            status=models.MembershipStatusChoices.LEFT
        )
    else:
        models.Organization.objects.filter(pk=organization.pk).update(is_active=False)
    with pytest.raises(
        service.VoiceprintError, match="voiceprint_authorization_revoked"
    ):
        service.authorize_profile(profile.pk, permission="allow_enrollment")
    output = io.StringIO()
    call_command("reconcile_voiceprints", stdout=output)
    assert json.loads(output.getvalue()) == {"revoked": 1}
    profile.refresh_from_db()
    assert profile.status == "deleted" and not profile.encrypted_key
    output = io.StringIO()
    call_command("reconcile_voiceprints", stdout=output)
    assert json.loads(output.getvalue()) == {"revoked": 0}


def test_retention_clears_expired_pending_data_but_preserves_confirmed_features():
    user = UserFactory()
    profile = profile_for(user)
    pending = sample_for(profile)
    confirmed = sample_for(profile, ready=True)
    future = sample_for(profile)
    # Encrypted feature fixtures remain private; no actual biometric evaluation.
    models.VoiceprintSample.objects.filter(pk__in=[pending.pk, confirmed.pk]).update(
        expires_at=timezone.now() - timedelta(seconds=1),
        encrypted_embedding=b"private-ciphertext-fixture",
    )
    output = io.StringIO()
    call_command("expire_voiceprint_samples", stdout=output)
    assert json.loads(output.getvalue()) == {"expired": 2}
    pending.refresh_from_db()
    confirmed.refresh_from_db()
    future.refresh_from_db()
    assert (
        pending.status == "expired"
        and not pending.encrypted_audio
        and not pending.encrypted_embedding
    )
    assert confirmed.status == "confirmed" and not confirmed.encrypted_audio
    assert confirmed.encrypted_embedding
    assert future.status == "pending" and future.encrypted_audio
    assert expire_sample(confirmed.pk) is False


def test_deactivated_personal_scope_reconcile_handles_nullable_organization():
    user = UserFactory()
    profile = profile_for(user)
    models.User.objects.filter(pk=user.pk).update(is_active=False)
    output = io.StringIO()
    call_command("reconcile_voiceprints", stdout=output)
    assert json.loads(output.getvalue()) == {"revoked": 1}
    profile.refresh_from_db()
    assert not profile.encrypted_key


def test_database_itself_enforces_one_personal_or_organization_scope():
    user = UserFactory()
    profile_for(user)
    with pytest.raises(IntegrityError), transaction.atomic():
        models.VoiceprintConsent.objects.bulk_create(
            [models.VoiceprintConsent(user=user)]
        )
    organization, _ = org_for(user)
    profile_for(user, organization)
    with pytest.raises(IntegrityError), transaction.atomic():
        models.VoiceprintConsent.objects.bulk_create(
            [models.VoiceprintConsent(user=user, organization=organization)]
        )
    assert models.VoiceprintConsent.objects.count() == 2


def test_corrupt_organization_policy_is_closed_and_admin_can_repair_it():
    user = UserFactory()
    organization, _ = org_for(user, role=models.OrgRoleChoices.ADMIN)
    organization.settings = ["invalid-policy-fixture"]
    organization.save()
    assert settings_for(user, organization).data["available"] is False
    url = f"/api/v1.0/voiceprint/organizations/{organization.pk}/settings/"
    assert (
        client_for(user)
        .patch(url, {"enabled": True, "expected_version": 0}, format="json")
        .status_code
        == 200
    )
    assert settings_for(user, organization).data["available"] is True


@pytest.mark.parametrize("version", [None, True, 1.0, "1", -1])
def test_invalid_policy_version_never_enables_organization_scope(version):
    user = UserFactory()
    organization, _ = org_for(user, role=models.OrgRoleChoices.ADMIN)
    organization.settings = {"voiceprint": {"enabled": True, "version": version}}
    organization.save()
    assert settings_for(user, organization).data["available"] is False
    assert change(user, organization, allow_enrollment=True).status_code == 403
    repaired = client_for(user).patch(
        f"/api/v1.0/voiceprint/organizations/{organization.pk}/settings/",
        {"enabled": True, "expected_version": 0},
        format="json",
    )
    assert repaired.status_code == 200
    assert repaired.data == {"enabled": True, "version": 1}
    assert settings_for(user, organization).data["available"] is True


def test_physical_cleanup_failure_has_bounded_retries_and_safe_receipt(monkeypatch):
    user = UserFactory()
    profile = profile_for(user)
    response = delete(user, profile)

    def fail(_identifier):
        raise RuntimeError("private payload fixture must not appear in receipt")

    monkeypatch.setattr(
        "core.management.commands.purge_voiceprints.purge_deleted", fail
    )
    for _attempt in range(3):
        output = io.StringIO()
        call_command("purge_voiceprints", stdout=output)
        assert json.loads(output.getvalue()) == {"failed": 1, "succeeded": 0}
    output = io.StringIO()
    call_command("purge_voiceprints", stdout=output)
    assert json.loads(output.getvalue()) == {"failed": 0, "succeeded": 0}
    job = models.VoiceprintDeletionJob.objects.get(pk=response.data["id"])
    assert job.attempts == 3 and job.error_code == "cleanup_unavailable"
    assert "private" not in json.dumps(service.deletion_snapshot(job))


@pytest.mark.parametrize("removed", ["account", "consent"])
def test_reconciliation_continues_after_concurrent_scope_removal(monkeypatch, removed):
    users = UserFactory.create_batch(2)
    profiles = [profile_for(user) for user in users]
    models.User.objects.filter(pk__in=[user.pk for user in users]).update(
        is_active=False
    )
    original = QuerySet.select_for_update
    triggered = False

    def interleave(queryset, *args, **kwargs):
        nonlocal triggered
        target = models.User if removed == "account" else models.VoiceprintConsent
        if queryset.model is target and not triggered:
            triggered = True
            if removed == "account":
                models.User.objects.filter(pk=users[0].pk).delete()
            else:
                models.VoiceprintConsent.objects.filter(
                    pk=profiles[0].consent_id
                ).delete()
        return original(queryset, *args, **kwargs)

    monkeypatch.setattr(QuerySet, "select_for_update", interleave)
    output = io.StringIO()
    call_command("reconcile_voiceprints", stdout=output)
    assert triggered and json.loads(output.getvalue()) == {"revoked": 1}
    profiles[1].refresh_from_db()
    assert profiles[1].status == "deleted" and not profiles[1].encrypted_key


def test_expiry_sweep_removes_old_generation_even_without_audio_and_does_not_repeat():
    user = UserFactory()
    profile = profile_for(user)
    old = sample_for(profile, ready=True)
    rejected = sample_for(profile)
    models.VoiceprintSample.objects.filter(pk=old.pk).update(
        expires_at=timezone.now() - timedelta(seconds=1),
        encrypted_audio=b"",
        encrypted_embedding=b"old-ciphertext-fixture",
    )
    models.VoiceprintSample.objects.filter(pk=rejected.pk).update(
        status="rejected",
        expires_at=timezone.now() - timedelta(seconds=1),
        encrypted_embedding=b"rejected-ciphertext-fixture",
    )
    models.VoiceprintConsent.objects.filter(pk=profile.consent_id).update(generation=2)
    output = io.StringIO()
    call_command("expire_voiceprint_samples", stdout=output)
    assert json.loads(output.getvalue()) == {"expired": 2}
    old.refresh_from_db()
    rejected.refresh_from_db()
    assert not old.encrypted_embedding and old.status == "deleted"
    assert not rejected.encrypted_embedding and rejected.status == "deleted"
    output = io.StringIO()
    call_command("expire_voiceprint_samples", stdout=output)
    assert json.loads(output.getvalue()) == {"expired": 0}


def test_expiry_keeps_current_generation_rejection_reason_while_clearing_data():
    user = UserFactory()
    profile = profile_for(user)
    rejected = sample_for(profile)
    models.VoiceprintSample.objects.filter(pk=rejected.pk).update(
        status="rejected",
        expires_at=timezone.now() - timedelta(seconds=1),
        encrypted_embedding=b"rejected-ciphertext-fixture",
    )
    assert expire_sample(rejected.pk)
    rejected.refresh_from_db()
    assert (
        rejected.status == "rejected"
        and not rejected.encrypted_embedding
        and not rejected.encrypted_audio
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_first_writes_serialize_on_subject_and_do_not_duplicate_scope():
    user = UserFactory()

    def run():
        close_old_connections()
        try:
            return change(user, allow_enrollment=True).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _index: run(), range(2)))
    assert sorted(results) == [200, 409]
    assert models.VoiceprintConsent.objects.count() == 1
    assert models.VoiceprintConsentEvent.objects.count() == 1
