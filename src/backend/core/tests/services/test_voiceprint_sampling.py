"""Real DB, signed webhook and private permit boundaries; no captured audio."""

import base64
import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from uuid import UUID, uuid4

from django.db import close_old_connections
from django.utils import timezone

import pytest
from livekit import api
from rest_framework.test import APIClient

from core import models
from core.factories import (
    MeetingSessionFactory,
    MembershipFactory,
    OrganizationFactory,
    RoomFactory,
    UserFactory,
)
from core.services import voiceprint_consent as consent
from core.services import voiceprint_enrollment as enrollment
from core.services import voiceprint_sampling as service
from core.services.livekit_events import InvalidPayloadError, LiveKitEventsService
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db
CONTROL = "/api/v1.0/voiceprint/sampling-control/"
PERMITS = "/api/agent/voiceprint-sampling/permits/"


@pytest.fixture(autouse=True)
def enabled(settings, tmp_path):
    settings.MEETING_VOICEPRINT_ENABLED = True
    settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = True
    settings.MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN = (
        "synthetic-separate-sampler-credential-0001"
    )
    settings.LIVEKIT_CONFIGURATION = {
        "api_key": "test-sampling-key",
        "api_secret": "synthetic-livekit-secret-for-tests-0001",
        "url": "http://localhost:9",
    }
    path = tmp_path / "keyring.json"
    path.write_text(
        json.dumps(
            {
                "active": "fixture",
                "keys": {"fixture": base64.b64encode(os.urandom(32)).decode()},
            }
        )
    )
    settings.MEETING_VOICEPRINT_KEYRING_FILE = str(path)


class Fixture:
    def __init__(self, user=None, organization=None):
        self.user = user or UserFactory()
        self.organization = organization
        if organization is not None:
            MembershipFactory(user=self.user, organization=organization)
        consent.update_settings(
            self.user,
            organization_id=organization.pk if organization else None,
            expected_version=0,
            changes={"allow_enrollment": True, "allow_accumulation": True},
        )
        self.room = RoomFactory(organization=organization)
        self.session = MeetingSessionFactory(
            room=self.room, livekit_room_sid="RM_" + uuid4().hex
        )
        self.participant = models.MeetingParticipation.objects.create(
            session=self.session,
            user=self.user,
            livekit_participant_sid="PA_" + uuid4().hex,
            identity=str(self.user.sub),
            kind="standard",
            joined_at=timezone.now(),
        )
        self.track = service.record_track(
            participation=self.participant,
            track=api.TrackInfo(
                sid="TR_" + uuid4().hex,
                source=api.TrackSource.MICROPHONE,
                type=api.TrackType.AUDIO,
            ),
            published=True,
            event_at=timezone.now(),
        )

    def control(self, **changes):
        revision = service.read_control(
            self.user,
            session_id=self.session.pk,
            participant_sid=self.participant.livekit_participant_sid,
        )["revision"]
        values = {
            "paused": False,
            "shared_microphone": False,
            "device_group": "headset",
            **changes,
        }
        return service.update_control(
            self.user,
            session_id=self.session.pk,
            participant_sid=self.participant.livekit_participant_sid,
            expected_revision=revision,
            **values,
        )

    def wire(self, **changes):
        return {
            "room_sid": self.session.livekit_room_sid,
            "participant_sid": self.participant.livekit_participant_sid,
            "track_sid": self.track.livekit_track_sid,
            **changes,
        }

    def issue(self, key=None):
        return service.issue(**self.wire(), request_key=key or uuid4())

    def validate(self, permit, **changes):
        return service.validate(
            UUID(permit["id"]), token=permit["token"], **self.wire(**changes)
        )


def test_read_is_private_and_allocates_neither_controls_nor_permits():
    fixture = Fixture()
    response = client_for(fixture.user).get(
        CONTROL,
        {
            "session_id": fixture.session.pk,
            "participant_sid": fixture.participant.livekit_participant_sid,
        },
    )
    assert (
        response.status_code == 200 and response["Cache-Control"] == "private, no-store"
    )
    assert response.data["revision"] == 0 and response.data["shared_microphone"]
    assert response.data["state"] == "shared_microphone"
    assert not models.VoiceprintSamplingControl.objects.exists()
    assert not models.VoiceprintSamplingPermit.objects.exists()
    assert not models.VoiceprintSample.objects.exists()
    with pytest.raises(consent.VoiceprintError, match="control_unavailable"):
        fixture.issue()


