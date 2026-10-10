"""Trusted call admission to device matching, using synthetic PCM and RPC results."""

import copy
import hashlib
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

from django.db import close_old_connections
from django.utils import timezone

import pytest
from livekit import api

from core import models
from core.factories import MeetingSessionFactory, RoomFactory
from core.services import voiceprint_candidates as candidates
from core.services import voiceprint_consent as consent
from core.services import voiceprint_devices as devices
from core.services import voiceprint_enrollment as enrollment
from core.services import voiceprint_jobs as encoding
from core.services import voiceprint_quality as quality
from core.services import voiceprint_quality_jobs as checking
from core.services import voiceprint_sampling as sampling
from core.services import voiceprint_templates as templates
from core.services.voiceprint_crypto import load_keyring
from core.services.voiceprint_encoder import decode_result
from core.services.voiceprint_retention import expire_sample
from core.tests.services.test_voiceprint_enrollment import wav
from core.tests.services.test_voiceprint_sampling import Fixture, enabled
from core.tests.services.test_voiceprint_templates import (
    UNIT,
    contributions,
    decrypt_template,
)
from core.tests.test_services_voiceprint_encoder import output as encoder_output

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def feature(settings):
    settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED = True
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = True


@pytest.fixture
def prepared():
    fixture = Fixture()
    consent.update_settings(
        fixture.user,
        organization_id=None,
        expected_version=1,
        changes={"allow_identification": True},
    )
    fixture.control()
    profile = consent.ensure_profile(
        fixture.user, organization_id=None, expected_version=2
    )
    return fixture, profile


def connection(fixture, *, group="handset"):
    new = copy.copy(fixture)
    new.room = RoomFactory(organization=fixture.organization)
    new.session = MeetingSessionFactory(
        room=new.room, livekit_room_sid="RM_" + uuid4().hex
    )
    new.participant = models.MeetingParticipation.objects.create(
        session=new.session,
        user=new.user,
        livekit_participant_sid="PA_" + uuid4().hex,
        identity=str(new.user.sub),
        kind="standard",
        joined_at=timezone.now(),
    )
    new.track = sampling.record_track(
        participation=new.participant,
        track=api.TrackInfo(
            sid="TR_" + uuid4().hex,
            source=api.TrackSource.MICROPHONE,
            type=api.TrackType.AUDIO,
        ),
        published=True,
        event_at=timezone.now(),
    )
    new.control(device_group=group)
    return new


def capture(fixture, value, *, speech_ms=10000, vector=UNIT, confirm=True):
    grant = fixture.issue()
    receipt = sampling.ingest(
        UUID(grant["id"]),
        token=grant["token"],
        **fixture.wire(),
        wav=wav(value, seconds=10),
    )
    sample = models.VoiceprintSample.objects.get(pk=receipt["id"])
    lease = encoding.claim(sample.encoding_job.pk)
    result = encoder_output()
    result["input_sha256"] = lease.audio_digest
    result["vector"] = list(vector)
    result["quality"]["duration_ms"] = 10000
    assert encoding.finish(lease, result=decode_result(result, lease.audio_digest))
    sample.refresh_from_db()
    lease = checking.claim(sample.quality_job.pk)
    assert lease is not None
    assert checking.finish(
        lease,
        result={
            "policy": quality.QUERY_POLICY_VERSION,
            "model_id": quality.MODEL_ID,
            "input_sha256": lease.audio_digest,
            "passed": True,
            "reason": "passed",
            "valid_speech_ms": speech_ms,
            "speaker_count": 1,
        },
    )
    sample.refresh_from_db()
    if confirm:
        enrollment.decide(
            fixture.user,
            sample.pk,
            expected_version=sample.consent_version,
            accepted=True,
        )
        sample.refresh_from_db()
    return sample


def template(profile, group):
    return profile.templates.get(generation=profile.generation, device_group=group)


def call_baseline(prepared, *, count=3):
    fixture, profile = prepared
    samples = [capture(fixture, 100 + index) for index in range(count)]
    assert templates.build(profile.pk).status == "built"
    return fixture, profile, samples, template(profile, "headset")


