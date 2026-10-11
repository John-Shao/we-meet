"""Real database/crypto candidate boundaries; only synthetic voices/vectors."""

import json
from dataclasses import asdict, replace
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from django.utils import timezone

import pytest

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services import voiceprint_candidates as service
from core.services import voiceprint_consent as consent
from core.services import voiceprint_matching as matching
from core.services import voiceprint_templates as templates
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_crypto import Keyring
from core.tests.services.test_meeting_records import audio_note
from core.tests.services.test_voiceprint_consent import (
    change,
    delete,
    enabled,
    org_for,
    profile_for,
)
from core.tests.services.test_voiceprint_templates import (
    contributions,
    current_template,
    reseal,
)
from core.tests.test_services_voiceprint_matching import clips, policy, vector

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def matching_enabled(settings, enabled, tmp_path):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = True
    settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED = True
    path = tmp_path / "synthetic-policy-only.json"
    path.write_text(json.dumps(asdict(policy())))
    settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE = str(path)


def register(user, organization=None, *, angle=0):
    profile = profile_for(user, organization, identify=True)
    for sample in contributions(profile):
        reseal(sample, vector(angle))
    assert templates.build(profile.pk).status == "built"
    profile.refresh_from_db()
    return profile


def org_record():
    actor = UserFactory()
    organization, _ = org_for(actor)
    record = audio_note(actor, organization)
    return actor, record, organization


def member_profile(organization, *, angle=0):
    member = MembershipFactory(organization=organization).user
    return member, register(member, organization, angle=angle)


def pool(actor, record, users, organization=None):
    return service.load_pool(
        record,
        actor,
        organization_id=organization.pk if organization else None,
        user_ids=[user.pk for user in users],
        expected_revision=record.revision,
    )


def test_explicit_pool_never_silently_adds_other_registered_members_or_personal_profiles():
    actor, record, org = org_record()
    member, profile = member_profile(org)
    other, _ = member_profile(org)
    register(member)  # A different template in the personal scope is irrelevant.
    snapshot = pool(actor, record, [member], org)
    assert [candidate.user_id for candidate in snapshot.candidates] == [member.pk]
    assert snapshot.requested == (member.pk,)
    assert other.pk not in snapshot.requested
    assert service.revalidate(snapshot)
    assert str(member.pk) not in repr(snapshot) and "candidates=" not in repr(snapshot)
    assert len(snapshot.fingerprint) == 64
    assert profile.samples.filter(status="confirmed").count() == 3


def test_order_is_canonical_and_missing_templates_do_not_expand_the_selected_pool():
    actor, record, org = org_record()
    member, _ = member_profile(org)
    not_registered = MembershipFactory(organization=org).user
    first = pool(actor, record, [member, not_registered], org)
    second = pool(actor, record, [not_registered, member], org)
    assert first.fingerprint == second.fingerprint
    assert len(first.candidates) == 1 and set(first.requested) == {
        member.pk,
        not_registered.pk,
    }


def test_personal_scope_only_allows_the_current_editor_to_identify_themself():
    actor, other = UserFactory(), UserFactory()
    record = audio_note(actor)
    register(actor)
    register(other)
    assert pool(actor, record, [actor]).candidates[0].user_id == actor.pk
    with pytest.raises(VoiceprintError, match="voiceprint_candidate_scope_unavailable"):
        pool(actor, record, [other])
    with pytest.raises(VoiceprintError, match="voiceprint_candidate_scope_unavailable"):
        pool(actor, record, [actor, other])


def test_personal_record_can_explicitly_select_one_shared_organization():
    actor, record, org = org_record()
    record = audio_note(actor)
    member, _ = member_profile(org)
    assert pool(actor, record, [member], org).candidates[0].user_id == member.pk
    with pytest.raises(VoiceprintError, match="voiceprint_candidate_scope_unavailable"):
        pool(actor, record, [member])


def test_org_record_cannot_use_a_different_or_personal_library_even_for_same_account():
    actor, record, org = org_record()
    other_org, _ = org_for(actor)
    register(actor, org)
    register(actor, other_org)
    register(actor)
    for selected in (other_org, None):
        with pytest.raises(
            VoiceprintError, match="voiceprint_candidate_scope_unavailable"
        ):
            pool(actor, record, [actor], selected)


