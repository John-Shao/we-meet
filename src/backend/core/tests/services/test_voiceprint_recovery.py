"""Current-source signatures, offline replay, deletion and preserved valid templates."""

import base64
import copy
import io
import json
import os
from uuid import uuid4

from django.core.management import call_command
from django.core.management.base import CommandError

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from core import models
from core.factories import UserFactory
from core.services import voiceprint_consent as consent
from core.services import voiceprint_recovery as service
from core.services import voiceprint_source_removal as removal
from core.tests.services.test_voiceprint_consent import (
    activate,
    delete,
    enabled,  # Reuse the actual encrypted template/key fixture.
    org_for,
    profile_for,
    sample_for,
)

pytestmark = pytest.mark.django_db(transaction=True)


def offline(settings):
    settings.MEETING_VOICEPRINT_ENABLED = False
    settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = False
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False


@pytest.fixture
def keys(tmp_path):
    seed = os.urandom(32)
    public = (
        Ed25519PrivateKey.from_private_bytes(seed)
        .public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    )
    common = {
        "v": 1,
        "deployment_id": str(uuid4()),
        "encryption_key": base64.b64encode(os.urandom(32)).decode(),
    }
    writer_path, reader_path = tmp_path / "writer.json", tmp_path / "reader.json"
    service.write_private(
        writer_path, {**common, "signing_key": base64.b64encode(seed).decode()}
    )
    service.write_private(
        reader_path, {**common, "verification_key": base64.b64encode(public).decode()}
    )
    writer = service.configuration(writer_path, "writer")
    reader = service.configuration(reader_path, "reader")
    return writer, reader, writer_path, reader_path


@pytest.fixture
def packet(keys, settings):
    writer, reader, _writer_path, _reader_path = keys
    offline(settings)
    request = service.request_for(reader["deployment_id"])
    bundle = service.export_snapshot(writer, request)
    return writer, reader, request, bundle


def sign_data(writer, data):
    """A trusted signer still cannot bypass semantic validation at the reader."""
    nonce = os.urandom(12)
    aad = service.DOMAIN + writer["deployment_id"].encode()
    sealed = nonce + AESGCM(writer["encryption_key"]).encrypt(
        nonce, service.canonical(data), aad
    )
    signature = Ed25519PrivateKey.from_private_bytes(writer["signing_key"]).sign(
        aad + sealed
    )
    return {
        "v": 1,
        "encrypted": base64.b64encode(sealed).decode(),
        "signature": base64.b64encode(signature).decode(),
    }


