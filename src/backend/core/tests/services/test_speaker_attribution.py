"""Binding a diarised speaker track to a real person.

"Speaker 1" is not attribution. These tests pin that binding shows the person,
that it never rewrites the recogniser's label, and that a record cannot be made
to name someone outside its own boundary.
"""

import uuid

import pytest

from core import models
from core.factories import MembershipFactory, UserFactory
from core.services import speaker_attribution
from core.tests.services.test_meeting_records import audio_note, client_for


pytestmark = pytest.mark.django_db

SPEAKERS = "/api/v1.0/meeting-records/{}/speakers/"
ONE = "/api/v1.0/meeting-records/{}/speakers/{}/"
SEGMENTS = "/api/v1.0/meeting-records/{}/original-segments/"


@pytest.fixture(autouse=True)
def capture_path_enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = True
    yield


def org_record(owner=None):
    """A record inside an organization, with one diarised speaker and one line."""
    organization = MembershipFactory().organization
    owner = owner or MembershipFactory(organization=organization, is_primary=True).user
    record = audio_note(user=owner, organization=organization)
    now = record.origin_at
    capture = models.CaptureSession.objects.create(
        record=record,
        created_by=owner,
        device_id="fixture",
        status="stopped",
        started_at=now,
        ended_at=now,
    )
    speaker = models.MeetingSpeaker.objects.create(
        record=record,
        capture_session=capture,
        source_track_id="track",
        source_key="0",
        label="Speaker 1",
        identity_type="diarized",
    )
    models.MeetingOriginalSegment.objects.create(
        record=record,
        capture_session=capture,
        speaker=speaker,
        ingest_id=uuid.uuid4(),
        source_track_id="track",
        source_sequence=1,
        start_ms=0,
        end_ms=1000,
        text="We shipped it.",
        payload_hash="0" * 64,
    )
    return owner, record, speaker, organization


def speakers(user, record):
    response = client_for(user).get(SPEAKERS.format(record.id))
    assert response.status_code == 200, response.data
    return response.data["results"]


def test_binding_shows_the_person_wherever_the_label_was_shown():
    owner, record, speaker, organization = org_record()
    member = MembershipFactory(
        organization=organization, user__full_name="Ada Lovelace"
    ).user

    response = client_for(owner).patch(
        ONE.format(record.id, speaker.pk), {"user_id": str(member.pk)}, format="json"
    )
    assert response.status_code == 200, response.data
    assert response.data["display_name"] == "Ada Lovelace"
    assert response.data["attributed_user_id"] == str(member.pk)

    # The transcript row a reader sees carries the person, not the track number.
    row = client_for(owner).get(SEGMENTS.format(record.id)).data["results"][0]
    assert row["speaker_label"] == "Ada Lovelace"
    # And the speaker list agrees.
    assert speakers(owner, record)[0]["display_name"] == "Ada Lovelace"


def test_the_recognisers_label_is_never_rewritten():
    """The diarisation output is evidence; attribution is a layer over it."""
    owner, record, speaker, organization = org_record()
    member = MembershipFactory(
        organization=organization, user__full_name="Ada Lovelace"
    ).user
    client_for(owner).patch(
        ONE.format(record.id, speaker.pk), {"user_id": str(member.pk)}, format="json"
    )
    speaker.refresh_from_db()
    assert speaker.label == "Speaker 1"
    assert speaker.user_id == member.pk
    assert speaker.attributed_by_id == owner.pk
    assert speaker.attributed_at is not None


def test_clearing_restores_the_recognisers_label():
    owner, record, speaker, organization = org_record()
    member = MembershipFactory(organization=organization, user__full_name="Ada").user
    client_for(owner).patch(
        ONE.format(record.id, speaker.pk), {"user_id": str(member.pk)}, format="json"
    )
    response = client_for(owner).patch(
        ONE.format(record.id, speaker.pk), {"user_id": None}, format="json"
    )
    assert response.status_code == 200
    assert response.data["display_name"] == "Speaker 1"
    assert response.data["attributed_user_id"] is None
    assert speakers(owner, record)[0]["display_name"] == "Speaker 1"