def supplement(fixture, profile, *, count=3):
    first, second = connection(fixture), connection(fixture)
    samples = [
        capture(first if index < 2 else second, 200 + index) for index in range(count)
    ]
    assert templates.build(profile.pk).status == "built"
    return first, second, samples, template(profile, "handset")


@pytest.mark.parametrize(
    "count,speech_ms,confirmed", [(2, 10000, True), (3, 9000, True), (3, 10000, False)]
)
def test_first_call_baseline_requires_confirmed_independent_clips_and_effective_speech(
    prepared, count, speech_ms, confirmed
):
    fixture, profile = prepared
    for index in range(count):
        capture(fixture, 100 + index, speech_ms=speech_ms, confirm=confirmed)
    assert templates.build(profile.pk).status == "insufficient_audio"
    assert not consent.profile_ready(profile)
    assert not profile.templates.exists()


def test_first_call_baseline_uses_trusted_device_and_stays_stable(prepared):
    fixture, profile, samples, anchor = call_baseline(prepared)
    assert anchor.policy_version == devices.POLICY_VERSION
    assert anchor.basis["role"] == "baseline"
    assert decrypt_template(anchor) == pytest.approx(UNIT)
    profile = consent.authorize_profile(profile.pk, permission="allow_identification")
    assert consent.ready_device_groups(profile) == ["headset"]
    original = bytes(anchor.encrypted_vector)
    capture(fixture, 900)
    assert templates.build(profile.pk).status == "unchanged"
    anchor.refresh_from_db()
    assert bytes(anchor.encrypted_vector) == original and anchor.revision == 1
    assert set(anchor.support_samples.values_list("pk", flat=True)) == {
        row.pk for row in samples
    }


def test_new_device_requires_two_real_sessions_and_anchor_consistency(prepared):
    fixture, profile, _, anchor = call_baseline(prepared)
    first = connection(fixture)
    for index in range(3):
        capture(first, 200 + index)
    assert templates.build(profile.pk).status == "unchanged"
    assert not profile.templates.filter(device_group="handset").exists()
    capture(connection(fixture), 500)
    assert templates.build(profile.pk).status == "built"
    added = template(profile, "handset")
    assert added.basis == devices.anchor_basis(anchor)
    anchor.refresh_from_db()
    assert anchor.revision == 1 and added.support_samples.count() == 4
    assert consent.ready_device_groups(profile) == ["handset", "headset"]


def test_call_additions_to_legacy_enrollment_never_rewrite_the_baseline(prepared):
    fixture, profile = prepared
    contributions(profile)
    assert templates.build(profile.pk).status == "built"
    anchor = template(profile, "default")
    original = bytes(anchor.encrypted_vector)
    supplement(fixture, profile)
    anchor.refresh_from_db()
    assert anchor.policy_version == templates.POLICY_VERSION and anchor.basis == {}
    assert bytes(anchor.encrypted_vector) == original and anchor.revision == 1
    assert consent.ready_device_groups(profile) == ["default", "handset"]
    candidate, proof = candidates.artifact(
        profile, user_id=fixture.user.pk, organization_id=None
    )
    assert len(candidate.templates) == len(proof["templates"]) == 2


def test_incoherent_addition_is_quarantined_without_pausing_the_anchor(prepared):
    fixture, profile, _, anchor = call_baseline(prepared)
    first, second = connection(fixture), connection(fixture)
    opposite = (-1.0, *([0.0] * 1023))
    for index in range(3):
        capture(first if index < 2 else second, 200 + index, vector=opposite)
    assert templates.build(profile.pk).status == "unchanged"
    assert not profile.templates.filter(device_group="handset").exists()
    anchor.refresh_from_db()
    assert anchor.revision == 1 and consent.profile_ready(profile)


def test_clips_from_before_first_confirmation_do_not_become_supplements(prepared):
    fixture, profile = prepared
    first, second = connection(fixture), connection(fixture)
    for index in range(3):
        capture(first if index < 2 else second, 200 + index)
    # Prefer the enrollment baseline and reject call additions captured before it.
    contributions(profile)
    assert templates.build(profile.pk).status == "built"
    assert consent.ready_device_groups(profile) == ["default"]
    assert not profile.templates.filter(device_group="handset").exists()


