"""
Test rooms API endpoints in the Meet core app: create.
"""

# pylint: disable=redefined-outer-name,unused-argument
import re
from datetime import timedelta

from django.core.cache import cache
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from ... import models
from ...factories import MeetingSessionFactory, RoomFactory, UserFactory
from ...models import Room

pytestmark = pytest.mark.django_db


@pytest.fixture
def reset_cache():
    """Provide cache cleanup after each test to maintain test isolation."""
    yield
    keys = cache.keys("room-creation-callback_*")
    if keys:
        cache.delete(*keys)


def test_api_rooms_create_anonymous():
    """Anonymous users should not be allowed to create rooms."""
    client = APIClient()

    response = client.post(
        "/api/v1.0/rooms/",
        {
            "name": "my room",
        },
    )

    assert response.status_code == 401
    assert Room.objects.exists() is False


def test_api_rooms_create_reuses_the_callers_unstarted_room():
    """点两次「快速会议」应该是同一个房间,而不是攒两个空房。

    线上实测:两天建了 46 个房,其中只有 3 个真的进过房 —— 都是「先建房、再进房」
    但没进成的残留。同名的、自己建的、还没开始过的房间直接复用。
    """
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    first = client.post("/api/v1.0/rooms/", {"name": "老酒的会议"})
    assert first.status_code == 201
    second = client.post("/api/v1.0/rooms/", {"name": "老酒的会议"})

    assert second.status_code == 200, "复用已有房间时返回 200,不是 201"
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["slug"] == first.json()["slug"]
    assert Room.objects.count() == 1


def test_api_rooms_create_makes_a_new_room_after_the_first_one_started():
    """开过会的房间不复用:下一次是真的新会议。"""
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    first = client.post("/api/v1.0/rooms/", {"name": "老酒的会议"})
    MeetingSessionFactory(room=Room.objects.get(id=first.json()["id"]))

    second = client.post("/api/v1.0/rooms/", {"name": "老酒的会议"})

    assert second.status_code == 201
    assert second.json()["id"] != first.json()["id"]
    assert Room.objects.count() == 2


def test_api_rooms_create_makes_a_new_room_after_the_first_one_ended():
    """结束后(含被 close_abandoned_rooms 清掉的)不复用。"""
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    first = client.post("/api/v1.0/rooms/", {"name": "老酒的会议"})
    Room.objects.filter(id=first.json()["id"]).update(ended_at=timezone.now())

    second = client.post("/api/v1.0/rooms/", {"name": "老酒的会议"})

    assert second.status_code == 201
    assert second.json()["id"] != first.json()["id"]


def test_api_rooms_create_with_a_schedule_never_reuses():
    """「预约会议」带着时间:那是新的一场安排,不能并进已有的空房。"""
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    client.post("/api/v1.0/rooms/", {"name": "老酒的会议"})
    scheduled = client.post(
        "/api/v1.0/rooms/",
        {
            "name": "老酒的会议",
            "scheduled_at": (timezone.now() + timedelta(days=1)).isoformat(),
        },
    )

    assert scheduled.status_code == 201
    assert Room.objects.count() == 2
    assert Room.objects.filter(scheduled_at__isnull=False).count() == 1


def test_api_rooms_create_does_not_reuse_someone_elses_room():
    """同名的别人的房间不能抢。"""
    owner = UserFactory()
    owner_client = APIClient()
    owner_client.force_login(owner)
    owner_client.post("/api/v1.0/rooms/", {"name": "老酒的会议"})

    other = UserFactory()
    client = APIClient()
    client.force_login(other)
    response = client.post("/api/v1.0/rooms/", {"name": "老酒的会议"})

    assert response.status_code == 201
    assert Room.objects.count() == 2


def test_api_rooms_create_keeps_distinct_names_distinct():
    """不同名字(快速会议 / 与某人的通话 / 某群的视频会议)各自建房。"""
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    for name in ("老酒的会议", "与 W002 的通话", "测试2群的视频会议"):
        assert client.post("/api/v1.0/rooms/", {"name": name}).status_code == 201

    assert Room.objects.count() == 3


def test_api_rooms_create_authenticated(reset_cache):
    """
    Authenticated users should be able to create rooms and should automatically be declared
    as owner of the newly created room.
    """
    user = UserFactory()

    client = APIClient()
    client.force_login(user)

    response = client.post(
        "/api/v1.0/rooms/",
        {
            "name": "my room",
        },
    )

    assert response.status_code == 201
    room = Room.objects.get()
    assert room.name == "my room"
    # 会议号不再是名字的 slugify,而是服务端生成的 8 位数字(Room.generate_unique_slug)。
    assert re.fullmatch(r"\d{8}", room.slug)
    assert room.accesses.filter(role="owner", user=user).exists() is True

    rooms_data = cache.keys("room-creation-callback_*")
    assert not rooms_data


def test_api_rooms_create_generation_cache(reset_cache):
    """
    Authenticated users creating a room with a callback ID should have room data stored in cache.
    """
    user = UserFactory()

    client = APIClient()
    client.force_login(user)

    response = client.post(
        "/api/v1.0/rooms/",
        {"name": "my room", "callback_id": "1234"},
    )

    assert response.status_code == 201
    room = Room.objects.get()
    assert room.name == "my room"
    assert re.fullmatch(r"\d{8}", room.slug)
    assert room.accesses.filter(role="owner", user=user).exists() is True

    room_data = cache.get("room-creation-callback_1234")
    assert room_data.get("slug") == room.slug


def test_api_rooms_create_gives_each_room_its_own_meeting_code():
    """
    同名建房不再撞 slug:会议号由服务端生成,和名字无关,所以两个「my room」各有各的号。
    """
    user = UserFactory()

    client = APIClient()
    client.force_login(user)

    first = client.post("/api/v1.0/rooms/", {"name": "my room"})
    second = client.post("/api/v1.0/rooms/", {"name": "My Room!"})

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["slug"] != second.json()["slug"]
    assert Room.objects.count() == 2


def test_generate_unique_slug_skips_a_code_that_is_taken(monkeypatch):
    """
    生成器撞上已有会议号时必须重试,而不是把重复值返回出去(那会撞唯一约束)。

    secrets.randbelow 被喂成「先返回已占用的号、再返回下一个」,验证它真的重试了。
    注意显式给一个数字会议号:RoomFactory 默认用的是名字的 slugify,与生产不一致。
    """
    taken = RoomFactory(slug="00123456").slug

    values = iter([int(taken), int(taken) + 1])
    monkeypatch.setattr(models.secrets, "randbelow", lambda _max: next(values))

    assert Room().generate_unique_slug() != taken