def test_explicit_microphone_declaration_issues_bound_idempotent_reservation():
    fixture = Fixture()
    fixture.control()
    key = uuid4()
    first = fixture.issue(key)
    assert first == fixture.issue(key) == fixture.validate(first)
    assert first["user_id"] == str(fixture.user.pk)
    assert (
        first["identity"] == str(fixture.user.sub)
        and first["identity"] != first["user_id"]
    )
    assert first["max_duration_ms"] == 10000 and first["sample_rate"] == 24000
    assert first["participant_sid"] == fixture.participant.livekit_participant_sid
    assert len(first["token"]) == 43 and first["device_group"] == "headset"
    assert models.VoiceprintSamplingPermit.objects.count() == 1
    assert not models.VoiceprintSample.objects.exists()
    with pytest.raises(consent.VoiceprintError, match="permit_busy"):
        fixture.issue()


@pytest.mark.parametrize(
    "damage",
    [
        "guest",
        "agent",
        "device",
        "sub_changed",
        "participant_left",
        "session_ended",
        "video",
        "screenshare",
        "mutated_source",
    ],
)
def test_untrusted_or_ended_sources_never_receive_a_permit(damage):
    fixture = Fixture()
    fixture.control()
    if damage == "guest":
        fixture.participant.user = None
        fixture.participant.save()
    elif damage == "agent":
        fixture.participant.kind = "agent"
        fixture.participant.save()
    elif damage == "device":
        fixture.user.is_device = True
        fixture.user.save()
    elif damage == "sub_changed":
        fixture.user.sub = str(uuid4())
        fixture.user.save()
    elif damage == "participant_left":
        fixture.participant.left_at = timezone.now()
        fixture.participant.save()
    elif damage == "session_ended":
        fixture.session.status = "ended"
        fixture.session.ended_at = timezone.now()
        fixture.session.end_reason = "room_finished"
        fixture.session.save()
    elif damage == "video":
        fixture.track.media_type = "video"
        fixture.track.save()
    elif damage == "screenshare":
        fixture.track.source = "screen_share_audio"
        fixture.track.save()
    else:
        fixture.participant.identity = str(fixture.user.pk)
        fixture.participant.save()
    with pytest.raises(consent.VoiceprintError):
        fixture.issue()
    assert not models.VoiceprintSamplingPermit.objects.exists()


@pytest.mark.parametrize(
    "change",
    [{"paused": True}, {"shared_microphone": True}, {"device_group": "computer"}],
)
def test_control_update_immediately_closes_old_permit(change):
    fixture = Fixture()
    fixture.control()
    permit = fixture.issue()
    fixture.control(**change)
    assert (
        models.VoiceprintSamplingPermit.objects.get(pk=permit["id"]).status
        == "canceled"
    )
    with pytest.raises(consent.VoiceprintError):
        fixture.validate(permit)


@pytest.mark.parametrize(
    "change",
    [
        "permission",
        "policy",
        "membership",
        "expiry",
        "global_flag",
        "track",
        "reconnection",
        "room_replaced",
        "wrong_token",
        "unicode_token",
    ],
)
def test_each_validation_rechecks_authority_and_exact_connection(change, settings):
    organization = OrganizationFactory(
        settings={"voiceprint": {"enabled": True, "version": 1}}
    )
    fixture = Fixture(organization=organization)
    fixture.control()
    permit = fixture.issue()
    if change == "permission":
        consent.update_settings(
            fixture.user,
            organization_id=organization.pk,
            expected_version=1,
            changes={"allow_accumulation": False},
        )
    elif change == "policy":
        organization.settings["voiceprint"]["version"] = 2
        organization.save()
    elif change == "membership":
        models.Membership.objects.filter(
            user=fixture.user, organization=organization
        ).delete()
    elif change == "expiry":
        models.VoiceprintSamplingPermit.objects.filter(pk=permit["id"]).update(
            expires_at=timezone.now()
        )
    elif change == "global_flag":
        settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = False
    elif change == "track":
        fixture.track.unpublished_at = timezone.now()
        fixture.track.save()
    elif change == "wrong_token":
        permit["token"] = "0" * 43
    elif change == "unicode_token":
        permit["token"] = "声" * 43
    elif change == "room_replaced":
        fixture.session.livekit_room_sid = "RM_replaced"
        fixture.session.save()
    else:
        fixture.participant.livekit_participant_sid = "PA_reconnected"
        fixture.participant.save()
    with pytest.raises(consent.VoiceprintError):
        fixture.validate(permit)