@pytest.mark.parametrize("organization", [False, True])
def test_current_external_packet_erases_predeletion_rows_and_keeps_valid_other_scope(  # noqa: PLR0915 -- Preserve the complete predelete encrypted graph and restore it before verification.
    keys, settings, organization
):
    writer, reader, _writer_path, _reader_path = keys
    owner = UserFactory()
    scope = org_for(owner)[0] if organization else None
    profile = profile_for(owner, scope, identify=True)
    template = activate(profile)
    old_samples = list(template.support_samples.all())
    old_dates = {sample.pk: sample.created_at for sample in old_samples}
    old_decisions = list(
        models.VoiceprintSampleDecision.objects.filter(sample__in=old_samples)
    )
    decision_dates = {row.pk: row.created_at for row in old_decisions}
    old_key = bytes(profile.encrypted_key)
    frozen_profile = {
        key: getattr(profile, key)
        for key in (
            "status",
            "generation",
            "confirmed_at",
            "last_updated_at",
            "template_checked_at",
        )
    }
    unaffected_scope = None if scope else org_for(owner)[0]
    unaffected = profile_for(owner, unaffected_scope, identify=True)
    valid_template = activate(unaffected)
    valid_vector = bytes(valid_template.encrypted_vector)
    valid_key = bytes(unaffected.encrypted_key)
    response = delete(owner, profile)
    assert response.status_code == 202
    consent.purge_deleted(response.data["id"])
    offline(settings)
    request = service.request_for(reader["deployment_id"])
    bundle = service.export_snapshot(writer, request)
    visible = json.dumps(bundle)
    assert str(owner.pk) not in visible and owner.full_name not in visible
    assert "encrypted_audio" not in visible and "encrypted_key" not in visible
    # Simulate rows from a backup predating deletion, without current DB tombstones.
    models.VoiceprintDeletionJob.objects.filter(
        owner_id=owner.pk, organization_id=scope.pk if scope else None
    ).delete()
    models.VoiceprintConsentEvent.objects.filter(
        consent_id=profile.consent_id, version__gt=1
    ).delete()
    models.VoiceprintConsent.objects.filter(pk=profile.consent_id).update(
        version=1,
        generation=1,
        allow_enrollment=True,
        allow_identification=True,
    )
    models.VoiceprintProfile.objects.filter(pk=profile.pk).update(
        **frozen_profile, encrypted_key=old_key
    )
    for sample in old_samples:
        sample.save(force_insert=True)
        models.VoiceprintSample.objects.filter(pk=sample.pk).update(
            created_at=old_dates[sample.pk]
        )
    for decision in old_decisions:
        decision.save(force_insert=True)
        models.VoiceprintSampleDecision.objects.filter(pk=decision.pk).update(
            created_at=decision_dates[decision.pk]
        )
    models.VoiceprintEnrollment.objects.filter(
        owner_id=owner.pk, organization_id=scope.pk if scope else None
    ).update(status="closed")
    template.save(force_insert=True)
    template.support_samples.add(*old_samples)
    settings.MEETING_VOICEPRINT_ENABLED = True
    assert (
        consent.authorize_profile(profile.pk, permission="allow_identification").pk
        == profile.pk
    )
    offline(settings)
    result = service.restore_snapshot(reader, request, bundle)
    assert result["status"] == "replayed" and result["floors"] == 1
    assert result["voiceprint_enabled"] is False
    assert not models.VoiceprintSample.objects.filter(
        pk__in=[row.pk for row in old_samples]
    ).exists()
    assert not models.VoiceprintTemplate.objects.filter(pk=template.pk).exists()
    profile.refresh_from_db()
    profile.consent.refresh_from_db()
    assert not profile.encrypted_key and profile.status == "deleted"
    assert profile.consent.generation == 2
    assert (
        not profile.consent.allow_enrollment
        and not profile.consent.allow_identification
    )
    repeated = service.restore_snapshot(reader, request, bundle)
    assert repeated["permissions_restricted"] == 0
    assert (
        models.VoiceprintDeletionJob.objects.filter(reason="backup_recovery").count()
        == 1
    )
    valid_template.refresh_from_db()
    unaffected.refresh_from_db()
    assert bytes(valid_template.encrypted_vector) == valid_vector
    assert bytes(unaffected.encrypted_key) == valid_key
    settings.MEETING_VOICEPRINT_ENABLED = True
    assert (
        consent.authorize_profile(unaffected.pk, permission="allow_identification").pk
        == unaffected.pk
    )


def test_rejected_unused_sample_is_erased_without_invalidating_confirmed_baseline(
    keys, settings
):
    writer, reader, _writer_path, _reader_path = keys
    owner = UserFactory()
    profile = profile_for(owner, identify=True)
    baseline = activate(profile)
    vector = bytes(baseline.encrypted_vector)
    rejected = sample_for(profile)
    original_audio = bytes(rejected.encrypted_audio)
    models.VoiceprintSample.objects.filter(pk=rejected.pk).update(
        status="rejected", encrypted_audio=b"", encrypted_embedding=b""
    )
    offline(settings)
    request = service.request_for(reader["deployment_id"])
    bundle = service.export_snapshot(writer, request)
    models.VoiceprintSample.objects.filter(pk=rejected.pk).update(
        status="pending", encrypted_audio=original_audio
    )
    result = service.restore_snapshot(reader, request, bundle)
    assert result["contributions"] == 1
    assert not models.VoiceprintSample.objects.filter(pk=rejected.pk).exists()
    baseline.refresh_from_db()
    profile.refresh_from_db()
    assert bytes(baseline.encrypted_vector) == vector and profile.status == "active"
    settings.MEETING_VOICEPRINT_ENABLED = True
    assert (
        consent.authorize_profile(profile.pk, permission="allow_identification").pk
        == profile.pk
    )


