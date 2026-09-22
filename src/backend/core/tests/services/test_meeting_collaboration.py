"""Independent object roles, link access, transfers and retry receipts."""

import uuid
from unittest import mock

import pytest

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services import meeting_collaboration as service
from core.services.meeting_records import RecordConflict, visible_records
from core.services.meeting_summary_review import can_edit
from core.tests.services.test_meeting_records import audio_note, client_for

pytestmark = pytest.mark.django_db


@pytest.fixture
def material(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_SUMMARY_SHARING_ENABLED = True
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    org = OrganizationFactory()
    owner, peer, third = UserFactory(), UserFactory(), UserFactory()
    for user in (owner, peer, third):
        MembershipFactory(organization=org, user=user)
    return audio_note(owner, org), owner, peer, third


def change(record, actor, scope, operation="invite", members=None, **kwargs):
    body = {
        "operation": operation,
        "expected_revision": service.state(record, actor, scope)["revision"],
        **kwargs,
    }
    if members is not None:
        body["members"] = [{"id": str(user.pk), "role": role} for user, role in members]
    return service.change(record.pk, actor, scope, uuid.uuid4(), body)


def reads(record, user, ability):
    return visible_records(user, ability=ability).filter(pk=record.pk).exists()


def test_independent_readers_and_editors(material):
    record, owner, peer, third = material
    change(record, owner, "record", members=[(peer, "reader")])
    assert reads(record, peer, "read_transcript")
    assert not reads(record, peer, "read_summary")

    change(record, owner, "minutes", members=[(peer, "editor")])
    assert can_edit(record, peer)
    assert not service.can_manage(record, peer, "record")
    assert not service.can_manage(record, peer, "minutes")
    change(record, owner, "record", "remove", [(peer, "reader")])
    assert not reads(record, peer, "read_transcript")
    assert reads(record, peer, "read_summary")


def test_record_invite_exposes_stopped_capture_but_not_device_controls(
    material, settings
):
    from core.tests.services.test_meeting_record_library import capture

    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    record, owner, peer, _ = material
    source = capture(record, stopped=True)
    change(record, owner, "record", members=[(peer, "reader")])
    client = client_for(peer)
    metadata = client.get(f"/api/v1.0/meeting-records/{record.pk}/").json()
    assert metadata["capture_id"] == str(source.pk)
    assert metadata["capabilities"]["control_capture"] is False
    response = client.get(f"/api/v1.0/capture-sessions/{source.pk}/")
    assert response.status_code == 200
    assert response.json()["device_id"] == ""
    assert "audio_retention" not in response.json()
    change(record, owner, "record", "remove", [(peer, "reader")])
    assert client.get(f"/api/v1.0/capture-sessions/{source.pk}/").status_code == 404


def test_trash_restore_does_not_restore_collaboration(material, settings):
    from core.services.record_lifecycle import transition

    settings.MEETING_RECORD_TRASH_ENABLED = True
    record, owner, peer, _ = material
    change(record, owner, "record", members=[(peer, "reader")])
    change(record, owner, "minutes", "link", link_scope="organization")
    transition(record.pk, owner, "trashed", 0)
    transition(record.pk, owner, "active", 1)
    assert not reads(record, peer, "read_transcript")
    assert not reads(record, peer, "read_summary")


def test_notification_retry_freezes_outbound_message(material, settings):
    from types import SimpleNamespace
    from unittest.mock import patch
    from core.services import collaboration_notifications as notices

    record, owner, peer, _ = material
    settings.JUSI_IM_CONFIGURATION = {
        "api_url": "http://unused",
        "admin_hmac_secret": "test",
    }
    change(record, owner, "minutes", members=[(peer, "reader")], notify=True)
    notice = models.MeetingCollaborationNotice.objects.get()
    with (
        patch.object(notices, "available", return_value=True),
        patch.object(notices, "JusiImAdminClient"),
        patch.object(notices, "resolve_uid", return_value=str(peer.pk)),
        patch.object(notices.im_bots, "get_builtin"),
        patch.object(
            notices.im_bots, "resolve_bot_uid", return_value=str(uuid.uuid4())
        ),
        patch.object(notices, "ImDeliveryClient") as delivery,
    ):
        delivery.return_value.create.side_effect = [
            TimeoutError(),
            SimpleNamespace(state="ready"),
        ]
        notices.deliver(notice.pk)
        record.title = "Changed after uncertain delivery"
        record.save(update_fields=["title"])
        notices.deliver(notice.pk)
        assert (
            delivery.return_value.create.call_args_list[0]
            == delivery.return_value.create.call_args_list[1]
        )
        notice.refresh_from_db()
        assert notice.status == "sent"


def test_manager_cannot_change_other_object_or_transfer(material):
    record, owner, peer, third = material
    change(record, owner, "minutes", members=[(peer, "manager")])
    change(record, peer, "minutes", members=[(third, "reader")])
    with pytest.raises(PermissionError):
        service.change(
            record.pk,
            peer,
            "record",
            uuid.uuid4(),
            {"operation": "link", "expected_revision": 0, "link_scope": "organization"},
        )
    with pytest.raises(PermissionError):
        change(record, peer, "minutes", "transfer", [(third, "reader")])


def test_link_access_is_independent_and_removal_preserves_link_read(material):
    record, owner, peer, third = material
    change(record, owner, "minutes", "link", link_scope="organization")
    assert reads(record, peer, "read_summary")
    assert not reads(record, peer, "read_transcript")
    change(record, owner, "minutes", members=[(peer, "editor")])
    change(record, owner, "minutes", "remove", [(peer, "reader")])
    assert reads(record, peer, "read_summary")
    assert not can_edit(record, peer)
    change(record, owner, "minutes", "link", link_scope="private")
    assert not reads(record, peer, "read_summary")
    assert not reads(record, UserFactory(), "read_summary")


def test_transfer_changes_only_one_owner_and_does_not_restore_on_replay(material):
    record, owner, peer, third = material
    change(record, owner, "minutes", members=[(peer, "reader")])
    body = {
        "operation": "transfer",
        "expected_revision": 1,
        "members": [{"id": str(peer.pk), "role": "reader"}],
    }
    key = uuid.uuid4()
    service.change(record.pk, owner, "minutes", key, body)
    assert service.state(record, peer, "minutes")["is_owner"]
    assert service.state(record, owner, "record")["is_owner"]
    assert not service.state(record, owner, "minutes")["is_owner"]
    service.change(record.pk, owner, "minutes", key, body)
    assert service.state(record, peer, "minutes")["revision"] == 2


def test_legacy_summary_grant_does_not_read_overview(material):
    record, owner, peer, third = material
    models.MeetingRecordAccess.objects.create(
        record=record, user=peer, read_summary=True
    )
    client = client_for(peer)
    assert (
        client.get(f"/api/v1.0/meeting-records/{record.pk}/overview/").status_code
        == 403
    )
    change(record, owner, "record", members=[(peer, "reader")])
    assert (
        client.get(f"/api/v1.0/meeting-records/{record.pk}/overview/").status_code
        == 200
    )


def test_stale_revision_rejected_and_old_transcript_never_gets_media(material):
    record, owner, peer, third = material
    models.MeetingRecordAccess.objects.create(
        record=record, user=peer, read_transcript=True
    )
    assert not visible_records(peer).get(pk=record.pk).collaboration_media
    change(record, owner, "record", members=[(third, "reader")])
    with pytest.raises(RecordConflict):
        service.change(
            record.pk,
            owner,
            "record",
            uuid.uuid4(),
            {"operation": "link", "expected_revision": 0, "link_scope": "organization"},
        )


def test_member_rows_carry_a_presigned_avatar_and_teams_fall_back_to_initials(
    material,
):
    record, owner, peer, third = material
    models.User.objects.filter(pk=owner.pk).update(avatar_key="avatar-key-1")
    with mock.patch(
        "core.services.meeting_collaboration.utils.generate_profile_image_get_url",
        side_effect=lambda kind, key: f"https://oss/{kind}/{key}" if key else "",
    ):
        state = service.state(record, owner, "record")
    assert state["results"][0]["avatar_url"] == "https://oss/avatar/avatar-key-1"


def test_api_validates_scope_roles_and_duplicate_recipients(material):
    record, owner, peer, third = material
    client = client_for(owner)
    path = f"/api/v1.0/meeting-records/{record.pk}/collaboration/record/"
    listed = client.get(path).json()
    assert listed["count"] == 1
    assert listed["results"][0]["avatar_url"] == ""
    member = {"id": str(peer.pk), "role": "reader"}
    headers = {"HTTP_IDEMPOTENCY_KEY": str(uuid.uuid4())}
    assert (
        client.post(
            path,
            {
                "operation": "invite",
                "expected_revision": 0,
                "members": [member, member],
            },
            format="json",
            **headers,
        ).status_code
        == 400
    )
    assert (
        client.post(
            path,
            {"operation": "invite", "expected_revision": 0, "members": [member]},
            format="json",
            **headers,
        ).status_code
        == 200
    )
    assert client.get(path.replace("record/", "other/")).status_code == 404
    assert client_for(peer).get(path.replace("record/", "minutes/")).status_code == 404


def test_team_membership_changes_and_private_previews(material):
    from core.factories import DepartmentFactory

    record, owner, peer, third = material
    department = DepartmentFactory(organization=record.organization)
    models.Membership.objects.filter(user=peer).update(department=department)
    payload = {
        "operation": "invite",
        "expected_revision": 0,
        "members": [{"id": department.team_key, "role": "reader"}],
    }
    service.change(record.pk, owner, "record", uuid.uuid4(), payload)
    assert reads(record, peer, "read_transcript")
    assert not reads(record, peer, "read_summary")
    client = client_for(peer)
    path = f"/api/v1.0/meeting-records/{record.pk}/collaboration/"
    assert client.get(path + "record/preview/").json()["role"] == "reader"
    assert client.get(path + "minutes/preview/").status_code == 404
    models.Membership.objects.filter(user=peer).update(department=None)
    assert not reads(record, peer, "read_transcript")


def test_notifications_are_durable_and_do_not_reapply_grants(material):
    from unittest.mock import patch

    record, owner, peer, third = material
    payload = {
        "operation": "invite",
        "expected_revision": 0,
        "members": [{"id": str(peer.pk), "role": "reader"}],
        "notify": True,
        "note": "Please review",
    }
    key = uuid.uuid4()
    with patch("core.services.collaboration_notifications.dispatch"):
        service.change(record.pk, owner, "minutes", key, payload)
        notice = models.MeetingCollaborationNotice.objects.get()
        assert notice.recipient == peer and notice.note == "Please review"
        change(record, owner, "minutes", "remove", [(peer, "reader")])
        service.change(record.pk, owner, "minutes", key, payload)
    assert models.MeetingCollaborationNotice.objects.count() == 1
    assert not reads(record, peer, "read_summary")