def test_unpublish_with_minimal_payload_and_late_publish_cannot_reopen_track():
    fixture = Fixture()
    fixture.control()
    permit = fixture.issue()
    now = timezone.now()
    service.record_track(
        participation=fixture.participant,
        track=api.TrackInfo(sid=fixture.track.livekit_track_sid),
        published=False,
        event_at=now,
    )
    service.record_track(
        participation=fixture.participant,
        track=api.TrackInfo(
            sid=fixture.track.livekit_track_sid, source=api.TrackSource.MICROPHONE
        ),
        published=True,
        event_at=now,
    )
    fixture.track.refresh_from_db()
    assert fixture.track.unpublished_at == now
    with pytest.raises(consent.VoiceprintError):
        fixture.validate(permit)


def test_same_track_sid_cannot_move_between_participant_connections():
    fixture = Fixture()
    other = models.MeetingParticipation.objects.create(
        session=fixture.session,
        user=fixture.user,
        identity=str(fixture.user.sub),
        kind="standard",
        livekit_participant_sid="PA_second",
        joined_at=timezone.now(),
    )
    with pytest.raises(consent.VoiceprintError, match="track_changed"):
        service.record_track(
            participation=other,
            track=api.TrackInfo(
                sid=fixture.track.livekit_track_sid, source=api.TrackSource.MICROPHONE
            ),
            published=True,
            event_at=timezone.now(),
        )


def expire(permit):
    models.VoiceprintSamplingPermit.objects.filter(pk=permit["id"]).update(
        expires_at=timezone.now()
    )


def test_session_budget_covers_republished_tracks_and_concurrent_devices():
    fixture = Fixture()
    fixture.control()
    for _ in range(6):
        expire(fixture.issue())
    other = models.MeetingParticipation.objects.create(
        session=fixture.session,
        user=fixture.user,
        identity=str(fixture.user.sub),
        kind="standard",
        livekit_participant_sid="PA_second",
        joined_at=timezone.now(),
    )
    service.update_control(
        fixture.user,
        session_id=fixture.session.pk,
        participant_sid=other.livekit_participant_sid,
        expected_revision=0,
        paused=False,
        shared_microphone=False,
        device_group="computer",
    )
    track = service.record_track(
        participation=other,
        track=api.TrackInfo(sid="TR_second", source=api.TrackSource.MICROPHONE),
        published=True,
        event_at=timezone.now(),
    )
    with pytest.raises(consent.VoiceprintError, match="quota"):
        service.issue(
            room_sid=fixture.session.livekit_room_sid,
            participant_sid=other.livekit_participant_sid,
            track_sid=track.livekit_track_sid,
            request_key=uuid4(),
        )
    assert models.VoiceprintSamplingPermit.objects.count() == 6


def test_daily_budget_is_global_and_deleting_origins_does_not_refund_it():
    fixture = Fixture()
    fixture.control()
    for _ in range(6):
        expire(fixture.issue())
    fixture.room.delete()
    assert models.VoiceprintSamplingPermit.objects.count() == 6
    assert not models.VoiceprintSamplingPermit.objects.exclude(track=None).exists()
    other = Fixture(
        user=fixture.user,
        organization=OrganizationFactory(
            settings={"voiceprint": {"enabled": True, "version": 1}}
        ),
    )
    other.control()
    for _ in range(6):
        expire(other.issue())
    # A fresh session in a third scope has its full session budget available.
    third = Fixture(
        user=fixture.user,
        organization=OrganizationFactory(
            settings={"voiceprint": {"enabled": True, "version": 1}}
        ),
    )
    third.control()
    with pytest.raises(consent.VoiceprintError, match="quota"):
        third.issue()
    assert models.VoiceprintSamplingPermit.objects.count() == 12