def test_permission_revocation_is_preserved_without_automatically_granting_other_flags(
    keys, settings
):
    writer, reader, _writer_path, _reader_path = keys
    owner = UserFactory()
    profile = profile_for(owner, identify=True)
    baseline = activate(profile)
    consent.update_settings(
        owner,
        organization_id=None,
        expected_version=1,
        changes={"allow_identification": False},
    )
    offline(settings)
    request = service.request_for(reader["deployment_id"])
    bundle = service.export_snapshot(writer, request)
    models.VoiceprintConsentEvent.objects.filter(
        consent_id=profile.consent_id, version__gt=1
    ).delete()
    models.VoiceprintConsent.objects.filter(pk=profile.consent_id).update(
        version=1, allow_identification=True, allow_enrollment=False
    )
    service.restore_snapshot(reader, request, bundle)
    profile.consent.refresh_from_db()
    assert not profile.consent.allow_identification
    assert (
        not profile.consent.allow_enrollment
    )  # The source's True flag is not a permission grant.
    baseline.refresh_from_db()
    assert baseline.encrypted_vector


def test_unavailable_current_account_exports_a_floor_even_if_bulk_change_missed_signals(
    keys, settings
):
    writer, reader, _writer_path, _reader_path = keys
    owner = UserFactory()
    profile = profile_for(owner, identify=True)
    activate(profile)
    models.User.objects.filter(pk=owner.pk).update(is_active=False)
    assert not models.VoiceprintDeletionJob.objects.exists()
    offline(settings)
    request = service.request_for(reader["deployment_id"])
    bundle = service.export_snapshot(writer, request)
    models.User.objects.filter(pk=owner.pk).update(is_active=True)
    result = service.restore_snapshot(reader, request, bundle)
    assert result["floors"] == 1
    profile.refresh_from_db()
    assert not profile.encrypted_key and profile.status == "deleted"


def test_disabled_organization_policy_is_preserved_without_revoking_personal_consent(
    keys, settings
):
    writer, reader, _writer_path, _reader_path = keys
    owner = UserFactory()
    organization, _membership = org_for(owner)
    profile = profile_for(owner, organization)
    models.Organization.objects.filter(pk=organization.pk).update(
        settings={"voiceprint": {"enabled": False, "version": 2}, "unrelated": "kept"}
    )
    offline(settings)
    request = service.request_for(reader["deployment_id"])
    bundle = service.export_snapshot(writer, request)
    models.Organization.objects.filter(pk=organization.pk).update(
        settings={"voiceprint": {"enabled": True, "version": 1}, "unrelated": "kept"}
    )
    result = service.restore_snapshot(reader, request, bundle)
    assert result["organization_policies_restricted"] == 1
    organization.refresh_from_db()
    profile.consent.refresh_from_db()
    assert not consent.organization_policy(organization)["enabled"]
    assert organization.settings["unrelated"] == "kept"
    assert (
        profile.consent.allow_enrollment
    )  # A policy pause is distinct from personal revocation.


@pytest.mark.parametrize(
    "damage",
    [
        "ciphertext",
        "signature",
        "reader_key",
        "encryption_key",
        "nonce",
        "deployment",
        "expired",
    ],
)
def test_bad_packet_is_rejected_before_any_sql(
    packet, damage, monkeypatch, django_assert_num_queries
):
    _writer, reader, request, bundle = packet
    reader, request, bundle = copy.deepcopy((reader, request, bundle))
    if damage in {"ciphertext", "signature"}:
        field = "encrypted" if damage == "ciphertext" else "signature"
        value = bytearray(base64.b64decode(bundle[field]))
        value[-1] ^= 1
        bundle[field] = base64.b64encode(value).decode()
    elif damage == "reader_key":
        reader["verification_key"] = os.urandom(32)
    elif damage == "encryption_key":
        reader["encryption_key"] = os.urandom(32)
    elif damage == "nonce":
        request["nonce"] = os.urandom(32).hex()
    elif damage == "deployment":
        reader["deployment_id"] = request["deployment_id"] = str(uuid4())
    else:
        monkeypatch.setattr(service.time, "time", lambda: request["expires_at"] + 1)
    with django_assert_num_queries(0), pytest.raises(service.RecoveryError):
        service.restore_snapshot(reader, request, bundle)


