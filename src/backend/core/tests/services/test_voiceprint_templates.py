"""Synthetic state/crypto/concurrency checks; no human identity calibration."""

import io
import json
import math
import struct
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import voiceprint_consent as consent
from core.services import voiceprint_templates as service
from core.services.voiceprint_crypto import load_keyring
from core.services.voiceprint_vectors import (
    aggregate,
    cosine,
    decode_vector,
    read_sample_vector,
    sample_payload,
    sample_prefix,
    unit_vector,
)
from core.tests.services.test_voiceprint_consent import (
    change,
    delete,
    enabled,
    org_for,
    profile_for,
    sample_for,
)

pytestmark = pytest.mark.django_db
UNIT = (1.0, *([0.0] * 1023))


@pytest.fixture(autouse=True)
def template_enabled(settings, enabled):
    settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED = True


@pytest.fixture
def profile():
    return profile_for(UserFactory(), identify=True)


def reseal(sample, vector=UNIT):
    sample.encrypted_embedding = load_keyring().encrypt(
        sample.profile,
        sample_payload(sample, vector),
        kind="embedding",
        object_id=sample.pk,
    )
    sample.save()
    return sample


def contributions(profile, *, count=3, speech_ms=10000):
    samples = [sample_for(profile, ready=True) for _ in range(count)]
    for sample in samples:
        sample.quality["valid_speech_ms"] = speech_ms
        reseal(sample)
    return samples


def current_template(profile):
    return profile.templates.get(generation=profile.generation, device_group="default")


def decrypt_template(template):
    return service.read_template(
        template,
        load_keyring().decrypt(
            template.profile,
            template.encrypted_vector,
            kind="template",
            object_id=template.pk,
        ),
    )


@pytest.mark.parametrize(
    "flag", ["MEETING_VOICEPRINT_ENABLED", "MEETING_VOICEPRINT_TEMPLATES_ENABLED"]
)
def test_feature_flags_never_promote_or_touch_profiles(profile, settings, flag):
    contributions(profile)
    setattr(settings, flag, False)
    assert service.build(profile.pk).status == "disabled"
    profile.refresh_from_db()
    assert profile.status == "pending" and profile.template_checked_at is None
    assert not profile.templates.exists()


def test_confirmations_build_private_stable_baseline_without_enabling_permissions(
    profile,
):
    samples = contributions(profile)
    result = service.build(profile.pk)
    assert result.status == "built" and result.revision == 1
    template = current_template(profile)
    clear = load_keyring().decrypt(
        profile, template.encrypted_vector, kind="template", object_id=template.pk
    )
    assert clear.startswith(b"VPT1") and bytes(template.encrypted_vector) != clear
    assert decrypt_template(template) == pytest.approx(UNIT)
    assert set(template.support_samples.values_list("pk", flat=True)) == {
        row.pk for row in samples
    }
    assert consent.authorize_profile(profile.pk, permission="allow_identification")
    profile.refresh_from_db()
    profile.consent.refresh_from_db()
    assert profile.status == "active" and profile.template_checked_at
    assert not profile.consent.allow_accumulation
    assert profile.consent.version == 1
    original = bytes(template.encrypted_vector)
    contributions(profile, count=13)
    assert service.build(profile.pk) == service.BuildResult("unchanged", template.pk, 1)
    template.refresh_from_db()
    assert bytes(template.encrypted_vector) == original
    assert consent.profile_ready(profile)


@pytest.mark.parametrize(
    "count,speech_ms,expected",
    [
        (2, 10000, "insufficient_audio"),
        (3, 9000, "insufficient_audio"),
        (4, 8000, "built"),
    ],
)
def test_total_valid_speech_and_distinct_clip_count_are_required(
    profile, count, speech_ms, expected
):
    contributions(profile, count=count, speech_ms=speech_ms)
    assert service.build(profile.pk).status == expected
    assert consent.profile_ready(profile) is (expected == "built")


