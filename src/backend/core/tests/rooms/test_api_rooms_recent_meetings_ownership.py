"""recent-meetings 归属标识:列表混着「我创建的」和「我只是参会的」。

删除房间只有房主可做(RoomPermissions:DELETE → is_owner),客户端据
``is_owner`` 收起删除入口,否则参会者点了吃 403。
"""

import pytest
from rest_framework.test import APIClient

from ...factories import RoomFactory, UserFactory
from ... import models

pytestmark = pytest.mark.django_db

RECENT = "/api/v1.0/rooms/recent-meetings/"


def _with_summary(room):
    """recent-meetings 只列有纪要的房间。"""
    models.Summary.objects.create(room=room, content="s")
    return room


def test_recent_meetings_marks_owned_and_attended():
    """自己建的 is_owner=True;只是参会的 is_owner=False。"""
    me = UserFactory()
    other = UserFactory()
    mine = _with_summary(RoomFactory(users=[(me, "owner")]))
    theirs = _with_summary(RoomFactory(users=[(other, "owner"), (me, "member")]))

    client = APIClient()
    client.force_login(me)
    resp = client.get(RECENT)

    assert resp.status_code == 200, resp.content
    flags = {row["id"]: row["is_owner"] for row in resp.json()}
    assert flags[str(mine.id)] is True
    assert flags[str(theirs.id)] is False


def test_attendee_cannot_delete_others_meeting():
    """归属标识与后端实际权限一致 —— 参会者删别人的会是 403。"""
    me = UserFactory()
    other = UserFactory()
    theirs = _with_summary(RoomFactory(users=[(other, "owner"), (me, "member")]))

    client = APIClient()
    client.force_login(me)
    assert client.delete(f"/api/v1.0/rooms/{theirs.id!s}/").status_code == 403