def test_outside_member_and_external_contact_do_not_grant_template_access(monkeypatch):
    actor, record, org = org_record()
    outsider, _ = member_profile(
        OrganizationFactory(settings={"voiceprint": {"enabled": True, "version": 1}})
    )
    models.ExternalContact.objects.create(
        user_a=actor, user_b=outsider, requested_by=actor, status="accepted"
    )
    monkeypatch.setattr(
        Keyring,
        "decrypt",
        lambda *_args, **_kwargs: pytest.fail("scope must reject before decryption"),
    )
    with pytest.raises(VoiceprintError, match="voiceprint_candidate_scope_unavailable"):
        pool(actor, record, [outsider], org)


@pytest.mark.parametrize("damage", ["left", "inactive", "device"])
def test_candidates_must_be_current_active_human_members(damage, monkeypatch):
    actor, record, org = org_record()
    member, _ = member_profile(org)
    if damage == "left":
        models.Membership.objects.filter(user=member, organization=org).update(
            status="left"
        )
    else:
        models.User.objects.filter(pk=member.pk).update(
            **{"is_active" if damage == "inactive" else "is_device": damage == "device"}
        )
    monkeypatch.setattr(
        Keyring,
        "decrypt",
        lambda *_args, **_kwargs: pytest.fail(
            "ineligible member must not be decrypted"
        ),
    )
    with pytest.raises(VoiceprintError, match="voiceprint_candidate_scope_unavailable"):
        pool(actor, record, [member], org)


def test_no_identification_permission_rejects_before_any_private_decryption(
    monkeypatch,
):
    actor, record, org = org_record()
    member, _ = member_profile(org)
    assert change(member, org, version=1, allow_identification=False).status_code == 200
    monkeypatch.setattr(
        Keyring,
        "decrypt",
        lambda *_args, **_kwargs: pytest.fail("revoked voice must not be decrypted"),
    )
    snapshot = pool(actor, record, [member], org)
    assert not snapshot.candidates and snapshot.requested == (member.pk,)


def test_requester_current_membership_is_required_even_when_they_own_the_record():
    actor, record, org = org_record()
    member, _ = member_profile(org)
    models.Membership.objects.filter(user=actor, organization=org).delete()
    with pytest.raises(PermissionError, match="Only current"):
        pool(actor, record, [member], org)


def test_an_editorial_contact_permission_does_not_grant_access_to_other_peoples_records():
    actor, record, org = org_record()
    member, _ = member_profile(org)
    with pytest.raises(PermissionError):
        pool(member, record, [member], org)


@pytest.mark.parametrize(
    "damage",
    ["org_disabled", "org_inactive", "actor_inactive", "record_deleted", "revision"],
)
def test_old_python_objects_are_not_authorization(damage):
    actor, record, org = org_record()
    member, _ = member_profile(org)
    snapshot = pool(actor, record, [member], org)
    mutations = {
        "org_disabled": lambda: models.Organization.objects.filter(pk=org.pk).update(
            settings={"voiceprint": {"enabled": False, "version": 2}}
        ),
        "org_inactive": lambda: models.Organization.objects.filter(pk=org.pk).update(
            is_active=False
        ),
        "actor_inactive": lambda: models.User.objects.filter(pk=actor.pk).update(
            is_active=False
        ),
        "record_deleted": lambda: models.MeetingRecord.objects.filter(
            pk=record.pk
        ).update(deleted_at=timezone.now()),
        "revision": lambda: models.MeetingRecord.objects.filter(pk=record.pk).update(
            revision=record.revision + 1
        ),
    }
    mutations[damage]()
    assert not service.revalidate(snapshot)


@pytest.mark.parametrize(
    "damage",
    ["permission", "template", "support", "metadata", "deletion", "age", "tombstone"],
)
def test_old_candidate_snapshot_cannot_survive_revocation_or_artifact_changes(damage):
    actor, record, org = org_record()
    member, profile = member_profile(org)
    snapshot = pool(actor, record, [member], org)
    template = current_template(profile)
    mutations = {
        "permission": lambda: change(
            member, org, version=1, allow_identification=False
        ),
        "template": lambda: models.VoiceprintTemplate.objects.filter(
            pk=template.pk
        ).update(encrypted_vector=b"bad old artifact"),
        "support": lambda: template.support_samples.remove(
            template.support_samples.first()
        ),
        "metadata": lambda: models.VoiceprintSample.objects.filter(
            pk=template.support_samples.first().pk
        ).update(quality={"speech_checked": True}),
        "deletion": lambda: delete(member, profile),
        "age": lambda: models.VoiceprintProfile.objects.filter(pk=profile.pk).update(
            last_updated_at=timezone.now() - timedelta(days=366)
        ),
        "tombstone": lambda: models.VoiceprintDeletionJob.objects.create(
            owner_id=member.pk,
            organization_id=org.pk,
            expected_version=profile.consent.version,
            revoked_generation=profile.generation + 1,
            request_key=uuid4(),
        ),
    }
    mutations[damage]()
    assert not service.revalidate(snapshot)