@pytest.mark.parametrize(
    "damage",
    [
        "no_decision",
        "rejected_decision",
        "foreign_owner",
        "decision_generation",
        "decision_version",
        "unconfirmed",
        "quality_pending",
        "old_generation",
        "duplicate_audio",
        "invalid_digest",
        "bad_permit",
        "call_source",
        "old_confirmation",
        "future_confirmation",
        "expired_confirmation",
        "wrong_org",
        "foreign_enrollment_owner",
        "missing_enrollment",
        "enrollment_version",
        "missing_embedding",
    ],
)
def test_metadata_and_owner_proofs_are_all_required(profile, damage):  # noqa: PLR0912, PLR0915 -- Explicit independent corruption cases.
    samples = contributions(profile)
    sample = samples[0]
    decision = sample.owner_decision
    if damage == "no_decision":
        decision.delete()
    elif damage in {
        "rejected_decision",
        "foreign_owner",
        "decision_generation",
        "decision_version",
    }:
        if damage == "rejected_decision":
            decision.accepted = False
        elif damage == "foreign_owner":
            decision.owner_id = uuid4()
        elif damage == "decision_generation":
            decision.generation += 1
        else:
            decision.consent_version += 1
        decision.save()
    elif damage in {"wrong_org", "foreign_enrollment_owner", "enrollment_version"}:
        if damage == "wrong_org":
            sample.enrollment.organization_id = uuid4()
        elif damage == "foreign_enrollment_owner":
            sample.enrollment.owner_id = uuid4()
        else:
            sample.enrollment.consent_version += 1
        sample.enrollment.save()
    else:
        if damage == "unconfirmed":
            sample.status = "ready"
        elif damage == "quality_pending":
            sample.quality["speech_checked"] = False
        elif damage == "old_generation":
            sample.generation += 1
        elif damage == "duplicate_audio":
            sample.audio_sha256 = samples[1].audio_sha256
        elif damage == "invalid_digest":
            sample.audio_sha256 = "z" * 64
        elif damage == "bad_permit":
            sample.permit_id = uuid4()
        elif damage == "call_source":
            sample.source_type = "call"
        elif damage == "old_confirmation":
            sample.confirmed_at = timezone.now() - timedelta(days=366)
        elif damage == "future_confirmation":
            sample.confirmed_at = timezone.now() + timedelta(minutes=1)
        elif damage == "expired_confirmation":
            sample.confirmed_at = sample.created_at + timedelta(hours=25)
        elif damage == "missing_enrollment":
            sample.enrollment = None
        else:
            sample.encrypted_embedding = b""
        sample.save()
    assert service.build(profile.pk).status == "insufficient_audio"
    profile.refresh_from_db()
    assert profile.status == "pending" and not profile.templates.exists()


@pytest.mark.parametrize(
    "damage",
    [
        "audio",
        "track",
        "interval",
        "quality",
        "legacy_raw",
        "bad_cipher",
        "copied_cipher",
        "nonfinite",
        "wrong_norm",
    ],
)
def test_features_authenticate_the_source_and_quality_without_legacy_fallback(
    profile, damage
):
    samples = contributions(profile)
    sample = samples[0]
    if damage == "audio":
        sample.audio_sha256 = uuid4().hex * 2
    elif damage == "track":
        sample.source_track = "different-track"
    elif damage == "interval":
        sample.start_ms, sample.end_ms = 100, 10100
    elif damage == "quality":
        sample.quality["unchecked_external_flag"] = True
    elif damage == "bad_cipher":
        sample.encrypted_embedding = b"invalid ciphertext"
    elif damage == "copied_cipher":
        sample.encrypted_embedding = samples[1].encrypted_embedding
    else:
        clear = struct.pack("<1024f", *UNIT)
        if damage != "legacy_raw":
            clear = sample_prefix(sample) + struct.pack(
                "<1024f",
                float("nan") if damage == "nonfinite" else 0.0,
                *([0.0] * 1023),
            )
        sample.encrypted_embedding = load_keyring().encrypt(
            profile, clear, kind="embedding", object_id=sample.pk
        )
    sample.save()
    assert service.build(profile.pk).status == "invalid_contributions"
    assert not profile.templates.exists()


def test_mixed_features_cannot_be_accepted_by_majority_vote(profile):
    samples = contributions(profile, count=6)
    reseal(samples[0], (-1.0, *([0.0] * 1023)))
    assert service.build(profile.pk).status == "mixed_speaker"
    assert not profile.templates.exists()
    profile.refresh_from_db()
    assert profile.status == "pending"


def test_aggregate_has_unit_norm_and_equal_clip_weights(profile):
    samples = contributions(profile, count=4, speech_ms=8000)
    other = (0.98, math.sqrt(1 - 0.98**2), *([0.0] * 1022))
    reseal(samples[0], other)
    assert service.build(profile.pk).status == "built"
    expected = unit_vector(tuple(3 * a + b for a, b in zip(UNIT, other, strict=True)))
    assert decrypt_template(current_template(profile)) == pytest.approx(
        expected, abs=1e-7
    )