@pytest.mark.parametrize(
    "field,value",
    [
        ("MEETING_VOICEPRINT_SAMPLING_CLIP_MS", True),
        ("MEETING_VOICEPRINT_SAMPLING_CLIP_MS", 10001),
        ("MEETING_VOICEPRINT_SAMPLING_DAILY_MS", 120001),
        ("MEETING_VOICEPRINT_SAMPLING_SESSION_MS", 0),
    ],
)
def test_bad_budget_fails_closed(field, value, settings):
    fixture = Fixture()
    fixture.control()
    setattr(settings, field, value)
    with pytest.raises(consent.VoiceprintError, match="budget_invalid"):
        fixture.issue()
    assert not models.VoiceprintSamplingPermit.objects.exists()


def test_private_credentials_and_payload_cannot_impersonate_a_user(settings):
    fixture = Fixture()
    fixture.control()
    public = client_for(fixture.user)
    assert (
        public.post(
            PERMITS, {**fixture.wire(), "request_key": str(uuid4())}, format="json"
        ).status_code
        == 403
    )
    client = APIClient()
    client.credentials(
        HTTP_X_VOICEPRINT_AGENT_TOKEN=settings.MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN
    )
    for extra in [
        {"user_id": str(fixture.user.pk)},
        {"organization_id": str(uuid4())},
        {"audio": "forbidden"},
    ]:
        assert (
            client.post(
                PERMITS,
                {**fixture.wire(), "request_key": str(uuid4()), **extra},
                format="json",
            ).status_code
            == 400
        )
    response = client.post(
        PERMITS, {**fixture.wire(), "request_key": str(uuid4())}, format="json"
    )
    assert (
        response.status_code == 200 and response["Cache-Control"] == "private, no-store"
    )
    permit = response.data
    assert (
        client.post(
            f"{PERMITS}{permit['id']}/validate/",
            {**fixture.wire(), "token": permit["token"]},
            format="json",
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"{PERMITS}{permit['id']}/validate/",
            {**fixture.wire(), "token": "声" * 43},
            format="json",
        ).status_code
        == 400
    )
    settings.MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN = ""
    assert (
        client.post(
            PERMITS, {**fixture.wire(), "request_key": str(uuid4())}, format="json"
        ).status_code
        == 403
    )


def test_owner_and_revision_guards_prevent_controling_another_connection(settings):
    fixture = Fixture()
    stranger = UserFactory()
    params = {
        "session_id": str(fixture.session.pk),
        "participant_sid": fixture.participant.livekit_participant_sid,
    }
    assert client_for(stranger).get(CONTROL, params).status_code == 404
    public = client_for(fixture.user)
    public.credentials(HTTP_X_VOICEPRINT_OWNER=str(stranger.pk))
    assert public.get(CONTROL, params).status_code == 401
    public.credentials(HTTP_X_VOICEPRINT_OWNER=str(fixture.user.pk))
    body = {
        **params,
        "expected_revision": 0,
        "paused": False,
        "shared_microphone": False,
        "device_group": "headset",
    }
    assert (
        public.patch(CONTROL, {**body, "paused": "false"}, format="json").status_code
        == 400
    )
    assert public.patch(CONTROL, body, format="json").status_code == 200
    assert public.patch(CONTROL, body, format="json").status_code == 409
    settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = False
    assert (
        public.patch(
            CONTROL, {**body, "expected_revision": 1, "paused": True}, format="json"
        ).status_code
        == 200
    )


def test_fake_call_sample_cannot_be_accessed_by_relabeling_an_enrollment():
    fixture = Fixture()
    fixture.control()
    permit = fixture.issue()
    row = models.VoiceprintSamplingPermit.objects.get(pk=permit["id"])
    sample = models.VoiceprintSample.objects.create(
        profile=row.profile,
        generation=row.generation,
        consent_version=row.consent_version,
        permit_id=row.pk,
        source_type="call",
        source_session_id=fixture.session.pk,
        source_track=fixture.track.livekit_track_sid,
        end_ms=3000,
        audio_sha256="0" * 64,
        encrypted_audio=b"not-a-source-proof",
        status="ready",
        expires_at=timezone.now() + timezone.timedelta(hours=24),
    )
    with pytest.raises(consent.VoiceprintError, match="sampling_source_unavailable"):
        enrollment.sample_authorized(sample)
    with pytest.raises(consent.VoiceprintError):
        enrollment.sample_audio(fixture.user, sample.pk)
    assert not enrollment.sample_snapshot(sample)["confirmable"]