def test_harmless_permission_version_change_still_invalidates_a_queued_snapshot():
    actor, record, org = org_record()
    member, _ = member_profile(org)
    snapshot = pool(actor, record, [member], org)
    assert change(member, org, version=1, allow_accumulation=True).status_code == 200
    assert not service.revalidate(snapshot)
    assert len(pool(actor, record, [member], org).candidates) == 1


def test_a_previously_unregistered_candidate_becoming_ready_invalidates_old_margin():
    actor, record, org = org_record()
    member, _ = member_profile(org)
    other = MembershipFactory(organization=org).user
    snapshot = pool(actor, record, [member, other], org)
    register(other, org)
    assert not service.revalidate(snapshot)
    assert len(pool(actor, record, [member, other], org).candidates) == 2


def test_even_unregistered_candidate_permission_epochs_are_bound():
    actor, record, org = org_record()
    member, _ = member_profile(org)
    other = MembershipFactory(organization=org).user
    snapshot = pool(actor, record, [member, other], org)
    assert change(other, org, allow_identification=True).status_code == 200
    assert not service.revalidate(snapshot)
    assert len(pool(actor, record, [member, other], org).candidates) == 1


@pytest.mark.parametrize("damage", ["cipher", "key", "dimension"])
def test_active_competitor_failure_is_not_treated_as_a_missing_runner_up(damage):
    actor, record, org = org_record()
    member, _ = member_profile(org)
    other, profile = member_profile(org, angle=0.1)
    template = current_template(profile)
    mutations = {
        "cipher": lambda: models.VoiceprintTemplate.objects.filter(
            pk=template.pk
        ).update(encrypted_vector=b"bad"),
        "key": lambda: models.VoiceprintProfile.objects.filter(pk=profile.pk).update(
            encrypted_key=b""
        ),
        "dimension": lambda: models.VoiceprintTemplate.objects.filter(
            pk=template.pk
        ).update(dimension=1),
    }
    mutations[damage]()
    with pytest.raises(
        VoiceprintError, match="voiceprint_templates_unavailable"
    ) as error:
        service.match_record(
            record,
            actor,
            clips(),
            organization_id=org.pk,
            user_ids=[member.pk, other.pk],
            expected_revision=record.revision,
        )
    assert error.value.status == 503


def test_refreshed_profile_cannot_cross_the_selected_owner_or_scope_before_decryption(
    monkeypatch,
):
    actor, record, org = org_record()
    member, profile = member_profile(org)
    monkeypatch.setattr(
        Keyring,
        "decrypt",
        lambda *_args, **_kwargs: pytest.fail(
            "scope mismatch must be rejected before private decryption"
        ),
    )
    for selected in ((actor.pk, org.pk), (member.pk, None), (member.pk, uuid4())):
        with pytest.raises(VoiceprintError, match="voiceprint_authorization_revoked"):
            consent.authorize_profile(
                profile.pk, permission="allow_identification", expected_scope=selected
            )


def test_fairness_scan_and_unadopted_new_confirmations_do_not_change_a_stable_baseline():
    actor, record, org = org_record()
    member, profile = member_profile(org)
    snapshot = pool(actor, record, [member], org)
    contributions(profile)
    assert templates.build(profile.pk).status == "unchanged"
    assert service.revalidate(snapshot)


@pytest.mark.parametrize(
    "values", [None, [], [True], [1], ["not-a-uuid"], [uuid4()] * 2, [uuid4()] * 51]
)
def test_candidate_selection_is_explicit_typed_unique_and_bounded(values):
    with pytest.raises(VoiceprintError, match="voiceprint_candidates_invalid"):
        service.explicit_ids(values)


@pytest.mark.parametrize("value", [True, 1, "foreign-scope"])
def test_malformed_scope_ids_are_fixed_failures(value):
    with pytest.raises(VoiceprintError, match="voiceprint_candidate_scope_unavailable"):
        service.explicit_scope(value)


def test_org_uuid_strings_are_normalized_without_changing_the_snapshot():
    actor, record, org = org_record()
    member, _ = member_profile(org)
    first = pool(actor, record, [member], org)
    second = service.load_pool(
        record,
        actor,
        organization_id=str(org.pk),
        user_ids=[str(member.pk)],
        expected_revision=record.revision,
    )
    assert second.fingerprint == first.fingerprint and second.organization_id == org.pk