def test_late_confirmation_of_old_clips_cannot_crowd_out_post_baseline_evidence(
    prepared, monkeypatch
):
    fixture, profile = prepared
    old_connection = connection(fixture)
    old = [capture(old_connection, 700 + index, confirm=False) for index in range(3)]
    contributions(profile)
    assert templates.build(profile.pk).status == "built"
    first, second = connection(fixture), connection(fixture)
    newer = [capture(first if index < 2 else second, 800 + index) for index in range(3)]
    for sample in old:
        enrollment.decide(fixture.user, sample.pk, expected_version=2, accepted=True)
    # A reduced contribution bound exposes selection order with fewer private fixtures.
    monkeypatch.setattr(templates, "MAX_SUPPORT_SAMPLES", 3)
    assert templates.build(profile.pk).status == "built"
    assert set(
        template(profile, "handset").support_samples.values_list("pk", flat=True)
    ) == {row.pk for row in newer}


@pytest.mark.parametrize("permission", ["allow_enrollment", "allow_accumulation"])
def test_stopping_new_samples_preserves_confirmed_call_identification(
    prepared, permission
):
    fixture, profile, _, _ = call_baseline(prepared)
    consent.update_settings(
        fixture.user,
        organization_id=None,
        expected_version=2,
        changes={permission: False},
    )
    assert templates.build(profile.pk).status == "unchanged"
    assert consent.authorize_profile(profile.pk, permission="allow_identification")


@pytest.mark.parametrize(
    "field,value",
    [
        ("device_group", "computer"),
        ("control_revision", 9),
        ("livekit_room_sid", "RM_changed"),
    ],
)
def test_receipt_edits_invalidate_the_sealed_call_feature_and_active_template(
    prepared, field, value
):
    _, profile, samples, _ = call_baseline(prepared)
    models.VoiceprintSamplingPermit.objects.filter(sample=samples[0]).update(
        **{field: value}
    )
    assert not consent.profile_ready(profile)
    assert templates.build(profile.pk).status in {
        "invalid_contributions",
        "insufficient_audio",
    }
    profile.refresh_from_db()
    assert profile.status == "paused"


def test_receipt_edit_during_encoding_invalidates_the_running_lease(prepared):
    fixture, _ = prepared
    grant = fixture.issue()
    receipt = sampling.ingest(
        UUID(grant["id"]),
        token=grant["token"],
        **fixture.wire(),
        wav=wav(111, seconds=10),
    )
    sample = models.VoiceprintSample.objects.get(pk=receipt["id"])
    lease = encoding.claim(sample.encoding_job.pk)
    models.VoiceprintSamplingPermit.objects.filter(sample=sample).update(
        device_group="handset"
    )
    assert not encoding.authorized(lease)
    assert not encoding.finish(lease, error=RuntimeError("private fixture diagnostic"))
    sample.refresh_from_db()
    assert sample.status == "rejected" and not sample.encrypted_embedding


def test_deleted_supplement_origin_is_excluded_immediately_and_rebuilds_survivors(
    prepared,
):
    fixture, profile, _, anchor = call_baseline(prepared)
    first, second, samples, added = supplement(fixture, profile, count=4)
    old_cipher = bytes(added.encrypted_vector)
    # Delete a track, not the whole session, leaving two independent sessions.
    models.VoiceprintSamplingTrack.objects.get(pk=first.track.pk).delete()
    assert consent.ready_device_groups(profile) == ["headset"]
    candidate, _ = candidates.artifact(
        profile, user_id=fixture.user.pk, organization_id=None
    )
    assert len(candidate.templates) == 1
    assert templates.build(profile.pk).status == "unchanged"
    added.refresh_from_db()
    assert added.status == "paused"
    # Two lost contributions need replacements from a fresh independent session.
    replacement = connection(fixture)
    capture(replacement, 600)
    assert templates.build(profile.pk).status == "built"
    added.refresh_from_db()
    assert added.status == "active" and added.support_samples.count() == 3
    assert bytes(added.encrypted_vector) != old_cipher
    anchor.refresh_from_db()
    assert anchor.revision == 1 and templates.valid_baseline(anchor, profile)


