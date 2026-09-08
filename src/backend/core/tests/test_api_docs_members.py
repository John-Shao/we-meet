"""Only authorized directory IDs are mapped to trusted Docs identities."""

import uuid
from unittest import mock

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services.docs_client import DocsBadResponseError, DocsClient

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/docs/member-access/"


@pytest.fixture
def setup(settings):
    settings.DOCS_CONFIGURATION = {
        "api_url": "https://docs.example.test",
        "server_to_server_token": "test",
    }
    org = factories.OrganizationFactory()
    actor, peer = factories.UserFactory(email=None), factories.UserFactory(email=None)
    for user in (actor, peer):
        models.Membership.objects.create(user=user, organization=org, is_primary=True)
    client = APIClient()
    client.force_login(actor)
    return client, actor, peer


def test_no_email_and_forged_identity_fields_are_ignored(setup):
    client, actor, peer = setup
    with mock.patch(
        "core.api.docs_members.DocsClient.member_access",
        return_value={
            "results": [{"sub": peer.sub, "status": "added"}],
            "identity": "sub",
            "role": "editor",
        },
    ) as grant:
        response = client.post(
            URL,
            {
                "doc_id": str(uuid.uuid4()),
                "user_ids": [str(peer.id)],
                "role": "editor",
                "actor_sub": "forged",
                "users": [{"sub": "forged"}],
                "email": "wrong@example.test",
            },
            format="json",
        )
    assert response.status_code == 200, response.content
    assert grant.call_args.kwargs["actor_sub"] == actor.sub
    assert grant.call_args.kwargs["users"] == [
        {"sub": peer.sub, "full_name": peer.full_name or peer.short_name or ""}
    ]
    assert response.json()["results"] == [{"user_id": str(peer.id), "status": "added"}]


def test_roster_returns_directory_ids(setup):
    client, _, peer = setup
    with mock.patch(
        "core.api.docs_members.DocsClient.member_access",
        return_value={"member_subs": [peer.sub]},
    ):
        response = client.get(URL, {"doc_id": str(uuid.uuid4())})
    assert response.json() == {"user_ids": [str(peer.id)]}


@pytest.mark.parametrize("kind", ["outside", "inactive", "device", "unknown"])
def test_outside_or_unavailable_users_cannot_be_granted(setup, kind):
    client, _, peer = setup
    if kind == "outside":
        peer = factories.UserFactory()
    elif kind == "inactive":
        peer.is_active = False
        peer.save()
    elif kind == "device":
        peer.is_device = True
        peer.save()
    user_id = str(uuid.uuid4()) if kind == "unknown" else str(peer.id)
    with mock.patch("core.api.docs_members.DocsClient.member_access") as grant:
        assert (
            client.post(
                URL,
                {"doc_id": str(uuid.uuid4()), "user_ids": [user_id], "role": "reader"},
                format="json",
            ).status_code
            == 403
        )
    grant.assert_not_called()


def test_no_auth_invalid_roles_and_legacy_server_fail_closed(setup):
    client, _, peer = setup
    body = {"doc_id": str(uuid.uuid4()), "user_ids": [str(peer.id)], "role": "owner"}
    assert client.post(URL, body, format="json").status_code == 400
    body["role"] = "reader"
    with mock.patch(
        "core.api.docs_members.DocsClient.member_access",
        side_effect=DocsBadResponseError("old server"),
    ):
        assert client.post(URL, body, format="json").status_code >= 500
    assert APIClient().post(URL, body, format="json").status_code in (401, 403)


def test_client_rejects_old_or_missing_acknowledgement():
    client = DocsClient("https://docs.example.test", "test")
    with mock.patch("core.services.docs_client.requests.post") as post:
        post.return_value.json.return_value = {"granted": 1}
        with pytest.raises(DocsBadResponseError):
            client.member_access(
                doc_id="doc", actor_sub="actor", role="reader", users=[{"sub": "peer"}]
            )
