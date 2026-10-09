"""Editorial identity privacy, stale-write protection and reader projections."""

import importlib
from types import SimpleNamespace

from django.apps import apps
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction

import pytest

from core import models
from core.factories import DepartmentFactory, MembershipFactory, UserFactory
from core.services import speaker_contacts, speaker_identity_decisions
from core.services.transcript_export import render, rows_for
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_speaker_attribution import org_record
from core.tests.services.test_transcript_corrections import captured_segment

pytestmark = pytest.mark.django_db
CONTACTS = "/api/v1.0/meeting-records/{}/speaker-contacts/"
DECISION = "/api/v1.0/meeting-records/{}/speakers/{}/identity-decision/"
LEGACY = "/api/v1.0/meeting-records/{}/speakers/{}/"
SEGMENTS = "/api/v1.0/meeting-records/{}/original-segments/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = True


def decide(owner, record, speaker, action, **payload):
    record.refresh_from_db()
    return client_for(owner).post(
        DECISION.format(record.pk, speaker.pk),
        {"action": action, "expected_revision": record.revision, **payload},
        format="json",
    )


def external(actor, other, status="accepted"):
    first, second = models.ExternalContact.canonical_pair(actor, other)
    return models.ExternalContact.objects.create(
        user_a=first, user_b=second, requested_by=actor, status=status
    )


def test_custom_label_updates_python_sql_and_revision_without_changing_source():
    owner, record, speaker, _ = org_record()
    old_revision = record.revision
    response = decide(owner, record, speaker, "set_label", label="  Guest A  ")
    assert response.status_code == 200, response.data
    assert response.data["display_name"] == "Guest A"
    assert response.data["record_revision"] == old_revision + 1
    assert response.data["attribution_kind"] == "custom"
    speaker.refresh_from_db()
    assert speaker.display_name == "Guest A"
    assert speaker.label == "Speaker 1"
    assert speaker.identity_type == "diarized"
    row = client_for(owner).get(SEGMENTS.format(record.pk)).data["results"][0]
    assert row["speaker_label"] == "Guest A"
    decision = record.identity_decisions.get()
    assert decision.actor == owner
    assert decision.action == "set_label"
    assert decision.previous_label == ""
    assert decision.selected_label == "Guest A"
    assert decision.record_revision == old_revision + 1
    decision.selected_label = "rewrite"
    with pytest.raises(ValidationError):
        decision.full_clean()


def test_stale_editor_cannot_overwrite_and_identical_retry_adds_no_audit():
    owner, record, speaker, _ = org_record()
    first_revision = record.revision
    assert decide(owner, record, speaker, "set_label", label="Ada").status_code == 200
    response = client_for(owner).post(
        DECISION.format(record.pk, speaker.pk),
        {"action": "clear", "expected_revision": first_revision},
        format="json",
    )
    assert response.status_code == 409
    assert decide(owner, record, speaker, "set_label", label="Ada").status_code == 200
    assert record.identity_decisions.count() == 1
    speaker.refresh_from_db()
    assert speaker.display_name == "Ada"


def test_member_contact_and_custom_transitions_are_mutually_exclusive():
    owner, record, speaker, organization = org_record()
    member = MembershipFactory(organization=organization, user__full_name="Ada").user
    decide(owner, record, speaker, "set_label", label="Guest")
    response = decide(
        owner, record, speaker, "select_contact", contact_ref=f"member:{member.pk}"
    )
    assert response.status_code == 200, response.data
    assert response.data["manual_label"] == ""
    assert response.data["attributed_user_id"] == str(member.pk)
    assert response.data["attribution_kind"] == "member"
    decide(owner, record, speaker, "set_label", label="Host")
    speaker.refresh_from_db()
    assert speaker.user_id is None
    assert speaker.contact_source_id is None
    assert speaker.display_name == "Host"
    assert decide(owner, record, speaker, "clear").data["display_name"] == "Speaker 1"
    speaker.refresh_from_db()
    assert speaker.attributed_by_id is None
    assert speaker.attributed_at is None


