"""Previewed grants never imply originals, messages, directory-wide access or replay writes."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.db import close_old_connections

import pytest

from core import models
from core.factories import (
    MeetingParticipationFactory,
    MembershipFactory,
    OrganizationFactory,
    UserFactory,
)
from core.services import meeting_summary_sharing as service
from core.services.meeting_records import RecordConflict, visible_records
from core.tests.services.test_meeting_records import audio_note, client_for, online_note

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_SUMMARY_SHARING_ENABLED = True


def fixture():
    org = OrganizationFactory()
    owner, peer = UserFactory(), UserFactory()
    for user in [owner, peer]:
        MembershipFactory(organization=org, user=user)
    return owner, peer, audio_note(owner, org)


def change(record, owner, peer, operation="grant", *, key=None):
    preview = service.preview(record, owner, [peer.pk], operation)
    receipt, replay = service.apply_share(
        record.pk,
        owner,
        key or uuid.uuid4(),
        [peer.pk],
        operation,
        preview["preview_hash"],
    )
    return preview, receipt, replay


def test_preview_has_no_side_effect_then_grants_summary_only():
    owner, peer, record = fixture()
    with patch("requests.request") as network:
        preview = service.preview(record, owner, [peer.pk], "grant")
        assert not record.accesses.exists()
        assert not preview["recipients"][0]["effective_summary"]
        assert preview["scope"] == "all_record_summary_versions"
        assert not preview["grants_media"] and not preview["sends_messages"]
        change(record, owner, peer)
        network.assert_not_called()
    assert visible_records(peer, ability="read_summary").filter(pk=record.pk).exists()
    assert (
        not visible_records(peer, ability="read_transcript")
        .filter(pk=record.pk)
        .exists()
    )
    assert not models.MeetingSummaryNotification.objects.exists()
    assert not models.MeetingSummaryExport.objects.exists()


def test_transcript_scope_grants_only_originals_and_replay_does_not_restore_revoked_access():
    owner, peer, record = fixture()
    ids = [peer.pk]
    preview = service.preview(record, owner, ids, "grant", "transcript")
    assert preview["scope"] == "record_transcript"
    assert preview["grants_originals"] and not preview["grants_media"]
    assert not preview["recipients"][0]["after_effective_summary"]
    assert preview["recipients"][0]["after_effective_transcript"]
    key = uuid.uuid4()
    service.apply_share(
        record.pk, owner, key, ids, "grant", preview["preview_hash"], "transcript"
    )
    grant = record.accesses.get(user=peer)
    assert grant.read_transcript and not grant.read_summary
    assert (
        visible_records(peer, ability="read_transcript").filter(pk=record.pk).exists()
    )
    revoke = service.preview(record, owner, ids, "revoke", "transcript")
    service.apply_share(
        record.pk,
        owner,
        uuid.uuid4(),
        ids,
        "revoke",
        revoke["preview_hash"],
        "transcript",
    )
    _, replayed = service.apply_share(
        record.pk, owner, key, ids, "grant", preview["preview_hash"], "transcript"
    )
    assert replayed and not record.accesses.exists()
    with pytest.raises(RecordConflict):
        service.apply_share(
            record.pk, owner, key, ids, "grant", preview["preview_hash"], "summary"
        )


def test_revoking_transcript_preserves_summary_and_inherited_original_access():
    owner, _, _, record = online_note()
    peer = UserFactory()
    models.ResourceAccess.objects.create(
        resource=record.meeting_session.room, user=peer, role=models.RoleChoices.MEMBER
    )
    models.MeetingRecordAccess.objects.create(
        record=record, user=peer, read_summary=True, read_transcript=True
    )
    preview = service.preview(record, owner, [peer.pk], "revoke", "transcript")
    recipient = preview["recipients"][0]
    assert recipient["after_effective_transcript"] and recipient["inherited_transcript"]
    assert recipient["after_explicit_summary"]
    service.apply_share(
        record.pk,
        owner,
        uuid.uuid4(),
        [peer.pk],
        "revoke",
        preview["preview_hash"],
        "transcript",
    )
    grant = record.accesses.get(user=peer)
    assert grant.read_summary and not grant.read_transcript


def test_transcript_api_requires_explicit_scope_and_preview_is_bound_to_that_scope():
    owner, peer, record = fixture()
    client = client_for(owner)
    path = f"/api/v1.0/meeting-records/{record.pk}/summary-sharing/"
    assert client.get(path).data["supported_scopes"] == ["summary", "transcript"]
    selection = {
        "user_ids": [str(peer.pk)],
        "operation": "grant",
        "access_scope": "transcript",
    }
    preview = client.post(path + "preview/", selection, format="json")
    assert preview.status_code == 200
    request = {**selection, "expected_hash": preview.data["preview_hash"]}
    response = client.post(
        path, request, format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4())
    )
    assert response.status_code == 200
    assert record.accesses.get(user=peer).read_transcript
    bad = client.post(
        path + "preview/", {**selection, "access_scope": "media"}, format="json"
    )
    assert bad.status_code == 400
    with pytest.raises(PermissionError):
        service.preview(record, peer, [owner.pk], "grant", "transcript")


def test_shared_reader_cannot_manage_or_reshare():
    owner, peer, record = fixture()
    change(record, owner, peer)
    with pytest.raises(PermissionError):
        service.preview(record, peer, [owner.pk], "grant")
    response = client_for(peer).get(
        f"/api/v1.0/meeting-records/{record.pk}/summary-sharing/"
    )
    assert response.status_code == 200
    assert response.data == {
        "available": False,
        "can_manage": False,
        "results": [],
        "next_cursor": None,
    }


def test_replayed_grant_after_revocation_does_not_restore_access(settings):
    owner, peer, record = fixture()
    key = uuid.uuid4()
    preview, receipt, _ = change(record, owner, peer, key=key)
    change(record, owner, peer, "revoke")
    settings.MEETING_SUMMARY_SHARING_ENABLED = False
    replayed, replay = service.apply_share(
        record.pk, owner, key, [peer.pk], "grant", preview["preview_hash"]
    )
    assert replay and replayed.pk == receipt.pk
    assert not record.accesses.exists()


def test_revoke_preserves_original_text_grant_and_inherited_room_access():
    owner, _, _, record = online_note()
    peer = UserFactory()
    models.ResourceAccess.objects.create(
        resource=record.meeting_session.room, user=peer, role=models.RoleChoices.MEMBER
    )
    models.MeetingRecordAccess.objects.create(
        record=record, user=peer, read_summary=True, read_transcript=True
    )
    preview, _, _ = change(record, owner, peer, "revoke")
    row = record.accesses.get(user=peer)
    assert not row.read_summary and row.read_transcript
    assert preview["recipients"][0]["inherited_summary"]
    assert preview["recipients"][0]["after_effective_summary"]
    assert visible_records(peer, ability="read_summary").filter(pk=record.pk).exists()


def test_stale_preview_never_overwrites_an_intervening_change():
    owner, peer, record = fixture()
    old = service.preview(record, owner, [peer.pk], "grant")
    change(record, owner, peer)
    with pytest.raises(RecordConflict):
        service.apply_share(
            record.pk, owner, uuid.uuid4(), [peer.pk], "grant", old["preview_hash"]
        )
    assert record.accesses.get(user=peer).read_summary


def test_cross_org_inactive_and_unrecognized_targets_are_rejected():
    owner, peer, record = fixture()
    other = UserFactory()
    MembershipFactory(user=other, organization=OrganizationFactory())
    for user_id in [other.pk, uuid.uuid4()]:
        with pytest.raises(RecordConflict):
            service.preview(record, owner, [user_id], "grant")
    models.User.objects.filter(pk=peer.pk).update(is_active=False)
    with pytest.raises(RecordConflict):
        service.preview(record, owner, [peer.pk], "grant")


def test_member_departure_between_preview_and_confirmation_prevents_grant():
    owner, peer, record = fixture()
    preview = service.preview(record, owner, [peer.pk], "grant")
    models.Membership.objects.filter(user=peer).delete()
    with pytest.raises(RecordConflict):
        service.apply_share(
            record.pk, owner, uuid.uuid4(), [peer.pk], "grant", preview["preview_hash"]
        )
    assert not record.accesses.exists()


def test_departed_user_existing_share_can_still_be_revoked():
    owner, peer, record = fixture()
    change(record, owner, peer)
    models.Membership.objects.filter(user=peer).delete()
    change(record, owner, peer, "revoke")
    assert not record.accesses.exists()


def test_participant_picker_uses_exact_session_and_known_accounts_only():
    owner, session, _, record = online_note()
    peer, other = UserFactory(), UserFactory()
    MeetingParticipationFactory(session=session, user=peer)
    MeetingParticipationFactory(session=session, user=peer)
    MeetingParticipationFactory(session=session, user=None)
    MeetingParticipationFactory(user=other)
    response = client_for(owner).get(
        f"/api/v1.0/meeting-records/{record.pk}/summary-sharing/candidates/?scope=participants"
    )
    assert response.status_code == 200
    assert [row["id"] for row in response.data["results"]] == [str(peer.pk)]
    assert not record.accesses.exists()


def test_directory_respects_record_org_not_another_primary_org():
    owner, peer, record = fixture()
    other = UserFactory()
    second = OrganizationFactory()
    MembershipFactory(organization=second, user=owner, is_primary=True)
    MembershipFactory(organization=second, user=other)
    response = client_for(owner).get(
        f"/api/v1.0/meeting-records/{record.pk}/summary-sharing/candidates/"
    )
    assert response.status_code == 200
    ids = {row["id"] for row in response.data["results"]}
    assert str(peer.pk) in ids and str(other.pk) not in ids


def test_api_requires_preview_hash_and_uuid_receipt_and_never_sends_messages():
    owner, peer, record = fixture()
    client = client_for(owner)
    path = f"/api/v1.0/meeting-records/{record.pk}/summary-sharing/"
    selection = {"user_ids": [str(peer.pk)], "operation": "grant"}
    preview = client.post(path + "preview/", selection, format="json")
    assert preview.status_code == 200 and "no-store" in preview["Cache-Control"]
    assert client.post(path, selection, format="json").status_code == 400
    response = client.post(
        path,
        {**selection, "expected_hash": preview.data["preview_hash"]},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 200 and not response.data["replayed"]
    assert not response.data["applied_preview"]["sends_messages"]
    assert (
        client.post(
            path + "preview/",
            {**selection, "user_ids": [str(peer.pk)] * 2},
            format="json",
        ).status_code
        == 400
    )


def test_disabled_flag_keeps_existing_grants_readable_but_blocks_new_changes(settings):
    owner, peer, record = fixture()
    change(record, owner, peer)
    settings.MEETING_SUMMARY_SHARING_ENABLED = False
    client = client_for(owner)
    path = f"/api/v1.0/meeting-records/{record.pk}/summary-sharing/"
    response = client.get(path)
    assert response.status_code == 200 and not response.data["available"]
    assert response.data["results"][0]["id"] == str(peer.pk)
    assert (
        client.post(
            path + "preview/",
            {"user_ids": [str(peer.pk)], "operation": "revoke"},
            format="json",
        ).status_code
        == 403
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_same_key_creates_one_grant_and_one_receipt():
    owner, peer, record = fixture()
    preview = service.preview(record, owner, [peer.pk], "grant")
    key = uuid.uuid4()

    def run():
        close_old_connections()
        try:
            return service.apply_share(
                record.pk, owner, key, [peer.pk], "grant", preview["preview_hash"]
            )[1]
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: run(), range(2))) == [False, True]
    assert record.accesses.count() == record.summary_share_requests.count() == 1
