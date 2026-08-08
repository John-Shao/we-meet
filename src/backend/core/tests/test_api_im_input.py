import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db


def _client(role=models.OrgRoleChoices.MEMBER):
    organization = factories.OrganizationFactory()
    user = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization,
        user=user,
        org_role=role,
        is_primary=True,
    )
    client = APIClient()
    client.force_login(user)
    return client, user, organization


def test_draft_crud_is_user_scoped():
    client, user, _ = _client()
    saved = client.put(
        "/api/v1.0/im/drafts/c-1/",
        {
            "text": "跨端草稿",
            "reply": {"mid": "9", "sender": "小李", "summary": "原消息"},
        },
        format="json",
    )
    assert saved.status_code == 200, saved.content
    assert saved.json()["cid"] == "c-1"
    assert models.ImDraft.objects.get(user=user, cid="c-1").text == "跨端草稿"

    listed = client.get("/api/v1.0/im/drafts/")
    assert listed.status_code == 200
    assert [item["cid"] for item in listed.json()] == ["c-1"]

    assert client.delete("/api/v1.0/im/drafts/c-1/").status_code == 204
    assert not models.ImDraft.objects.filter(user=user).exists()


def test_draft_rejects_over_4000_unicode_characters():
    client, _, _ = _client()
    response = client.put(
        "/api/v1.0/im/drafts/c-1/", {"text": "好" * 4001, "reply": None}, format="json"
    )
    assert response.status_code == 400


def test_recent_emoji_deduplicates_caps_and_filters_disabled_custom():
    client, user, organization = _client()
    active = models.OrganizationEmoji.objects.create(
        organization=organization,
        name="OK",
        object_key=f"emoji/{organization.id}/ok.png",
        content_type="image/png",
        byte_size=10,
        width=16,
        height=16,
        created_by=user,
    )
    disabled = models.OrganizationEmoji.objects.create(
        organization=organization,
        name="OFF",
        object_key=f"emoji/{organization.id}/off.png",
        content_type="image/png",
        byte_size=10,
        width=16,
        height=16,
        is_active=False,
        created_by=user,
    )
    entries = [
        {"kind": "unicode", "value": "😀"},
        {"kind": "unicode", "value": "😀"},
        {"kind": "custom", "id": str(active.id)},
        {"kind": "custom", "id": str(disabled.id)},
    ] + [{"kind": "unicode", "value": str(i)} for i in range(30)]
    response = client.patch(
        "/api/v1.0/im/preferences/", {"recent_emojis": entries}, format="json"
    )
    assert response.status_code == 200, response.content
    recent = response.json()["recent_emojis"]
    assert len(recent) == 24
    assert sum(item.get("value") == "😀" for item in recent) == 1
    assert any(item.get("id") == str(active.id) for item in recent)
    assert not any(item.get("id") == str(disabled.id) for item in recent)


def test_custom_emoji_admin_upload_create_and_soft_disable(monkeypatch):
    client, _, organization = _client(models.OrgRoleChoices.ADMIN)
    monkeypatch.setattr(
        "core.api.im_input.utils.inspect_custom_emoji_object",
        lambda key: {
            "content_type": "image/gif",
            "byte_size": 128,
            "width": 32,
            "height": 32,
            "is_animated": True,
        },
    )
    key = f"emoji/{organization.id}/wave.gif"
    created = client.post(
        "/api/v1.0/admin/im-emojis/",
        {"name": "Wave", "object_key": key},
        format="json",
    )
    assert created.status_code == 201, created.content
    emoji_id = created.json()["id"]
    assert created.json()["animated"] is True

    assert client.delete(f"/api/v1.0/admin/im-emojis/{emoji_id}/").status_code == 204
    assert models.OrganizationEmoji.objects.get(id=emoji_id).is_active is False
    assert client.get("/api/v1.0/im/custom-emojis/").json() == []


def test_plain_member_cannot_manage_custom_emojis():
    client, _, _ = _client()
    assert client.get("/api/v1.0/admin/im-emojis/").status_code == 403
