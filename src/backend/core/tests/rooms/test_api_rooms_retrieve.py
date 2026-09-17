"""
Test rooms API endpoints in the Meet core app: retrieve.
"""

import random
from unittest import mock

from django.contrib.auth.models import AnonymousUser
from django.test.utils import override_settings

import pytest
from rest_framework.fields import DateTimeField
from rest_framework.test import APIClient

from ...factories import RoomFactory, UserFactory, UserResourceAccessFactory
from ...models import RoomAccessLevel

pytestmark = pytest.mark.django_db


def room_payload(room, *, is_owner=False, is_administrable=False, granted=False):
    """`GET /rooms/{id}/` 的完整响应形状。

    这些用例按完整字段比对（防字段悄悄增减），所以形状集中在这里：序列化器加字段时
    只改这一处，不用改 11 个断言。`pin_code` 只在真给了 LiveKit 凭据时出现 —— 详见
    `RoomSerializer.to_representation`。
    """
    payload = {
        "id": str(room.id),
        "name": room.name,
        "slug": room.slug,
        "configuration": room.configuration,
        "access_level": str(room.access_level),
        "created_at": DateTimeField().to_representation(room.created_at),
        "closed_at": room.ended_at.isoformat() if room.ended_at else "",
        "owner": room_owner_display(room),
        "scheduled_at": (
            DateTimeField().to_representation(room.scheduled_at)
            if room.scheduled_at
            else None
        ),
        "event_id": None,
        "is_administrable": is_administrable,
        "is_owner": is_owner,
    }
    if granted:
        payload["pin_code"] = room.pin_code
        payload["livekit"] = {
            "url": "test_url_value",
            "room": str(room.id),
            "token": "foo",
        }
    return payload


def room_owner_display(room):
    """`RoomSerializer.get_owner` 的回显：OWNER 那条 access 的姓名/短名/邮箱。"""

    access = room.accesses.filter(role="owner").select_related("user").first()
    if access is None:
        return None
    user = access.user
    return user.full_name or user.short_name or user.email or None


def test_api_rooms_retrieve_anonymous_private_pk():
    """
    Anonymous users should be allowed to retrieve a private room but should not be
    given any token.
    """
    room = RoomFactory(access_level=RoomAccessLevel.RESTRICTED)
    client = APIClient()
    response = client.get(f"/api/v1.0/rooms/{room.id!s}/")

    assert response.status_code == 200
    assert response.json() == room_payload(room)


def test_api_rooms_retrieve_anonymous_trusted_pk():
    """
    Anonymous users should be allowed to retrieve a room that has a trusted access_level,
    but should not be given any token.
    """
    room = RoomFactory(access_level=RoomAccessLevel.TRUSTED)
    client = APIClient()
    response = client.get(f"/api/v1.0/rooms/{room.id!s}/")

    assert response.status_code == 200
    assert response.json() == room_payload(room)


def test_api_rooms_retrieve_anonymous_private_pk_no_dashes():
    """It should be possible to get a room by its id stripped of its dashes."""
    room = RoomFactory(access_level=RoomAccessLevel.RESTRICTED)
    id_no_dashes = str(room.id)

    client = APIClient()
    response = client.get(f"/api/v1.0/rooms/{id_no_dashes:s}/")

    assert response.status_code == 200
    assert response.json() == room_payload(room)


def test_api_rooms_retrieve_anonymous_private_slug():
    """It should be possible to get a room by its slug."""
    room = RoomFactory(access_level=RoomAccessLevel.RESTRICTED)
    client = APIClient()
    response = client.get(f"/api/v1.0/rooms/{room.slug!s}/")

    assert response.status_code == 200
    assert response.json() == room_payload(room)


@override_settings(ALLOW_UNREGISTERED_ROOMS=True)
@override_settings(
    LIVEKIT_CONFIGURATION={
        "api_key": "key",
        "api_secret": "secret",
        "url": "test_url_value",
    }
)
@mock.patch("core.utils.generate_token", return_value="foo")
def test_api_rooms_retrieve_anonymous_unregistered_allowed(mock_token):
    """
    Retrieving an unregistered room should return a Livekit token
    if unregistered rooms are allowed.
    """
    client = APIClient()
    response = client.get("/api/v1.0/rooms/unregistered-room/")

    assert response.status_code == 200
    assert response.json() == {
        "id": None,
        "livekit": {
            "url": "test_url_value",
            "room": "unregistered-room",
            "token": "foo",
        },
    }

    mock_token.assert_called_once_with(
        room="unregistered-room", user=AnonymousUser(), username=None
    )