def webhook(fixture, *, token_key=None, source="MICROPHONE", event="track_published"):
    now = int(timezone.now().timestamp())
    body = json.dumps(
        {
            "event": event,
            "id": str(uuid4()),
            "createdAt": now,
            "room": {
                "name": str(fixture.room.pk),
                "sid": fixture.session.livekit_room_sid,
                "creationTime": now - 10,
            },
            "participant": {
                "sid": fixture.participant.livekit_participant_sid,
                "identity": str(fixture.user.sub),
                "name": "Untrusted display name",
                "kind": "STANDARD",
            },
            "track": {"sid": "TR_webhook", "type": "AUDIO", "source": source},
        }
    )
    token = (
        api.AccessToken(
            "test-sampling-key", token_key or "synthetic-livekit-secret-for-tests-0001"
        )
        .with_sha256(base64.b64encode(hashlib.sha256(body.encode()).digest()).decode())
        .to_jwt()
    )
    return SimpleNamespace(body=body.encode(), headers={"Authorization": token})


def test_verified_webhook_records_identity_by_sub_and_rejects_wrong_signature():
    fixture = Fixture()
    handler = LiveKitEventsService()
    with pytest.raises(InvalidPayloadError):
        handler.receive(
            webhook(fixture, token_key="synthetic-untrusted-key-for-tests-0001")
        )
    assert not models.VoiceprintSamplingTrack.objects.filter(
        livekit_track_sid="TR_webhook"
    ).exists()
    handler.receive(webhook(fixture))
    track = models.VoiceprintSamplingTrack.objects.get(livekit_track_sid="TR_webhook")
    assert (
        track.participation.user_id == fixture.user.pk and track.source == "microphone"
    )
    handler.receive(webhook(fixture, event="track_unpublished"))
    track.refresh_from_db()
    assert track.unpublished_at is not None


@pytest.mark.django_db(transaction=True)
def test_concurrent_duplicate_reservations_share_one_nonce_and_charge_once():
    fixture = Fixture()
    fixture.control()
    key = uuid4()
    payload = fixture.wire()

    def reserve():
        close_old_connections()
        try:
            return service.issue(**payload, request_key=key)["id"]
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: reserve(), range(2)))
    assert results[0] == results[1]
    assert models.VoiceprintSamplingPermit.objects.count() == 1


def test_profile_cleanup_erases_permit_origins_without_refunding_budget():
    fixture = Fixture()
    fixture.control()
    issued = fixture.issue()
    permit = models.VoiceprintSamplingPermit.objects.get(pk=issued["id"])
    job = consent.delete_profile(
        fixture.user,
        profile_id=permit.profile_id,
        expected_version=permit.consent_version,
        request_key=uuid4(),
    )
    permit.refresh_from_db()
    assert permit.status == "canceled"
    with pytest.raises(consent.VoiceprintError):
        fixture.validate(issued)
    consent.purge_deleted(job.pk)
    permit.refresh_from_db()
    assert permit.track_id is None and permit.sample_id is None
    assert not any(
        (
            permit.livekit_room_sid,
            permit.participant_sid,
            permit.participant_identity,
            permit.source_track_sid,
            permit.device_group,
        )
    )
    assert permit.owner_id == fixture.user.pk
    assert permit.source_session_id == fixture.session.pk
    assert permit.max_duration_ms == 10000
    assert consent.purge_deleted(job.pk).attempts == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_scopes_cannot_both_reserve_the_last_daily_clip():
    first = Fixture()
    first.control()
    for _ in range(6):
        expire(first.issue())
    second = Fixture(
        user=first.user,
        organization=OrganizationFactory(
            settings={"voiceprint": {"enabled": True, "version": 1}}
        ),
    )
    second.control()
    for _ in range(5):
        expire(second.issue())
    third = Fixture(
        user=first.user,
        organization=OrganizationFactory(
            settings={"voiceprint": {"enabled": True, "version": 1}}
        ),
    )
    third.control()

    def reserve(payload):
        close_old_connections()
        try:
            service.issue(**payload, request_key=uuid4())
        except consent.VoiceprintError as error:
            return str(error)
        else:
            return "issued"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, (second.wire(), third.wire())))
    assert sorted(results) == ["issued", "voiceprint_sampling_quota"]
    assert models.VoiceprintSamplingPermit.objects.count() == 12
