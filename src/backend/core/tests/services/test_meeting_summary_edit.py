"""纪要闭环 P0-3 M2:纪要可编辑(PATCH summary)语义 + 权限 + 审计。"""

# pylint: disable=redefined-outer-name,unused-argument,protected-access

from unittest import mock

import pytest
from rest_framework.test import APIClient

from core.factories import OrganizationFactory, RoomFactory, UserFactory
from core.models import (
    AuditActionChoices,
    AuditLog,
    Membership,
    ResourceAccess,
    RoleChoices,
    Summary,
)
from core.services.meeting_summary import MeetingSummaryService

pytestmark = pytest.mark.django_db


def _setup(role=RoleChoices.OWNER):
    org = OrganizationFactory()
    user = UserFactory()
    Membership.objects.create(organization=org, user=user, is_primary=True)
    room = RoomFactory()
    if role is not None:
        ResourceAccess.objects.create(resource=room, user=user, role=role)
    summary = Summary.objects.create(
        room=room, content="## AI 原文", status=Summary.Status.SUCCESS
    )
    client = APIClient()
    client.force_login(user)
    return org, user, room, summary, client


def _url(room):
    return f"/api/v1.0/rooms/{room.id}/summary/"


def test_owner_edits_summary_and_audit_written():
    org, user, room, summary, client = _setup(RoleChoices.OWNER)

    resp = client.patch(_url(room), {"edited_content": "## 人工修订版"}, format="json")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["is_edited"] is True
    assert body["effective_content"] == "## 人工修订版"
    assert body["content"] == "## AI 原文"  # AI 原文永存
    assert body["edited_by"]["id"] == str(user.id)
    assert body["ai_updated_after_edit"] is False

    log = AuditLog.objects.get(action=AuditActionChoices.SUMMARY_EDIT)
    assert log.actor == user
    assert log.metadata == {"restored": False}


def test_admin_can_edit_plain_member_cannot():
    _, _, room, summary, admin_client = _setup(RoleChoices.ADMIN)
    assert (
        admin_client.patch(
            _url(room), {"edited_content": "x"}, format="json"
        ).status_code
        == 200
    )

    member = UserFactory()
    ResourceAccess.objects.create(
        resource=room, user=member, role=RoleChoices.MEMBER
    )
    member_client = APIClient()
    member_client.force_login(member)
    resp = member_client.patch(
        _url(room), {"edited_content": "y"}, format="json"
    )
    assert resp.status_code == 403


def test_empty_string_restores_ai_version():
    _, user, room, summary, client = _setup()
    client.patch(_url(room), {"edited_content": "编辑版"}, format="json")

    resp = client.patch(_url(room), {"edited_content": ""}, format="json")
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_edited"] is False
    assert body["effective_content"] == "## AI 原文"
    assert body["edited_by"] is None
    assert body["edited_at"] is None
    assert AuditLog.objects.filter(
        action=AuditActionChoices.SUMMARY_EDIT
    ).count() == 2
    assert (
        AuditLog.objects.order_by("-created_at").first().metadata["restored"]
        is True
    )


def test_regen_preserves_edit_and_flags_ai_update():
    """regen 只覆盖 content + content_generated_at,编辑版保留且提示翻真。"""
    _, user, room, summary, client = _setup()
    client.patch(_url(room), {"edited_content": "编辑版"}, format="json")

    svc = MeetingSummaryService(llm=mock.Mock())
    svc._persist(
        room=room,
        summary_text="## AI 原文 v2",
        items=[],
        chapters=[],
        transcripts=[],
        model_used="test",
    )

    resp = client.get(_url(room))
    body = resp.json()
    assert body["content"] == "## AI 原文 v2"
    assert body["effective_content"] == "编辑版"
    assert body["is_edited"] is True
    assert body["ai_updated_after_edit"] is True


def test_patch_requires_field_and_caps_length():
    _, _, room, summary, client = _setup()
    assert client.patch(_url(room), {}, format="json").status_code == 400
    assert (
        client.patch(
            _url(room), {"edited_content": "x" * 200_001}, format="json"
        ).status_code
        == 400
    )