@override_settings(ALLOW_UNREGISTERED_ROOMS=True)
@override_settings(
    LIVEKIT_CONFIGURATION={
        "api_key": "key",
        "api_secret": "secret",
        "url": "test_url_value",
    }
)
@mock.patch("core.utils.generate_token", return_value="foo")
def test_api_rooms_retrieve_anonymous_unregistered_allowed_not_normalized(mock_token):
    """
    Getting an unregistered room by a slug that is not normalized should work
    and use the Livekit room on the url-safe name.
    """
    client = APIClient()
    response = client.get("/api/v1.0/rooms/Réunion/")

    assert response.status_code == 200
    assert response.json() == {
        "id": None,
        "livekit": {
            "url": "test_url_value",
            "room": "reunion",
            "token": "foo",
        },
    }

    mock_token.assert_called_once_with(
        room="reunion", user=AnonymousUser(), username=None
    )


@override_settings(ALLOW_UNREGISTERED_ROOMS=False)
def test_api_rooms_retrieve_anonymous_unregistered_not_allowed():
    """
    Retrieving an unregistered room should return a 404 if unregistered rooms are not allowed.
    """
    client = APIClient()
    response = client.get("/api/v1.0/rooms/unregistered-room/")

    assert response.status_code == 404
    assert response.json() == {"detail": "No Room matches the given query."}


@mock.patch("core.utils.generate_token", return_value="foo")
@override_settings(
    LIVEKIT_CONFIGURATION={
        "api_key": "key",
        "api_secret": "secret",
        "url": "test_url_value",
    }
)
def test_api_rooms_retrieve_anonymous_public(mock_token):
    """
    Anonymous users should be able to retrieve a room with a token provided, if the room is public.
    """
    room = RoomFactory(access_level=RoomAccessLevel.PUBLIC)
    client = APIClient()
    response = client.get(f"/api/v1.0/rooms/{room.id!s}/")

    assert response.status_code == 200
    assert response.json() == room_payload(room, granted=True)

    mock_token.assert_called_once()


@mock.patch("core.utils.generate_token", return_value="foo")
@override_settings(
    LIVEKIT_CONFIGURATION={
        "api_key": "key",
        "api_secret": "secret",
        "url": "test_url_value",
    }
)
def test_api_rooms_retrieve_authenticated_public(mock_token):
    """
    Authenticated users should be allowed to retrieve a room and get a token for a room to
    which they are not related, provided the room is public.
    They should not see related users.
    """
    room = RoomFactory(
        access_level=RoomAccessLevel.PUBLIC,
        configuration={"can_publish_sources": ["camera"]},
    )

    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    response = client.get(
        f"/api/v1.0/rooms/{room.id!s}/",
    )
    assert response.status_code == 200

    expected_name = f"{room.id!s}"
    assert response.json() == room_payload(room, granted=True)

    mock_token.assert_called_once_with(
        room=expected_name,
        user=user,
        username=None,
        color=None,
        sources=["camera"],
        is_admin_or_owner=False,
        participant_id=None,
    )


@mock.patch("core.utils.generate_token", return_value="foo")
@override_settings(
    LIVEKIT_CONFIGURATION={
        "api_key": "key",
        "api_secret": "secret",
        "url": "test_url_value",
    }
)
def test_api_rooms_retrieve_authenticated_trusted(mock_token):
    """
    Authenticated users should be allowed to retrieve a room and get a token for a room to
    which they are not related, provided the room has a trusted access_level.
    They should not see related users.
    """
    room = RoomFactory(access_level=RoomAccessLevel.TRUSTED)

    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    response = client.get(
        f"/api/v1.0/rooms/{room.id!s}/",
    )
    assert response.status_code == 200

    expected_name = f"{room.id!s}"
    assert response.json() == room_payload(room, granted=True)

    mock_token.assert_called_once_with(
        room=expected_name,
        user=user,
        username=None,
        color=None,
        sources=None,
        is_admin_or_owner=False,
        participant_id=None,
    )


