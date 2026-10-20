"""Account-scoped AI conversation sync: text only, idempotent and owner-fenced."""

from datetime import timedelta

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/ai-call/conversations/"
CLIENT = "3c3f3e54-3e9b-4e6d-b4ed-6ad0d1f63d9d"


def body(**overrides):
    now = timezone.now()
    value = {
        "client_id": CLIENT,
        "device_id": "test-device",
        "kind": "call",
        "title": "",
        "started_at": (now - timedelta(minutes=2)).isoformat(),
        "ended_at": now.isoformat(),
        "status": "completed",
        "summary": "完成一次测试通话",
        "todos": [{"text": "跟进", "done": False}],
        "messages": [
            {"client_id": "m1", "position": 0, "role": "user", "text": "你好"},
            {"client_id": "m2", "position": 1, "role": "assistant", "text": "你好，有什么可以帮你？"},
        ],
    }
    value.update(overrides)
    return value


def test_create_list_and_detail_are_owner_scoped():
    user = UserFactory()
    client = APIClient()
    client.force_authenticate(user)
    created = client.post(URL, body(), format="json")
    assert created.status_code == 201
    assert created.data["client_id"] == CLIENT
    assert created.data["message_count"] == 2
    assert created.data["title"] == "你好"
    assert [message["client_id"] for message in created.data["messages"]] == ["m1", "m2"]

    listing = client.get(URL)
    assert listing.status_code == 200
    assert len(listing.data["conversations"]) == 1
    assert listing.data["conversations"][0]["client_id"] == CLIENT

    detail = client.get(f"{URL}{created.data['id']}/")
    assert detail.status_code == 200
    assert len(detail.data["messages"]) == 2

    other = APIClient()
    other.force_authenticate(UserFactory())
    assert other.get(f"{URL}{created.data['id']}/").status_code == 404
    assert other.delete(f"{URL}{created.data['id']}/").status_code == 404


def test_snapshot_is_idempotent_and_replaces_messages():
    client = APIClient()
    client.force_authenticate(UserFactory())
    first = client.post(URL, body(), format="json")
    assert first.status_code == 201
    second = client.post(
        URL,
        body(
            status="interrupted",
            summary="已中断",
            messages=[
                {"client_id": "m3", "position": 0, "role": "user", "text": "新内容"},
            ],
        ),
        format="json",
    )
    assert second.status_code == 200
    assert second.data["id"] == first.data["id"]
    assert second.data["version"] == 2
    assert second.data["status"] == "interrupted"
    assert [message["client_id"] for message in second.data["messages"]] == ["m3"]


def test_deleted_conversation_is_not_resurrected():
    client = APIClient()
    client.force_authenticate(UserFactory())
    created = client.post(URL, body(), format="json")
    assert client.delete(f"{URL}{created.data['id']}/").status_code == 204
    assert client.get(URL).data["conversations"] == []
    again = client.post(URL, body(), format="json")
    assert again.status_code == 410


def test_duplicate_ids_and_reversed_time_are_rejected():
    client = APIClient()
    client.force_authenticate(UserFactory())
    now = timezone.now()
    duplicate = client.post(
        URL,
        body(messages=[
            {"client_id": "same", "position": 0, "role": "user", "text": "a"},
            {"client_id": "same", "position": 1, "role": "assistant", "text": "b"},
        ]),
        format="json",
    )
    assert duplicate.status_code == 400
    reversed_time = client.post(
        URL,
        body(started_at=now.isoformat(), ended_at=(now - timedelta(seconds=1)).isoformat()),
        format="json",
    )
    assert reversed_time.status_code == 400