@pytest.mark.parametrize(
    "damage",
    [
        "private_field",
        "duplicate_scope",
        "invalid_generation",
        "invalid_nonce",
        "unknown_field",
        "coerced_flag",
        "bad_source",
        "bad_template",
    ],
)
def test_signed_invalid_metadata_still_fails_before_any_sql(
    packet, damage, django_assert_num_queries
):
    writer, reader, request, bundle = packet
    data = service.verified_snapshot(reader, request, bundle)
    scope = {
        "owner": str(uuid4()),
        "organization": None,
        "generation": 1,
        "version": 1,
        "flags": dict.fromkeys(consent.PERMISSIONS, False),
    }
    if damage in {"private_field", "duplicate_scope", "coerced_flag"}:
        data["permissions"] = [scope]
        if damage == "private_field":
            scope["private_name"] = "Must never enter recovery metadata"
        elif damage == "duplicate_scope":
            data["permissions"].append(copy.deepcopy(scope))
        else:
            scope["flags"]["allow_identification"] = 1
    elif damage == "invalid_generation":
        data["floors"] = [
            {
                "owner": scope["owner"],
                "organization": None,
                "generation": True,
                "version": 1,
            }
        ]
    elif damage == "invalid_nonce":
        data["nonce"] = "bad"
    elif damage == "unknown_field":
        data["plaintext_vector"] = [1.0]
    elif damage == "bad_source":
        data["sources"] = [
            {
                "kind": "track",
                "uuid": str(uuid4()),
                "session": None,
                "digest": "raw-track-id",
            }
        ]
    else:
        data["contributions"] = [
            {
                "sample_uuid": str(uuid4()),
                "profile_uuid": str(uuid4()),
                "owner_uuid": scope["owner"],
                "organization_uuid": None,
                "generation": 1,
                "templates": {
                    "all": False,
                    "permit_id": None,
                    "rows": [{"id": "not-a-uuid"}],
                },
            }
        ]
    with django_assert_num_queries(0), pytest.raises(service.RecoveryError):
        service.restore_snapshot(reader, request, sign_data(writer, data))


@pytest.mark.parametrize(
    "flag",
    [
        "MEETING_VOICEPRINT_ENABLED",
        "MEETING_VOICEPRINT_SAMPLING_ENABLED",
        "MEETING_VOICEPRINT_MATCHING_ENABLED",
    ],
)
def test_live_processing_blocks_restore_and_export(
    packet, settings, flag, django_assert_num_queries
):
    writer, reader, request, bundle = packet
    setattr(settings, flag, True)
    with django_assert_num_queries(0):
        for operation in (
            lambda: service.restore_snapshot(reader, request, bundle),
            lambda: service.export_snapshot(writer, request),
        ):
            with pytest.raises(service.RecoveryError, match="offline_required"):
                operation()


def test_private_file_refuses_overwrite_duplicate_json_and_writer_key_at_reader(
    keys, tmp_path
):
    _writer, _reader, writer_path, _reader_path = keys
    with pytest.raises(service.RecoveryError):
        service.configuration(writer_path, "reader")
    path = tmp_path / "request.json"
    service.write_private(path, {"v": 1})
    with pytest.raises(service.RecoveryError, match="output_unavailable"):
        service.write_private(path, {"v": 2})
    assert service.read_private(path) == {"v": 1}
    path.write_text('{"v":1,"v":2}', encoding="utf-8")
    with pytest.raises(service.RecoveryError):
        service.read_private(path)


def test_cli_roundtrip_has_only_aggregate_output_and_private_receipt(
    keys, tmp_path, settings
):
    _writer, _reader, writer_path, reader_path = keys
    offline(settings)
    request_path, bundle_path, receipt_path = (
        tmp_path / name for name in ("request.json", "bundle.json", "receipt.json")
    )
    output = io.StringIO()
    call_command(
        "request_voiceprint_recovery",
        config=str(reader_path),
        output=str(request_path),
        stdout=output,
    )
    assert json.loads(output.getvalue())["status"] == "created"
    output = io.StringIO()
    call_command(
        "export_voiceprint_recovery",
        config=str(writer_path),
        request=str(request_path),
        output=str(bundle_path),
        stdout=output,
    )
    assert json.loads(output.getvalue()) == {
        "status": "exported",
        "encrypted": True,
        "signed": True,
    }
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
    assert (
        result == service.read_private(receipt_path) and result["status"] == "replayed"
    )
    assert "nonce" not in result and "encryption_key" not in result
    with pytest.raises(CommandError, match="request_unavailable"):
        call_command(
            "request_voiceprint_recovery",
            config=str(writer_path),
            output=str(tmp_path / "bad.json"),
        )