def test_api_rooms_retrieve_authenticated():
    """
    Authenticated users should be allowed to retrieve a private room to which they
    are not related but should not be given any token.
    """
    room = RoomFactory(access_level=RoomAccessLevel.RESTRICTED)

    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    response = client.get(
        f"/api/v1.0/rooms/{room.id!s}/",
    )
    assert response.status_code == 200

    assert response.json() == room_payload(room)


@mock.patch("core.utils.generate_token", return_value="foo")
@override_settings(
    LIVEKIT_CONFIGURATION={
        "api_key": "key",
        "api_secret": "secret",
        "url": "test_url_value",
    }
)
def test_api_rooms_retrieve_members(mock_token, django_assert_num_queries, settings):
    """
    Users who are members of a room should not be allowed to see related users.
    """
    settings.TIME_ZONE = "UTC"
    user = UserFactory()
    other_user = UserFactory()

    room = RoomFactory(
        configuration={"can_publish_sources": ["camera"]},
    )
    UserResourceAccessFactory(resource=room, user=user, role="member")
    UserResourceAccessFactory(resource=room, user=other_user, role="member")

    client = APIClient()
    client.force_login(user)

    # 序列化器为了 owner / event_id 各多查一次,加上权限判定,单间详情固定 6 条。
    with django_assert_num_queries(6):
        response = client.get(
            f"/api/v1.0/rooms/{room.id!s}/",
        )

    assert response.status_code == 200
    content_dict = response.json()

    assert "accesses" not in content_dict

    expected_name = str(room.id)
    assert content_dict == room_payload(room, granted=True)

    mock_token.assert_called_once_with(
        room=expected_name,
        user=user,
        username=None,
        color=None,
        sources=["camera"],
        is_admin_or_owner=False,
        participant_id=None,
    )


@mock.patch("core.utils.generate_token", return_value="foo")
@override_settings(
    LIVEKIT_CONFIGURATION={
        "api_key": "key",
        "api_secret": "secret",
        "url": "test_url_value",
    }
)
def test_api_rooms_retrieve_administrators(
    mock_token, django_assert_num_queries, settings
):
    """
    A user who is an administrator or owner of a room should be allowed
    to see related users.
    """
    settings.TIME_ZONE = "UTC"
    user = UserFactory()
    other_user = UserFactory()
    room = RoomFactory()
    user_access = UserResourceAccessFactory(
        resource=room, user=user, role=random.choice(["administrator", "owner"])
    )
    other_user_access = UserResourceAccessFactory(
        resource=room, user=other_user, role="member"
    )
    client = APIClient()
    client.force_login(user)

    # 管理员多取一次 accesses,再加上 owner / event_id,单间详情固定 7 条。
    with django_assert_num_queries(7):
        response = client.get(
            f"/api/v1.0/rooms/{room.id!s}/",
        )
    assert response.status_code == 200
    content_dict = response.json()

    assert sorted(content_dict.pop("accesses"), key=lambda x: x["id"]) == sorted(
        [
            {
                "id": str(other_user_access.id),
                "user": {
                    "id": str(other_user_access.user.id),
                    "email": other_user_access.user.email,
                    "full_name": other_user_access.user.full_name,
                    "short_name": other_user_access.user.short_name,
                    "timezone": "UTC",
                    "language": other_user_access.user.language,
                    "avatar_url": "",
                    "cover_url": "",
                    "intro": "",
                    "phone": "",
                },
                "resource": str(room.id),
                "role": other_user_access.role,
            },
            {
                "id": str(user_access.id),
                "user": {
                    "id": str(user_access.user.id),
                    "email": user_access.user.email,
                    "full_name": user_access.user.full_name,
                    "short_name": user_access.user.short_name,
                    "timezone": "UTC",
                    "language": user_access.user.language,
                    "avatar_url": "",
                    "cover_url": "",
                    "intro": "",
                    "phone": "",
                },
                "resource": str(room.id),
                "role": user_access.role,
            },
        ],
        key=lambda x: x["id"],
    )
    expected_name = str(room.id)
    assert content_dict == room_payload(
        room,
        granted=True,
        is_administrable=True,
        is_owner=user_access.role == "owner",
    )

    mock_token.assert_called_once_with(
        room=expected_name,
        user=user,
        username=None,
        color=None,
        sources=None,
        is_admin_or_owner=True,
        participant_id=None,
    )
