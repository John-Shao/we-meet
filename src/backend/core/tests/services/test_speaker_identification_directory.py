"""Real record/media, library scope and bounded directory API boundaries."""

import json
from uuid import uuid4

import pytest

from core import models
from core.factories import MembershipFactory, UserFactory
from core.services import voiceprint_candidates as candidates
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_speaker_identification import (
    case,
    enabled,
    matching_enabled,
    org_for,
    published,
    second_speaker,
    throttle_isolation,
)

pytestmark = pytest.mark.django_db
OPTIONS = "/api/v1.0/meeting-records/{}/speaker-identification-options/"
PEOPLE = "/api/v1.0/meeting-records/{}/speaker-identification-candidates/"


def read(case, *, path=OPTIONS, actor=None, **parameters):
    return client_for(actor or case.actor).get(
        path.format(case.record.pk),
        {"expected_revision": case.record.revision, **parameters},
    )


def test_options_and_personal_candidates_never_read_templates_or_permissions(
    case, monkeypatch
):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("Directory must not decrypt templates or load thresholds")

    monkeypatch.setattr(candidates, "artifact", forbidden)
    monkeypatch.setattr(candidates.matching, "load_policy", forbidden)
    response = read(case)
    assert response.status_code == 200, response.data
    assert response.data["personal_allowed"]
    assert response.data["required_organization_id"] is None
    assert response.data["targets"] == [
        {"id": str(case.speaker.pk), "name": "Speaker 0"}
    ]
    assert response["Cache-Control"] == "private, no-store"
    people = read(case, path=PEOPLE, organization_id="personal")
    assert people.status_code == 200, people.data
    assert [row["id"] for row in people.data["results"]] == [str(case.actor.pk)]
    assert set(people.data["results"][0]) == {"id", "name"}
    assert not any(
        value in json.dumps(people.data)
        for value in ("email", "phone", "allow_identification", "profile", "vector")
    )
    assert not models.SpeakerIdentityRequest.objects.exists()


def test_options_exclude_existing_manual_identities(case):
    second = second_speaker(case)
    models.MeetingSpeaker.objects.filter(pk=case.speaker.pk).update(
        manual_label="Guest", attribution_kind="custom"
    )
    assert read(case).data["targets"] == [{"id": str(second.pk), "name": "Speaker 1"}]


def test_personal_directory_does_not_include_organization_members(case):
    organization, _ = org_for(case.actor)
    MembershipFactory(organization=organization)
    response = read(case, path=PEOPLE, organization_id="personal")
    assert [row["id"] for row in response.data["results"]] == [str(case.actor.pk)]


def test_organization_directory_is_current_distinct_human_members_only(case):
    organization, _ = org_for(case.actor)
    other, _ = org_for(case.actor)
    ada = MembershipFactory(organization=organization, user__full_name="Ada").user
    MembershipFactory(organization=organization, user=ada)
    retired = MembershipFactory(organization=organization, user__is_active=False).user
    device = MembershipFactory(organization=organization, user__is_device=True).user
    left = MembershipFactory(organization=organization, status="left").user
    outsider = MembershipFactory(organization=other).user
    response = read(case, path=PEOPLE, organization_id=str(organization.pk), q="Ada")
    assert response.status_code == 200, response.data
    assert response.data["results"] == [{"id": str(ada.pk), "name": "Ada"}]
    whole = read(case, path=PEOPLE, organization_id=str(organization.pk))
    ids = {row["id"] for row in whole.data["results"]}
    assert ids == {str(case.actor.pk), str(ada.pk)}
    assert not ids & {str(user.pk) for user in (retired, device, left, outsider)}
    MembershipFactory(organization=organization, user=case.actor)
    options = read(case).data["scopes"]["results"]
    assert len(options) == 2 and {row["id"] for row in options} == {
        str(organization.pk),
        str(other.pk),
    }
    models.Membership.objects.filter(user=case.actor, organization=organization).update(
        status="left"
    )
    assert (
        read(case, path=PEOPLE, organization_id=str(organization.pk)).status_code == 403
    )


