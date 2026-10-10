"""Private join projection: trusted occurrence, no controls/permits on read."""

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import OrganizationFactory, UserFactory
from core.services import voiceprint_source_removal as removal
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_voiceprint_sampling import Fixture, enabled

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/voiceprint/sampling-connection/"


def query(fixture):
    return {
        "room_sid": fixture.session.livekit_room_sid,
        "participant_sid": fixture.participant.livekit_participant_sid,
    }


def test_private_read_does_not_allocate_or_expose_biometric_context():
    fixture = Fixture()
    response = client_for(fixture.user).get(
        URL, query(fixture), HTTP_X_VOICEPRINT_OWNER=str(fixture.user.pk)
    )
    assert response.status_code == 200
    data = response.json()
    assert data["room_sid"] == fixture.session.livekit_room_sid
    assert data["organization_id"] is data["organization_name"] is None
    assert data["control"]["session_id"] == str(fixture.session.pk)
    assert data["control"]["shared_microphone"] is True
    assert data["control"]["runtime"]["state"] == "stopped"
    assert data["permission"] == {
        "available": True,
        "version": 1,
        "allow_enrollment": True,
        "allow_accumulation": True,
    }
    assert data["limits"] == {
        "clip_ms": 10000,
        "session_ms": 60000,
        "daily_ms": 120000,
        "candidate_retention_seconds": 86400,
    }
    assert timezone.datetime.fromisoformat(data["observed_at"]).tzinfo is not None
    assert "no-store" in response["Cache-Control"]
    for model in (
        models.VoiceprintProfile,
        models.VoiceprintSamplingControl,
        models.VoiceprintSamplingPermit,
        models.VoiceprintSamplingActivity,
        models.VoiceprintSamplingDispatch,
    ):
        assert not model.objects.exists()
    for private in (
        "profile",
        "token",
        "identity",
        "embedding",
        "feature_space",
        "phone",
        "email",
    ):
        assert private not in data and private not in data["control"]


@pytest.mark.parametrize(
    "change",
    [
        "room",
        "participant",
        "other_user",
        "anonymous",
        "owner_header",
        "guest_kind",
        "wrong_identity",
        "ended",
        "left",
        "removed",
    ],
)
def test_connection_lookup_fails_closed_on_wrong_owner_or_occurrence(change):
    fixture = Fixture()
    client = client_for(fixture.user)
    params = query(fixture)
    headers = {}
    if change == "room":
        params["room_sid"] = "RM_other"
    elif change == "participant":
        params["participant_sid"] = "PA_other"
    elif change == "other_user":
        client = client_for(UserFactory())
    elif change == "anonymous":
        client = APIClient()
    elif change == "owner_header":
        headers["HTTP_X_VOICEPRINT_OWNER"] = str(UserFactory().pk)
    elif change == "guest_kind":
        models.MeetingParticipation.objects.filter(pk=fixture.participant.pk).update(
            kind="agent"
        )
    elif change == "wrong_identity":
        models.MeetingParticipation.objects.filter(pk=fixture.participant.pk).update(
            identity="not-the-account-sub"
        )
    elif change == "ended":
        models.MeetingSession.objects.filter(pk=fixture.session.pk).update(
            status="ended", ended_at=timezone.now(), end_reason="room_finished"
        )
    elif change == "left":
        models.MeetingParticipation.objects.filter(pk=fixture.participant.pk).update(
            left_at=timezone.now()
        )
    else:
        removal.remove_source("session", fixture.session, dispatch=False)
    response = client.get(URL, params, **headers)
    assert response.status_code in {401, 403, 404}
    assert "no-store" in response["Cache-Control"]
    assert not models.VoiceprintSamplingControl.objects.exists()


def test_missing_webhook_can_recover_without_manufacturing_a_session():
    fixture = Fixture()
    params = query(fixture)
    params["participant_sid"] = "PA_after_webhook"
    client = client_for(fixture.user)
    assert client.get(URL, params).status_code == 404
    assert models.MeetingSession.objects.count() == 1
    models.MeetingParticipation.objects.filter(pk=fixture.participant.pk).update(
        livekit_participant_sid=params["participant_sid"]
    )
    assert client.get(URL, params).status_code == 200


def test_scope_is_resolved_from_room_and_permission_is_current():
    organization = OrganizationFactory(
        name="Synthetic organization",
        settings={"voiceprint": {"enabled": True, "version": 1}},
    )
    fixture = Fixture(organization=organization)
    fixture.control()
    client = client_for(fixture.user)
    response = client.get(URL, query(fixture))
    assert response.status_code == 200
    data = response.json()
    assert data["organization_id"] == str(organization.pk)
    assert data["organization_name"] == organization.name
    models.VoiceprintConsent.objects.filter(
        user=fixture.user, organization=organization
    ).update(allow_accumulation=False, version=2)
    changed = client.get(URL, query(fixture)).json()
    assert (
        changed["permission"]["version"] == 2
        and changed["permission"]["allow_accumulation"] is False
    )
    assert changed["control"]["runtime"]["reason"] == "authorization_required"
    # Clients cannot select a different authorization scope through this route.
    assert (
        client.get(
            URL, {**query(fixture), "organization_id": str(organization.pk)}
        ).status_code
        == 400
    )


@pytest.mark.parametrize("disabled", ["global", "sampling", "organization"])
def test_disabled_scope_never_claims_sampling_or_allocates_a_permit(settings, disabled):
    organization = OrganizationFactory(
        settings={"voiceprint": {"enabled": True, "version": 1}}
    )
    fixture = Fixture(organization=organization)
    fixture.control()
    if disabled == "global":
        settings.MEETING_VOICEPRINT_ENABLED = False
    elif disabled == "sampling":
        settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = False
    else:
        organization.settings = {"voiceprint": {"enabled": False, "version": 2}}
        organization.save()
    response = client_for(fixture.user).get(URL, query(fixture))
    assert response.status_code == 200
    assert response.json()["control"]["runtime"] == {
        "state": "stopped",
        "reason": "disabled",
        "updated_at": None,
    }
    assert not models.VoiceprintSamplingPermit.objects.exists()


def test_sampling_capability_requires_both_server_flags(settings):
    for global_enabled, sampling_enabled in (
        (False, False),
        (False, True),
        (True, False),
        (True, True),
    ):
        settings.MEETING_VOICEPRINT_ENABLED = global_enabled
        settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = sampling_enabled
        response = APIClient().get("/api/v1.0/config/")
        assert response.status_code == 200
        assert response.json()["speaker_identity"]["sampling_enabled"] is (
            global_enabled and sampling_enabled
        )