@pytest.mark.parametrize(
    "field", ["revision", "policy_version", "support_digest", "dimension"]
)
def test_template_metadata_and_old_revision_replay_cannot_authorize(profile, field):
    contributions(profile)
    assert service.build(profile.pk).status == "built"
    template = current_template(profile)
    setattr(
        template,
        field,
        getattr(template, field) + 1
        if field in {"revision", "dimension"}
        else "changed",
    )
    template.save()
    with pytest.raises(consent.VoiceprintError, match="voiceprint_profile_not_ready"):
        consent.authorize_profile(profile.pk, permission="allow_identification")


def test_invalid_support_is_paused_then_rebuilt_from_survivors_with_new_proof(profile):
    samples = contributions(profile, count=4)
    assert service.build(profile.pk).status == "built"
    template = current_template(profile)
    previous_cipher, previous_digest = (
        bytes(template.encrypted_vector),
        template.support_digest,
    )
    samples[0].status = "deleted"
    samples[0].encrypted_embedding = b""
    samples[0].save()
    assert not consent.profile_ready(profile)
    result = service.build(profile.pk)
    assert (
        result.status == "built"
        and result.template_id == template.pk
        and result.revision > 1
    )
    template.refresh_from_db()
    assert (
        template.support_samples.count() == 3
        and template.support_digest != previous_digest
    )
    assert consent.profile_ready(profile)
    template.encrypted_vector = previous_cipher
    template.save()
    assert not consent.profile_ready(profile)


def test_insufficient_survivors_pause_without_fabricating_a_replacement(profile):
    samples = contributions(profile)
    service.build(profile.pk)
    models.VoiceprintSample.objects.filter(pk=samples[0].pk).update(
        status="deleted", encrypted_embedding=b""
    )
    assert service.build(profile.pk).status == "insufficient_audio"
    profile.refresh_from_db()
    assert profile.status == "paused" and current_template(profile).status == "paused"


def test_source_metadata_change_invalidates_existing_proof_immediately(profile):
    samples = contributions(profile)
    service.build(profile.pk)
    models.VoiceprintSample.objects.filter(pk=samples[0].pk).update(
        source_track="modified"
    )
    assert not consent.profile_ready(profile)
    assert service.build(profile.pk).status == "invalid_contributions"
    profile.refresh_from_db()
    assert profile.status == "paused"


def test_audio_ttl_does_not_destroy_confirmed_baseline(profile):
    contributions(profile)
    service.build(profile.pk)
    profile.samples.update(
        encrypted_audio=b"", expires_at=timezone.now() - timedelta(hours=1)
    )
    assert consent.profile_ready(profile)
    assert service.build(profile.pk).status == "unchanged"


def test_disabling_new_enrollment_preserves_independent_identification(profile):
    contributions(profile)
    service.build(profile.pk)
    user = profile.consent.user
    assert change(user, version=1, allow_enrollment=False).status_code == 200
    assert service.build(profile.pk).status == "unchanged"
    assert consent.authorize_profile(profile.pk, permission="allow_identification")
    output = io.StringIO()
    call_command("build_voiceprint_templates", limit=1, stdout=output)
    assert json.loads(output.getvalue())["unchanged"] == 1


def test_revocation_and_reenrollment_cannot_reuse_old_contributions(profile):
    contributions(profile)
    service.build(profile.pk)
    user = profile.consent.user
    assert delete(user, profile).status_code == 202
    assert service.build(profile.pk).status == "unavailable"
    assert change(user, version=2, allow_enrollment=True).status_code == 200
    replacement = consent.ensure_profile(user, organization_id=None, expected_version=3)
    assert replacement.pk == profile.pk and replacement.generation > profile.generation
    assert service.build(replacement.pk).status == "insufficient_audio"
    contributions(replacement)
    assert service.build(replacement.pk).status == "built"
    assert replacement.templates.filter(status="active").count() == 1


def test_organization_pause_rejects_existing_template_and_prevents_rebuild():
    user = UserFactory()
    organization, _ = org_for(user)
    profile = profile_for(user, organization, identify=True)
    contributions(profile)
    assert service.build(profile.pk).status == "built"
    organization.settings = {"voiceprint": {"enabled": False, "version": 2}}
    organization.save()
    assert service.build(profile.pk).status == "unavailable"
    profile.refresh_from_db()
    assert profile.status == "paused" and not consent.profile_ready(profile)