def test_baseline_source_deletion_rebuilds_and_rebinds_all_supplements(prepared):
    fixture, profile, samples, anchor = call_baseline(prepared, count=4)
    _, _, _, added = supplement(fixture, profile)
    old_cipher, old_basis = bytes(added.encrypted_vector), added.basis
    # Delete one actual admitted contribution; surviving owner decisions suffice.
    samples[0].delete()
    assert consent.ready_device_groups(profile) == []
    assert templates.build(profile.pk).status == "built"
    anchor.refresh_from_db()
    added.refresh_from_db()
    assert anchor.support_samples.count() == 3 and anchor.revision > 1
    assert added.basis != old_basis and added.basis == devices.anchor_basis(anchor)
    assert bytes(added.encrypted_vector) != old_cipher
    assert consent.ready_device_groups(profile) == ["handset", "headset"]
    added.encrypted_vector = old_cipher
    added.save()
    assert consent.ready_device_groups(profile) == ["headset"]


@pytest.mark.parametrize(
    "mutation", ["bad_anchor", "old_revision", "cycle", "device", "missing_anchor"]
)
def test_bad_supplement_basis_never_enters_candidate_matching(prepared, mutation):
    fixture, profile, _, anchor = call_baseline(prepared)
    _, _, _, added = supplement(fixture, profile)
    if mutation == "bad_anchor":
        added.basis["baseline_id"] = "invalid-uuid"
    elif mutation == "old_revision":
        added.basis["baseline_revision"] = 0
    elif mutation == "cycle":
        added.basis["baseline_id"] = str(added.pk)
    elif mutation == "device":
        added.device_group = "computer"
    else:
        anchor.delete()
    added.save()
    assert not templates.valid_baseline(added, profile)
    assert consent.ready_device_groups(profile) == (
        [] if mutation == "missing_anchor" else ["headset"]
    )


def test_audio_retention_and_normal_call_end_preserve_confirmed_features(prepared):
    fixture, profile, samples, _ = call_baseline(prepared)
    sampling.update_control(
        fixture.user,
        session_id=fixture.session.pk,
        participant_sid=fixture.participant.livekit_participant_sid,
        expected_revision=1,
        paused=True,
        shared_microphone=False,
        device_group="headset",
    )
    fixture.session.status = "ended"
    fixture.session.ended_at = timezone.now()
    fixture.session.end_reason = "room_finished"
    fixture.session.save()
    for sample in samples:
        models.VoiceprintSample.objects.filter(pk=sample.pk).update(
            expires_at=timezone.now() - timezone.timedelta(seconds=1)
        )
        expire_sample(sample.pk)
    assert consent.profile_ready(profile)
    assert templates.build(profile.pk).status == "unchanged"


@pytest.mark.parametrize("permission", ["allow_enrollment", "allow_accumulation"])
def test_source_cleanup_rebuilds_confirmed_survivors_after_new_sampling_is_disabled(
    prepared, permission
):
    fixture, profile, samples, anchor = call_baseline(prepared, count=4)
    boundary = devices.confirmed_at(anchor)
    consent.update_settings(
        fixture.user,
        organization_id=None,
        expected_version=2,
        changes={permission: False},
    )
    # Removing the latest clip must not move the original confirmation boundary backwards.
    samples[-1].delete()
    assert templates.build(profile.pk).status == "built"
    anchor.refresh_from_db()
    assert devices.confirmed_at(anchor) == boundary
    assert anchor.support_samples.count() == 3
    assert consent.authorize_profile(profile.pk, permission="allow_identification")


def test_source_session_deletion_pauses_all_dependent_groups_without_promoting_a_supplement(
    prepared,
):
    fixture, profile, _, _ = call_baseline(prepared)
    supplement(fixture, profile)
    fixture.session.delete()
    assert consent.ready_device_groups(profile) == []
    assert templates.build(profile.pk).status == "insufficient_audio"
    profile.refresh_from_db()
    assert profile.status == "paused"
    assert not profile.templates.filter(status="active").exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_call_template_builds_have_one_stable_baseline(prepared):
    fixture, profile = prepared
    for index in range(3):
        capture(fixture, 100 + index)

    def build(_):
        close_old_connections()
        try:
            return templates.build(profile.pk).status
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(build, range(2)))
    assert "built" in outcomes
    assert profile.templates.count() == 1 and template(profile, "headset").revision == 1
    assert consent.profile_ready(profile)