def test_external_contact_is_name_snapshot_not_cross_org_member_or_private_data():
    owner, record, speaker, _ = org_record()
    target = MembershipFactory(user__full_name="External Ada").user
    relation = external(owner, target)
    response = client_for(owner).get(CONTACTS.format(record.pk), {"kind": "external"})
    assert response.status_code == 200
    card = response.data["results"][0]
    assert card["ref"] == f"external:{relation.pk}"
    assert card["name"] == "External Ada"
    assert not {"email", "phone", "remarks", "avatar_url"} & card.keys()
    result = decide(owner, record, speaker, "select_contact", contact_ref=card["ref"])
    assert result.status_code == 200, result.data
    assert result.data["attributed_user_id"] is None
    assert result.data["attribution_kind"] == "contact"
    assert result.data["display_name"] == "External Ada"
    assert "contact_source" not in result.data
    target.full_name = "Renamed"
    target.save()
    relation.delete()
    speaker.refresh_from_db()
    assert speaker.contact_source_id is None
    assert speaker.display_name == "External Ada"


@pytest.mark.parametrize("status", ["pending", "declined"])
def test_unaccepted_relationships_cannot_be_listed_or_selected(status):
    owner, record, speaker, _ = org_record()
    relation = external(owner, UserFactory(), status=status)
    result = client_for(owner).get(CONTACTS.format(record.pk), {"kind": "external"})
    assert result.data["results"] == []
    assert (
        decide(
            owner,
            record,
            speaker,
            "select_contact",
            contact_ref=f"external:{relation.pk}",
        ).status_code
        == 400
    )


def test_contact_from_another_editors_private_directory_is_not_selectable():
    owner, record, speaker, _ = org_record()
    relation = external(UserFactory(), UserFactory())
    response = decide(
        owner, record, speaker, "select_contact", contact_ref=f"external:{relation.pk}"
    )
    assert response.status_code == 400
    assert not record.identity_decisions.exists()


def test_member_leaving_or_contact_revocation_between_lookup_and_write_is_rechecked():
    owner, record, speaker, organization = org_record()
    membership = MembershipFactory(organization=organization)
    models.Membership.objects.filter(pk=membership.pk).update(status="left")
    assert (
        decide(
            owner,
            record,
            speaker,
            "select_contact",
            contact_ref=f"member:{membership.user_id}",
        ).status_code
        == 400
    )
    relation = external(owner, UserFactory())
    ref = f"external:{relation.pk}"
    relation.delete()
    assert (
        decide(owner, record, speaker, "select_contact", contact_ref=ref).status_code
        == 400
    )


@pytest.mark.parametrize(
    "label", ["", "  ", "x" * 65, "Ada\nGuest", "Ada\t", "A\u202eB"]
)
def test_invalid_labels_do_not_change_the_record(label):
    owner, record, speaker, _ = org_record()
    assert decide(owner, record, speaker, "set_label", label=label).status_code == 400
    assert not record.identity_decisions.exists()


def test_contact_snapshot_cannot_be_forged_in_the_request():
    owner, record, speaker, _ = org_record()
    response = decide(
        owner,
        record,
        speaker,
        "select_contact",
        contact_ref=f"member:{owner.pk}",
        label="Forged",
    )
    assert response.status_code == 400
    response = decide(owner, record, speaker, "clear", user_id=str(owner.pk))
    assert response.status_code == 400


def test_readers_cannot_lookup_contacts_or_edit_labels():
    owner, record, speaker, organization = org_record()
    reader = MembershipFactory(organization=organization).user
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_transcript=True
    )
    assert client_for(reader).get(CONTACTS.format(record.pk)).status_code == 403
    assert decide(reader, record, speaker, "set_label", label="Host").status_code == 403


def test_contact_lookup_paginates_and_filters_without_exposing_strangers():
    owner, record, _, organization = org_record()
    MembershipFactory(organization=organization, user__full_name="Ada")
    MembershipFactory(organization=organization, user__full_name="Grace")
    outsider = UserFactory(full_name="Stranger")
    first = speaker_contacts.lookup(record, owner, limit=1)
    assert len(first["results"]) == 1
    assert first["next_offset"] == 1
    second = speaker_contacts.lookup(record, owner, limit=1, offset=1)
    assert first["results"][0]["ref"] != second["results"][0]["ref"]
    result = speaker_contacts.lookup(record, owner, query="grace")
    assert [item["name"] for item in result["results"]] == ["Grace"]
    assert not any(item["ref"] == f"member:{outsider.pk}" for item in result["results"])


