"""API tests for 星标联系人: /api/v1.0/directory/starred/ (see StarredContact)."""

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db

STARRED_URL = "/api/v1.0/directory/starred/"


def _membership(org, user, department=None, is_primary=True, **kwargs):
    return models.Membership.objects.create(
        organization=org,
        user=user,
        department=department,
        is_primary=is_primary,
        **kwargs,
    )


def _org_with_caller():
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self", email="caller@acme.com")
    _membership(org, me)
    client = APIClient()
    client.force_login(me)
    return org, me, client


def test_starred_requires_authentication():
    """Anonymous callers get nothing — the list is personal state."""
    assert APIClient().get(STARRED_URL).status_code == 401


def test_star_is_idempotent_and_shows_up_in_the_list():
    """First POST 201, re-POST 200, one row either way; GET returns the card."""
    org, _me, client = _org_with_caller()
    peer = factories.UserFactory(full_name="Peer One", email="peer@acme.com")
    _membership(org, peer)

    response = client.post(STARRED_URL, {"user_id": str(peer.id)}, format="json")
    assert response.status_code == 201, response.content
    # The card is serialized AFTER the write, so it already reads as starred.
    assert response.json()["id"] == str(peer.id)
    assert response.json()["is_starred"] is True

    response = client.post(STARRED_URL, {"user_id": str(peer.id)}, format="json")
    assert response.status_code == 200, response.content
    assert models.StarredContact.objects.count() == 1

    response = client.get(STARRED_URL)
    assert response.status_code == 200
    # Bare array on purpose — a personal star list is short.
    assert [m["id"] for m in response.json()] == [str(peer.id)]


def test_unstar_is_idempotent():
    """DELETE removes the row; deleting again is still 204."""
    org, me, client = _org_with_caller()
    peer = factories.UserFactory(full_name="Peer One", email="peer@acme.com")
    _membership(org, peer)
    models.StarredContact.objects.create(owner=me, target=peer)

    for _ in range(2):
        response = client.delete(f"{STARRED_URL}{peer.id}/")
        assert response.status_code == 204, response.content
    assert models.StarredContact.objects.count() == 0
    assert client.get(STARRED_URL).json() == []


def test_cannot_star_self_or_a_stranger_from_another_org():
    """Self → 400; outside the caller's directory → 404 (never 'created')."""
    _org, me, client = _org_with_caller()
    other_org = factories.OrganizationFactory()
    stranger = factories.UserFactory(full_name="Stranger", email="x@other.com")
    _membership(other_org, stranger)

    assert (
        client.post(STARRED_URL, {"user_id": str(me.id)}, format="json").status_code
        == 400
    )
    assert (
        client.post(
            STARRED_URL, {"user_id": str(stranger.id)}, format="json"
        ).status_code
        == 404
    )
    assert models.StarredContact.objects.count() == 0


def test_malformed_user_id_is_a_client_error_not_a_crash():
    """A garbage id must 400 rather than blow up the queryset."""
    _org, _me, client = _org_with_caller()
    assert client.post(STARRED_URL, {"user_id": "not-a-uuid"}, format="json").status_code == 400
    assert client.post(STARRED_URL, {}, format="json").status_code == 400
    assert client.delete(f"{STARRED_URL}not-a-uuid/").status_code == 400


def test_list_is_ordered_by_name_and_drops_people_outside_the_org():
    """Cards come back in directory order; a star on someone no longer in the
    org silently disappears (the list is built from their Membership)."""
    org, me, client = _org_with_caller()
    zoe = factories.UserFactory(full_name="Zoe Last", email="zoe@acme.com")
    amy = factories.UserFactory(full_name="Amy First", email="amy@acme.com")
    _membership(org, zoe)
    amy_membership = _membership(org, amy)
    gone = factories.UserFactory(full_name="Gone Away", email="gone@acme.com")
    for target in (zoe, amy, gone):
        models.StarredContact.objects.create(owner=me, target=target)

    names = [m["full_name"] for m in client.get(STARRED_URL).json()]
    assert names == ["Amy First", "Zoe Last"]

    # Membership no longer active → the row stays but the card stops showing.
    amy_membership.status = models.MembershipStatusChoices.LEFT
    amy_membership.save(update_fields=["status"])
    assert [m["full_name"] for m in client.get(STARRED_URL).json()] == ["Zoe Last"]
    assert models.StarredContact.objects.filter(owner=me).count() == 3


def test_is_starred_flag_on_directory_and_department_member_cards():
    """`is_starred` rides along on the normal directory surfaces, so the client
    renders the star without a second round-trip."""
    org, me, client = _org_with_caller()
    department = models.Department.objects.create(organization=org, name="Eng")
    starred = factories.UserFactory(full_name="Starred One", email="s@acme.com")
    plain = factories.UserFactory(full_name="Plain One", email="p@acme.com")
    _membership(org, starred, department=department)
    _membership(org, plain, department=department)
    models.StarredContact.objects.create(owner=me, target=starred)

    flags = {
        m["id"]: m["is_starred"]
        for m in client.get("/api/v1.0/directory/members/").json()["results"]
    }
    assert flags[str(starred.id)] is True
    assert flags[str(plain.id)] is False
    assert flags[str(me.id)] is False

    flags = {
        m["id"]: m["is_starred"]
        for m in client.get(
            f"/api/v1.0/directory/departments/{department.id}/members/"
        ).json()["results"]
    }
    assert flags[str(starred.id)] is True
    assert flags[str(plain.id)] is False

    detail = client.get(f"/api/v1.0/directory/members/{starred.id}/").json()
    assert detail["is_starred"] is True


def test_stars_are_private_to_their_owner():
    """One member's stars never leak into another member's list or flags."""
    org, _me, client = _org_with_caller()
    peer = factories.UserFactory(full_name="Peer One", email="peer@acme.com")
    other = factories.UserFactory(full_name="Other Member", email="o@acme.com")
    _membership(org, peer)
    _membership(org, other)
    models.StarredContact.objects.create(owner=other, target=peer)

    assert client.get(STARRED_URL).json() == []
    flags = {
        m["id"]: m["is_starred"]
        for m in client.get("/api/v1.0/directory/members/").json()["results"]
    }
    assert flags[str(peer.id)] is False