def test_conflicting_target_proof_rolls_back_entire_replay(packet):
    writer, reader, request, bundle = packet
    data = service.verified_snapshot(reader, request, bundle)
    data["floors"] = [
        {"owner": str(uuid4()), "organization": None, "generation": 2, "version": 1}
    ]
    identifier = uuid4()
    models.VoiceprintSourceRemoval.objects.create(kind="record", source_uuid=identifier)
    data["sources"] = [
        {
            "kind": "record",
            "uuid": str(identifier),
            "session": str(uuid4()),
            "digest": "",
        }
    ]
    with pytest.raises(service.RecoveryError, match="scope_changed"):
        service.restore_snapshot(reader, request, sign_data(writer, data))
    assert not models.VoiceprintDeletionJob.objects.exists()
    assert models.VoiceprintSourceRemoval.objects.count() == 1


def test_source_removal_replays_digest_and_contribution_proof(keys, settings):
    writer, reader, _writer_path, _reader_path = keys
    profile = profile_for(UserFactory(), identify=True)
    baseline = activate(profile)
    samples = list(baseline.support_samples.all())
    removal.enroll(
        models.VoiceprintSample.objects.filter(pk=samples[0].pk), dispatch=False
    )
    job = models.VoiceprintContributionRemoval.objects.get(sample_uuid=samples[0].pk)
    track = models.VoiceprintSourceRemoval.objects.create(
        kind="track",
        source_uuid=uuid4(),
        track_digest=removal.track_digest("TR_synthetic"),
    )
    offline(settings)
    request = service.request_for(reader["deployment_id"])
    bundle = service.export_snapshot(writer, request)
    job.delete()
    track.delete()
    result = service.restore_snapshot(reader, request, bundle)
    assert result["sources"] == 1 and result["contributions"] == 1
    assert not models.VoiceprintSample.objects.filter(pk=samples[0].pk).exists()
    baseline.refresh_from_db()
    profile.refresh_from_db()
    assert not baseline.encrypted_vector and profile.status == "paused"
    assert models.VoiceprintSourceRemoval.objects.get(
        kind="track"
    ).track_digest == removal.track_digest("TR_synthetic")


def test_completed_receipt_does_not_exempt_restored_vector_without_sample(
    keys, settings
):
    writer, reader, _writer_path, _reader_path = keys
    profile = profile_for(UserFactory(), identify=True)
    baseline = activate(profile)
    vector, digest = bytes(baseline.encrypted_vector), baseline.support_digest
    sample = baseline.support_samples.first()
    removal.enroll(models.VoiceprintSample.objects.filter(pk=sample.pk), dispatch=False)
    job = models.VoiceprintContributionRemoval.objects.get(sample_uuid=sample.pk)
    assert removal.purge(job.pk) == "purged"
    models.VoiceprintContributionRemoval.objects.filter(pk=job.pk).update(
        status="complete"
    )
    offline(settings)
    request = service.request_for(reader["deployment_id"])
    bundle = service.export_snapshot(writer, request)
    models.VoiceprintTemplate.objects.filter(pk=baseline.pk).update(
        encrypted_vector=vector, support_digest=digest, status="active"
    )
    models.VoiceprintProfile.objects.filter(pk=profile.pk).update(status="active")
    assert not models.VoiceprintSample.objects.filter(pk=sample.pk).exists()
    result = service.restore_snapshot(reader, request, bundle)
    assert result["pending_template_rebuilds"] == 1
    baseline.refresh_from_db()
    profile.refresh_from_db()
    assert not baseline.encrypted_vector and profile.status == "paused"
    revision = baseline.revision
    service.restore_snapshot(reader, request, bundle)
    baseline.refresh_from_db()
    assert baseline.revision == revision