@pytest.mark.parametrize("revision", [True, 1.0, "1"])
def test_revision_is_a_strict_integer_before_any_biometric_access(
    revision, monkeypatch
):
    actor, record, org = org_record()
    member, _ = member_profile(org)
    monkeypatch.setattr(
        Keyring,
        "decrypt",
        lambda *_args, **_kwargs: pytest.fail(
            "invalid revision must not read templates"
        ),
    )
    with pytest.raises(VoiceprintError, match="voiceprint_revision_invalid"):
        service.load_pool(
            record,
            actor,
            organization_id=org.pk,
            user_ids=[member.pk],
            expected_revision=revision,
        )


@pytest.mark.parametrize(
    "flag", ["MEETING_VOICEPRINT_ENABLED", "MEETING_VOICEPRINT_MATCHING_ENABLED"]
)
def test_default_off_blocks_configuration_and_biometric_access(
    settings, monkeypatch, flag
):
    actor, record, org = org_record()
    member, _ = member_profile(org)
    setattr(settings, flag, False)
    monkeypatch.setattr(
        matching,
        "load_policy",
        lambda *_args: pytest.fail("disabled matching reads no policy"),
    )
    monkeypatch.setattr(
        Keyring,
        "decrypt",
        lambda *_args, **_kwargs: pytest.fail(
            "disabled matching decrypts no biometric data"
        ),
    )
    with pytest.raises(VoiceprintError, match="voiceprint_matching_disabled"):
        service.match_record(
            record,
            actor,
            clips(),
            organization_id=org.pk,
            user_ids=[member.pk],
            expected_revision=record.revision,
        )


def test_missing_or_uncalibrated_policy_does_not_decrypt_templates(
    settings, tmp_path, monkeypatch
):
    actor, record, org = org_record()
    member, _ = member_profile(org)
    path = tmp_path / "not-ready.json"
    monkeypatch.setattr(
        Keyring,
        "decrypt",
        lambda *_args, **_kwargs: pytest.fail("a policy is required before decryption"),
    )
    for content in (None, asdict(replace(policy(), calibrated=False))):
        if content is not None:
            path.write_text(json.dumps(content))
        settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE = str(path)
        with pytest.raises(
            VoiceprintError, match="voiceprint_threshold_policy_unavailable"
        ):
            service.match_record(
                record,
                actor,
                clips(),
                organization_id=org.pk,
                user_ids=[member.pk],
                expected_revision=record.revision,
            )


def test_matching_bound_result_does_not_change_speakers_samples_or_permissions():
    actor, record, org = org_record()
    member, profile = member_profile(org)
    state = (
        record.revision,
        models.SpeakerIdentityDecision.objects.count(),
        profile.samples.count(),
    )
    result = service.match_record(
        record,
        actor,
        clips(),
        organization_id=org.pk,
        user_ids=[member.pk],
        expected_revision=record.revision,
    )
    assert result.result.status == "suggested" and result.result.user_id == member.pk
    assert (
        result.record_revision == record.revision
        and result.threshold_version == policy().threshold_version
    )
    assert len(result.threshold_digest) == 64 and len(result.candidate_digest) == 64
    record.refresh_from_db()
    profile.consent.refresh_from_db()
    assert (
        record.revision,
        models.SpeakerIdentityDecision.objects.count(),
        profile.samples.count(),
    ) == state
    assert not profile.consent.allow_accumulation and not record.speakers.exists()


@pytest.mark.parametrize("mutation", ["revoke", "new_candidate", "revision", "policy"])
def test_a_change_during_scoring_never_releases_an_old_suggestion(
    mutation, settings, monkeypatch
):
    actor, record, org = org_record()
    member, _ = member_profile(org)
    other = MembershipFactory(organization=org).user
    original = matching.match

    def race(*args, **kwargs):
        result = original(*args, **kwargs)
        callbacks = {
            "revoke": lambda: change(
                member, org, version=1, allow_identification=False
            ),
            "new_candidate": lambda: register(other, org),
            "revision": lambda: models.MeetingRecord.objects.filter(
                pk=record.pk
            ).update(revision=2),
            "policy": lambda: Path(
                settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE
            ).write_text(json.dumps(asdict(policy(margin=0.1)))),
        }
        callbacks[mutation]()
        return result

    monkeypatch.setattr(matching, "match", race)
    with pytest.raises(VoiceprintError, match="voiceprint_matching_context_changed"):
        service.match_record(
            record,
            actor,
            clips(),
            organization_id=org.pk,
            user_ids=[member.pk, other.pk],
            expected_revision=record.revision,
        )