def test_bounded_batches_are_fair_and_emit_only_aggregate_statuses(settings):
    first, second = [profile_for(UserFactory()) for _ in range(2)]
    output = io.StringIO()
    settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED = False
    call_command("build_voiceprint_templates", limit=1, stdout=output)
    assert json.loads(output.getvalue())["enabled"] is False
    assert not models.VoiceprintProfile.objects.filter(
        template_checked_at__isnull=False
    ).exists()
    settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED = True
    for _ in range(2):
        output = io.StringIO()
        call_command("build_voiceprint_templates", limit=1, stdout=output)
        body = json.loads(output.getvalue())
        assert body["insufficient_audio"] == 1 and body["enabled"]
        assert (
            str(first.pk) not in output.getvalue()
            and str(second.pk) not in output.getvalue()
        )
    assert (
        models.VoiceprintProfile.objects.filter(
            template_checked_at__isnull=False
        ).count()
        == 2
    )
    with pytest.raises(CommandError):
        call_command("build_voiceprint_templates", limit=101)


@pytest.mark.django_db(transaction=True)
def test_concurrent_builders_never_create_duplicate_artifacts(profile):
    contributions(profile)

    def run():
        close_old_connections()
        try:
            return service.build(profile.pk).status
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: run(), range(2)))
    assert "built" in results and set(results) <= {"built", "unchanged", "unavailable"}
    assert profile.templates.count() == 1 and current_template(profile).revision == 1
    assert consent.profile_ready(profile)


@pytest.mark.parametrize(
    "values",
    [
        [],
        [0.0] * 1024,
        [True] * 1024,
        [float("nan")] * 1024,
        [float("inf")] * 1024,
        [1e300] * 1024,
        [10**500] * 1024,
    ],
)
def test_numeric_rejection_is_finite_and_has_stable_errors(values):
    with pytest.raises(consent.VoiceprintError, match="voiceprint_vector_invalid"):
        unit_vector(values)


def test_vector_decoder_does_not_silently_normalize_bad_encoded_results():
    for clear in (b"", struct.pack("<1024f", *([2.0] * 1024))):
        with pytest.raises(consent.VoiceprintError, match="voiceprint_vector_invalid"):
            decode_vector(clear)
    with pytest.raises(consent.VoiceprintError, match="voiceprint_vector_invalid"):
        cosine(UNIT, [float("nan")] * 1024)
    with pytest.raises(
        consent.VoiceprintError, match="voiceprint_contributions_invalid"
    ):
        aggregate([UNIT, UNIT])


def test_signal_only_quality_cannot_be_promoted_by_editing_booleans(profile):
    sample = sample_for(profile, ready=True)
    sample.quality = {
        **sample.quality,
        "speech_checked": False,
        "speaker_consistency_checked": False,
        "valid_speech_ms": 0,
    }
    reseal(sample)
    sample.quality = {
        **sample.quality,
        "speech_checked": True,
        "speaker_consistency_checked": True,
        "valid_speech_ms": 10000,
    }
    sample.save()
    clear = load_keyring().decrypt(
        profile, sample.encrypted_embedding, kind="embedding", object_id=sample.pk
    )
    with pytest.raises(consent.VoiceprintError, match="voiceprint_vector_invalid"):
        read_sample_vector(sample, clear)
    contributions(profile, count=2)
    assert service.build(profile.pk).status == "invalid_contributions"


def test_rebuilding_repairs_a_corrupt_dimension_without_reusing_old_payload(profile):
    contributions(profile)
    service.build(profile.pk)
    template = current_template(profile)
    models.VoiceprintTemplate.objects.filter(pk=template.pk).update(dimension=192)
    assert service.build(profile.pk).status == "built"
    template.refresh_from_db()
    assert template.dimension == 1024 and template.revision > 1
    assert consent.profile_ready(profile)


def test_template_support_cannot_be_extended_with_new_unsigned_contributions(profile):
    contributions(profile)
    service.build(profile.pk)
    template = current_template(profile)
    extra = contributions(profile, count=10)
    template.support_samples.add(*extra)
    assert not consent.profile_ready(profile)
    assert service.build(profile.pk).status == "built"
    template.refresh_from_db()
    assert template.support_samples.count() == service.MAX_SUPPORT_SAMPLES
    assert consent.profile_ready(profile)


def test_cross_owner_template_ciphertext_never_authorizes(profile):
    other = profile_for(UserFactory(), identify=True)
    for row in (profile, other):
        contributions(row)
        service.build(row.pk)
    original, foreign = current_template(profile), current_template(other)
    original.encrypted_vector = foreign.encrypted_vector
    original.save()
    assert not consent.profile_ready(profile)
    assert consent.profile_ready(other)