def test_replay_preserves_later_explicit_grant_and_new_generation(keys, settings):
    writer, reader, _writer_path, _reader_path = keys
    owner = UserFactory()
    profile = profile_for(owner, identify=True)
    activate(profile)
    response = delete(owner, profile)
    consent.purge_deleted(response.data["id"])
    offline(settings)
    request = service.request_for(reader["deployment_id"])
    bundle = service.export_snapshot(writer, request)
    profile.consent.refresh_from_db()
    settings.MEETING_VOICEPRINT_ENABLED = True
    granted = consent.update_settings(
        owner,
        organization_id=None,
        expected_version=profile.consent.version,
        changes={"allow_enrollment": True, "allow_identification": True},
    )
    renewed = consent.ensure_profile(
        owner,
        organization_id=None,
        expected_version=granted["version"],
    )
    fresh = activate(renewed)
    key, vector = bytes(renewed.encrypted_key), bytes(fresh.encrypted_vector)
    offline(settings)
    result = service.restore_snapshot(reader, request, bundle)
    assert result["permissions_restricted"] == 0
    renewed.refresh_from_db()
    fresh.refresh_from_db()
    assert renewed.generation == 2 and bytes(renewed.encrypted_key) == key
    assert bytes(fresh.encrypted_vector) == vector
    settings.MEETING_VOICEPRINT_ENABLED = True
    assert (
        consent.authorize_profile(renewed.pk, permission="allow_identification").pk
        == renewed.pk
    )


def test_already_denied_old_version_is_advanced_before_later_explicit_grant(
    keys, settings
):
    writer, reader, _writer_path, _reader_path = keys
    owner = UserFactory()
    profile = profile_for(owner, identify=True)
    activate(profile)
    for version, identify in ((1, False), (2, True), (3, False)):
        consent.update_settings(
            owner,
            organization_id=None,
            expected_version=version,
            changes={"allow_identification": identify},
        )
    offline(settings)
    request = service.request_for(reader["deployment_id"])
    bundle = service.export_snapshot(writer, request)
    models.VoiceprintConsentEvent.objects.filter(
        consent_id=profile.consent_id, version__gt=1
    ).delete()
    models.VoiceprintConsent.objects.filter(pk=profile.consent_id).update(version=1)
    result = service.restore_snapshot(reader, request, bundle)
    assert result["permissions_restricted"] == 0
    assert result["consent_versions_advanced"] == 1
    profile.consent.refresh_from_db()
    assert profile.consent.version > 4 and not profile.consent.allow_identification
    settings.MEETING_VOICEPRINT_ENABLED = True
    granted = consent.update_settings(
        owner,
        organization_id=None,
        expected_version=profile.consent.version,
        changes={"allow_identification": True},
    )
    offline(settings)
    repeated = service.restore_snapshot(reader, request, bundle)
    assert repeated["permissions_restricted"] == 0
    assert repeated["consent_versions_advanced"] == 0
    profile.consent.refresh_from_db()
    assert profile.consent.version == granted["version"]
    assert profile.consent.allow_identification
    settings.MEETING_VOICEPRINT_ENABLED = True
    assert (
        consent.authorize_profile(profile.pk, permission="allow_identification").pk
        == profile.pk
    )


@pytest.mark.parametrize("old_enabled", [False, True])
def test_old_organization_policy_preserves_later_explicit_enable(
    keys, settings, old_enabled
):
    writer, reader, _writer_path, _reader_path = keys
    owner = UserFactory()
    organization, _membership = org_for(owner, role=models.OrgRoleChoices.ADMIN)
    profile_for(owner, organization)
    models.Organization.objects.filter(pk=organization.pk).update(
        settings={"voiceprint": {"enabled": False, "version": 4}}
    )
    offline(settings)
    request = service.request_for(reader["deployment_id"])
    bundle = service.export_snapshot(writer, request)
    models.Organization.objects.filter(pk=organization.pk).update(
        settings={"voiceprint": {"enabled": old_enabled, "version": 1}}
    )
    result = service.restore_snapshot(reader, request, bundle)
    assert result["organization_policies_restricted"] == int(old_enabled)
    organization.refresh_from_db()
    policy = consent.organization_policy(organization)
    assert not policy["enabled"] and policy["version"] > 4
    settings.MEETING_VOICEPRINT_ENABLED = True
    granted = consent.update_organization_policy(
        owner,
        organization.pk,
        enabled=True,
        expected_version=policy["version"],
    )
    offline(settings)
    assert (
        service.restore_snapshot(reader, request, bundle)[
            "organization_policies_restricted"
        ]
        == 0
    )
    organization.refresh_from_db()
    assert consent.organization_policy(organization) == granted