def test_someone_outside_the_organization_cannot_be_named():
    """A record must not be made to name a person its readers cannot know."""
    owner, record, speaker, _ = org_record()
    outsider = UserFactory(full_name="Outsider")

    response = client_for(owner).patch(
        ONE.format(record.id, speaker.pk), {"user_id": str(outsider.pk)}, format="json"
    )
    assert response.status_code == 400
    assert response.data["code"] == "not_a_member"
    speaker.refresh_from_db()
    assert speaker.user_id is None


def test_a_deactivated_member_cannot_be_named():
    owner, record, speaker, organization = org_record()
    member = MembershipFactory(organization=organization).user
    models.Membership.objects.filter(
        user=member, organization=organization
    ).update(status=models.MembershipStatusChoices.LEFT)

    response = client_for(owner).patch(
        ONE.format(record.id, speaker.pk), {"user_id": str(member.pk)}, format="json"
    )
    assert response.status_code == 400


def test_a_reader_who_may_only_read_cannot_attribute():
    _, record, speaker, organization = org_record()
    member = MembershipFactory(organization=organization).user
    response = client_for(member).patch(
        ONE.format(record.id, speaker.pk), {"user_id": str(member.pk)}, format="json"
    )
    assert response.status_code in (403, 404)
    speaker.refresh_from_db()
    assert speaker.user_id is None


def test_an_unknown_speaker_or_user_is_not_found():
    owner, record, speaker, _ = org_record()
    missing = uuid.uuid4()
    assert (
        client_for(owner)
        .patch(ONE.format(record.id, missing), {"user_id": None}, format="json")
        .status_code
        == 404
    )
    assert (
        client_for(owner)
        .patch(
            ONE.format(record.id, speaker.pk),
            {"user_id": str(missing)},
            format="json",
        )
        .status_code
        == 404
    )


def test_an_unsupported_field_is_rejected_rather_than_ignored():
    owner, record, speaker, _ = org_record()
    response = client_for(owner).patch(
        ONE.format(record.id, speaker.pk),
        {"user_id": None, "surprise": 1},
        format="json",
    )
    assert response.status_code == 400


def test_a_speaker_on_another_record_is_not_addressable():
    owner, record, speaker, organization = org_record()
    _, other, _, _ = org_record(owner=owner)
    response = client_for(owner).patch(
        ONE.format(other.id, speaker.pk), {"user_id": None}, format="json"
    )
    assert response.status_code == 404


def test_the_speaker_list_says_whether_this_reader_may_attribute():
    owner, record, speaker, organization = org_record()
    # The manager can, so the UI may offer the control.
    assert speakers(owner, record)[0]["can_attribute"] is True
    shared = MembershipFactory(organization=organization).user
    models.MeetingRecordAccess.objects.create(
        record=record, user=shared, read_transcript=True
    )
    # A plain reader cannot, so the control is not offered at all.
    assert speakers(shared, record)[0]["can_attribute"] is False


def test_an_unattributed_speaker_still_reads_as_its_label():
    owner, record, speaker, _ = org_record()
    assert speakers(owner, record)[0]["display_name"] == "Speaker 1"
    row = client_for(owner).get(SEGMENTS.format(record.id)).data["results"][0]
    assert row["speaker_label"] == "Speaker 1"


def test_a_deleted_account_leaves_the_label_behind():
    """Attribution is a convenience; losing the account must not lose the name of the track."""
    owner, record, speaker, organization = org_record()
    member = MembershipFactory(
        organization=organization, user__full_name="Ada Lovelace"
    ).user
    speaker_attribution.attribute(record, speaker.pk, owner, user_id=member.pk)
    member.delete()
    speaker.refresh_from_db()
    assert speaker.user_id is None
    assert speaker.display_name == "Speaker 1"