def test_organization_record_cannot_offer_personal_or_other_banks(case):
    organization, _ = org_for(case.actor)
    other, _ = org_for(case.actor)
    # Seed organization provenance before this fixture's first request;
    # application-level record saves prohibit reassigning provenance.
    models.MeetingRecord.objects.filter(pk=case.record.pk).update(
        organization=organization
    )
    case.record.refresh_from_db()
    response = read(case)
    assert response.status_code == 200, response.data
    assert not response.data["personal_allowed"]
    assert response.data["required_organization_id"] == str(organization.pk)
    assert [row["id"] for row in response.data["scopes"]["results"]] == [
        str(organization.pk)
    ]
    for scope in ("personal", str(other.pk)):
        assert read(case, path=PEOPLE, organization_id=scope).status_code == 403


def test_disabled_org_is_visible_as_disabled_but_cannot_supply_candidates(case):
    organization, _ = org_for(case.actor, enabled=False)
    assert read(case).data["scopes"]["results"][0]["enabled"] is False
    assert (
        read(case, path=PEOPLE, organization_id=str(organization.pk)).status_code == 403
    )


@pytest.mark.parametrize("path", [OPTIONS, PEOPLE])
@pytest.mark.parametrize("role,media", [("reader", True), ("editor", False)])
def test_directory_requires_editor_and_explicit_media_access(case, path, role, media):
    viewer = UserFactory()
    models.MeetingCollaborator.objects.create(
        record=case.record, scope="record", user=viewer, role=role, media=media
    )
    response = read(
        case,
        path=path,
        actor=viewer,
        **({"organization_id": "personal"} if path == PEOPLE else {}),
    )
    assert response.status_code == 404
    assert response["Cache-Control"] == "private, no-store"


@pytest.mark.parametrize("path", [OPTIONS, PEOPLE])
def test_stale_source_version_is_a_conflict(case, path):
    kwargs = {"organization_id": "personal"} if path == PEOPLE else {}
    assert read(case, path=path, expected_revision=2, **kwargs).status_code == 409


@pytest.mark.parametrize("path", [OPTIONS, PEOPLE])
def test_disabled_matching_returns_unavailable_without_configuration_reads(
    case, settings, path
):
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE = "not-a-file"
    kwargs = {"organization_id": "personal"} if path == PEOPLE else {}
    response = read(case, path=path, **kwargs)
    assert response.status_code == 503
    assert response.data["code"] == "voiceprint_matching_disabled"


@pytest.mark.parametrize("path", [OPTIONS, PEOPLE])
def test_expected_owner_header_is_checked_before_directory_reads(case, path):
    parameters = {"expected_revision": 1}
    if path == PEOPLE:
        parameters["organization_id"] = "personal"
    response = client_for(case.actor).get(
        path.format(case.record.pk), parameters, HTTP_X_VOICEPRINT_OWNER=str(uuid4())
    )
    assert response.status_code == 401 and "results" not in response.data


@pytest.mark.parametrize(
    "parameters",
    [
        {},
        {"organization_id": ""},
        {"organization_id": "all"},
        {"organization_id": "personal", "offset": 10001},
        {"organization_id": "personal", "score": 0.99},
        {"organization_id": "personal", "q": "x" * 81},
    ],
)
def test_candidate_scope_and_filters_must_be_explicit_and_bounded(case, parameters):
    assert read(case, path=PEOPLE, **parameters).status_code == 400


def test_candidate_pagination_is_bounded_stable_and_does_not_expand_scope(case):
    organization, _ = org_for(case.actor)
    MembershipFactory.create_batch(
        26, organization=organization, user__full_name="Candidate"
    )
    first = read(case, path=PEOPLE, organization_id=str(organization.pk), q="Candidate")
    assert len(first.data["results"]) == 25 and first.data["next_offset"] == 25
    last = read(
        case,
        path=PEOPLE,
        organization_id=str(organization.pk),
        q="Candidate",
        offset=25,
    )
    assert len(last.data["results"]) == 1 and last.data["next_offset"] is None
    assert not {row["id"] for row in first.data["results"]} & {
        row["id"] for row in last.data["results"]
    }


@pytest.mark.parametrize(
    "feature_enabled,matching",
    [(False, False), (False, True), (True, False), (True, True)],
)
def test_frontend_matching_flag_requires_both_feature_switches(
    case, settings, feature_enabled, matching
):
    settings.MEETING_VOICEPRINT_ENABLED = feature_enabled
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = matching
    response = client_for(case.actor).get("/api/v1.0/config/")
    assert response.status_code == 200
    assert response.data["speaker_identity"] == {
        "enabled": feature_enabled,
        "matching_enabled": feature_enabled and matching,
    }
