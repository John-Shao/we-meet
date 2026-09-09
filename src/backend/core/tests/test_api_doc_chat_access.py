"""The card permission API trusts only the session identity and IM roster."""

from unittest import mock

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.services.docs_client import DocsBadResponseError, DocsClient
from core.services.jusi_im import JusiImTokenResponse

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/im/doc-chat-access/"


@pytest.fixture
def setup(settings):
    settings.DOCS_CONFIGURATION = {
        "api_url": "https://docs.example.test",
        "server_to_server_token": "test",
    }
    actor, member = UserFactory(sub="actor"), UserFactory(im_uid="recipient")
    client = APIClient()
    client.force_login(actor)
    with mock.patch("core.api.im.JusiImAdminClient") as im:
        im.return_value.issue_token.return_value = JusiImTokenResponse(
            uid="sender", token="test", expires_at=1
        )
        im.return_value.get_members.return_value = [
            {"uid": "sender", "role": "owner"},
            {"uid": "recipient", "role": "member"},
        ]
        yield client, actor, member, im.return_value


@pytest.mark.parametrize("role", [None, "reader", "commenter", "editor"])
def test_read_or_update_uses_real_actor_and_members(setup, role):
    client, actor, member, _ = setup
    body = {
        "doc_id": "doc",
        "cid": "chat",
        "actor_sub": "forged",
        "users": [{"sub": "forged"}],
    }
    if role:
        body["role"] = role
    with mock.patch(
        "core.api.im.DocsClient.chat_access",
        return_value={"scoped": True, "role": role, "complete": True},
    ) as grant:
        assert client.post(URL, body, format="json").status_code == 200
    assert grant.call_args.kwargs["actor_sub"] == actor.sub
    if role:
        assert grant.call_args.kwargs["role"] == role
        assert grant.call_args.kwargs["users"] == [
            {"sub": member.sub, "email": member.email}
        ]
    else:
        assert "users" not in grant.call_args.kwargs


def test_non_member_cannot_read_or_modify_grants(setup):
    client, _, _, im = setup
    im.get_members.return_value = [{"uid": "someone-else", "role": "owner"}]
    with mock.patch("core.api.im.DocsClient.chat_access") as grant:
        assert (
            client.post(
                URL, {"doc_id": "doc", "cid": "chat", "role": "editor"}, format="json"
            ).status_code
            == 403
        )
        grant.assert_not_called()


def test_unresolved_member_fails_without_partial_grant(setup):
    client, _, _, im = setup
    im.get_members.return_value.append({"uid": "unknown", "role": "member"})
    with mock.patch("core.api.im.DocsClient.chat_access") as grant:
        assert (
            client.post(
                URL, {"doc_id": "doc", "cid": "chat", "role": "reader"}, format="json"
            ).status_code
            == 500
        )
        grant.assert_not_called()


@pytest.mark.parametrize(
    "reply",
    [
        {"granted": 1},
        {"scoped": True, "role": "reader", "complete": True},
        {"scoped": True, "role": "editor", "complete": False},
    ],
)
def test_client_rejects_old_or_incomplete_response(reply):
    client = DocsClient("https://docs.example.test", "test")
    with mock.patch("core.services.docs_client.requests.post") as post:
        post.return_value = mock.Mock(json=lambda: reply)
        with pytest.raises(DocsBadResponseError):
            client.chat_access(
                doc_id="doc", cid="chat", actor_sub="actor", role="editor", users=[]
            )