def test_legacy_patch_uses_the_same_clear_mutual_exclusion_and_audit_rules():
    owner, record, speaker, organization = org_record()
    member = MembershipFactory(organization=organization).user
    decide(owner, record, speaker, "set_label", label="Guest")
    response = client_for(owner).patch(
        LEGACY.format(record.pk, speaker.pk), {"user_id": str(member.pk)}, format="json"
    )
    assert response.status_code == 200, response.data
    assert response.data["manual_label"] == ""
    assert record.identity_decisions.count() == 2
    assert (
        client_for(owner)
        .patch(LEGACY.format(record.pk, speaker.pk), {"user_id": None}, format="json")
        .status_code
        == 200
    )
    assert record.identity_decisions.count() == 3


def test_database_rejects_member_and_label_even_if_service_is_bypassed():
    owner, _, speaker, _ = org_record()
    with pytest.raises(IntegrityError), transaction.atomic():
        models.MeetingSpeaker.objects.filter(pk=speaker.pk).update(
            user=owner, manual_label="Guest"
        )


def test_personal_record_does_not_allow_legacy_global_user_binding():
    owner, record, segment = captured_segment()
    speaker = segment.speaker
    stranger = UserFactory()
    response = client_for(owner).patch(
        LEGACY.format(record.pk, speaker.pk),
        {"user_id": str(stranger.pk)},
        format="json",
    )
    assert response.status_code == 400


def test_same_names_do_not_merge_source_speakers():
    owner, record, speaker, _ = org_record()
    other = models.MeetingSpeaker.objects.create(
        record=record,
        capture_session=speaker.capture_session,
        source_track_id="track",
        source_key="1",
        label="Speaker 2",
        identity_type="diarized",
    )
    speaker_identity_decisions.decide(
        record, speaker.pk, owner, action="set_label", label="Guest"
    )
    speaker_identity_decisions.decide(
        record, other.pk, owner, action="set_label", label="Guest"
    )
    assert record.speakers.count() == 2
    assert record.identity_decisions.count() == 2


def test_department_choices_and_member_filter_stay_within_record_organization():
    owner, record, _, organization = org_record()
    department = DepartmentFactory(organization=organization, name="Research")
    member = MembershipFactory(organization=organization, department=department).user
    outside = DepartmentFactory(name="Private department")
    MembershipFactory(organization=outside.organization, department=outside)
    page = client_for(owner).get(CONTACTS.format(record.pk), {"kind": "departments"})
    assert page.status_code == 200, page.data
    offered = {item["ref"] for item in page.data["results"]}
    assert str(department.pk) in offered
    assert str(outside.pk) not in offered
    page = client_for(owner).get(
        CONTACTS.format(record.pk), {"department_id": str(department.pk)}
    )
    assert [item["ref"] for item in page.data["results"]] == [f"member:{member.pk}"]
    page = client_for(owner).get(
        CONTACTS.format(record.pk), {"department_id": str(outside.pk)}
    )
    assert page.data["results"] == []


def test_audio_transcript_export_uses_custom_label_as_plain_text():
    owner, record, speaker, _ = org_record()
    decide(owner, record, speaker, "set_label", label="Guest <A>")
    rows = rows_for(record)
    assert rows[0].speaker == "Guest <A>"
    assert "Guest <A>" in render("txt", rows)
    assert "Guest &lt;A&gt;" in render("vtt", rows)


def test_migration_backfills_members_without_treating_source_labels_as_manual_labels():
    owner, record, speaker, _ = org_record()
    models.MeetingSpeaker.objects.filter(pk=speaker.pk).update(user=owner)
    migration = importlib.import_module(
        "core.migrations.0200_speaker_identity_decisions"
    )
    migration.backfill_members(
        apps, SimpleNamespace(connection=SimpleNamespace(alias="default"))
    )
    speaker.refresh_from_db()
    assert speaker.attribution_kind == "member"
    assert speaker.manual_label == ""
    assert speaker.label == "Speaker 1"
    assert not record.identity_decisions.exists()


def test_legacy_clear_removes_a_custom_label_and_restores_original_source():
    owner, record, speaker, _ = org_record()
    decide(owner, record, speaker, "set_label", label="Guest")
    response = client_for(owner).patch(
        LEGACY.format(record.pk, speaker.pk), {"user_id": None}, format="json"
    )
    assert response.status_code == 200, response.data
    assert response.data["display_name"] == "Speaker 1"
    assert response.data["attribution_kind"] == "none"
