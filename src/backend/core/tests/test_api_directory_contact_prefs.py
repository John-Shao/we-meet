"""API tests for the two per-contact flags (see ``ContactPreference``):

- 星标 (``is_starred``) — filing only, listed by ``/directory/starred/``
- 他的消息特别提醒 (``special_alert``) — notification behaviour

Both are set through ``PUT /api/v1.0/directory/contact-prefs/{user_id}/`` and are
**independent**; the tests below pin that independence down, since coupling them
is exactly the mistake this endpoint replaced.
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db

STARRED_URL = "/api/v1.0/directory/starred/"


def _prefs_url(user_id) -> str:
    return f"/api/v1.0/directory/contact-prefs/{user_id}/"


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


def test_contact_prefs_require_authentication():
    """Anonymous callers get nothing — these flags are personal state."""
    assert APIClient().get(STARRED_URL).status_code == 401
    assert APIClient().put(_prefs_url(factories.UserFactory().id)).status_code == 401


def test_star_is_idempotent_and_shows_up_in_the_list():
    """Starring twice leaves one row; GET /starred/ returns the card."""
    org, _me, client = _org_with_caller()
    peer = factories.UserFactory(full_name="Peer One", email="peer@acme.com")
    _membership(org, peer)

    for _ in range(2):
        response = client.put(_prefs_url(peer.id), {"is_starred": True}, format="json")
        assert response.status_code == 200, response.content
        # The card is serialized AFTER the write, so it already reads as starred.
        assert response.json()["id"] == str(peer.id)
        assert response.json()["is_starred"] is True
        assert response.json()["special_alert"] is False
    assert models.ContactPreference.objects.count() == 1

    response = client.get(STARRED_URL)
    assert response.status_code == 200
    # Bare array on purpose — a personal star list is short.
    assert [m["id"] for m in response.json()] == [str(peer.id)]


def test_special_alert_works_without_starring():
    """The whole point of splitting the two: 他的消息特别提醒 stands alone.

    An alert-only contact must NOT appear in 星标联系人 — that list is filing.
    """
    org, _me, client = _org_with_caller()
    peer = factories.UserFactory(full_name="Peer One", email="peer@acme.com")
    _membership(org, peer)

    card = client.put(
        _prefs_url(peer.id), {"special_alert": True}, format="json"
    ).json()
    assert card["special_alert"] is True
    assert card["is_starred"] is False
    assert client.get(STARRED_URL).json() == []

    row = models.ContactPreference.objects.get()
    assert (row.is_starred, row.special_alert) == (False, True)


def test_starring_does_not_touch_notifications_and_vice_versa():
    """Toggling one flag leaves the other alone (omitted keys are untouched)."""
    org, me, client = _org_with_caller()
    peer = factories.UserFactory(full_name="Peer One", email="peer@acme.com")
    _membership(org, peer)
    models.ContactPreference.objects.create(
        owner=me, target=peer, is_starred=True, special_alert=True
    )

    # Unstar only → the alert survives (this is the coupling regression guard).
    card = client.put(_prefs_url(peer.id), {"is_starred": False}, format="json").json()
    assert (card["is_starred"], card["special_alert"]) == (False, True)

    # Alert off only → nothing else to keep, so the row goes away entirely.
    card = client.put(
        _prefs_url(peer.id), {"special_alert": False}, format="json"
    ).json()
    assert (card["is_starred"], card["special_alert"]) == (False, False)
    assert models.ContactPreference.objects.count() == 0


def test_empty_body_is_a_no_op_read():
    """No keys → flags unchanged, current card returned."""
    org, me, client = _org_with_caller()
    peer = factories.UserFactory(full_name="Peer One", email="peer@acme.com")
    _membership(org, peer)
    models.ContactPreference.objects.create(owner=me, target=peer, is_starred=True)

    card = client.put(_prefs_url(peer.id), {}, format="json").json()
    assert (card["is_starred"], card["special_alert"]) == (True, False)
    assert models.ContactPreference.objects.count() == 1


def test_cannot_flag_self_or_a_stranger_from_another_org():
    """Self → 400; outside the caller's directory → 404 (never 'created')."""
    _org, me, client = _org_with_caller()
    other_org = factories.OrganizationFactory()
    stranger = factories.UserFactory(full_name="Stranger", email="x@other.com")
    _membership(other_org, stranger)

    assert (
        client.put(_prefs_url(me.id), {"is_starred": True}, format="json").status_code
        == 400
    )
    assert (
        client.put(
            _prefs_url(stranger.id), {"is_starred": True}, format="json"
        ).status_code
        == 404
    )
    assert models.ContactPreference.objects.count() == 0


def test_malformed_user_id_is_a_client_error_not_a_crash():
    """A garbage id must 400 rather than blow up the queryset."""
    _org, _me, client = _org_with_caller()
    assert (
        client.put(
            _prefs_url("not-a-uuid"), {"is_starred": True}, format="json"
        ).status_code
        == 400
    )


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
        models.ContactPreference.objects.create(
            owner=me, target=target, is_starred=True
        )

    names = [m["full_name"] for m in client.get(STARRED_URL).json()]
    assert names == ["Amy First", "Zoe Last"]

    # Membership no longer active → the row stays but the card stops showing.
    amy_membership.status = models.MembershipStatusChoices.LEFT
    amy_membership.save(update_fields=["status"])
    assert [m["full_name"] for m in client.get(STARRED_URL).json()] == ["Zoe Last"]
    assert models.ContactPreference.objects.filter(owner=me).count() == 3


def test_both_flags_ride_along_on_directory_and_department_member_cards():
    """`is_starred` / `special_alert` ride along on the normal directory
    surfaces, so the client renders both marks without a second round-trip."""
    org, me, client = _org_with_caller()
    department = models.Department.objects.create(organization=org, name="Eng")
    starred = factories.UserFactory(full_name="Starred One", email="s@acme.com")
    alerted = factories.UserFactory(full_name="Alerted One", email="a@acme.com")
    plain = factories.UserFactory(full_name="Plain One", email="p@acme.com")
    for user in (starred, alerted, plain):
        _membership(org, user, department=department)
    models.ContactPreference.objects.create(owner=me, target=starred, is_starred=True)
    models.ContactPreference.objects.create(
        owner=me, target=alerted, special_alert=True
    )

    def flags(url, key):
        return {m["id"]: m[key] for m in client.get(url).json()["results"]}

    members_url = "/api/v1.0/directory/members/"
    stars = flags(members_url, "is_starred")
    alerts = flags(members_url, "special_alert")
    assert (stars[str(starred.id)], alerts[str(starred.id)]) == (True, False)
    assert (stars[str(alerted.id)], alerts[str(alerted.id)]) == (False, True)
    assert (stars[str(plain.id)], alerts[str(plain.id)]) == (False, False)
    assert stars[str(me.id)] is False

    dept_url = f"/api/v1.0/directory/departments/{department.id}/members/"
    assert flags(dept_url, "is_starred")[str(starred.id)] is True
    assert flags(dept_url, "special_alert")[str(alerted.id)] is True

    detail = client.get(f"{members_url}{starred.id}/").json()
    assert (detail["is_starred"], detail["special_alert"]) == (True, False)


def test_prefs_list_returns_flags_only_for_client_side_sets():
    """GET /contact-prefs/ is the compact flags feed the clients cache.

    Unlike /starred/ it is not org-projected: a row whose target left the org
    still comes back (nobody renders it; it only feeds id sets).
    """
    org, me, client = _org_with_caller()
    starred = factories.UserFactory(full_name="Starred One", email="s@acme.com")
    alerted = factories.UserFactory(full_name="Alerted One", email="a@acme.com")
    _membership(org, starred)
    _membership(org, alerted)
    models.ContactPreference.objects.create(owner=me, target=starred, is_starred=True)
    models.ContactPreference.objects.create(
        owner=me, target=alerted, special_alert=True
    )

    rows = {r["user_id"]: r for r in client.get("/api/v1.0/directory/contact-prefs/").json()}
    assert rows[str(starred.id)] == {
        "user_id": str(starred.id),
        "is_starred": True,
        "special_alert": False,
    }
    assert rows[str(alerted.id)] == {
        "user_id": str(alerted.id),
        "is_starred": False,
        "special_alert": True,
    }


def test_flags_are_private_to_their_owner():
    """One member's flags never leak into another member's list or cards."""
    org, _me, client = _org_with_caller()
    peer = factories.UserFactory(full_name="Peer One", email="peer@acme.com")
    other = factories.UserFactory(full_name="Other Member", email="o@acme.com")
    _membership(org, peer)
    _membership(org, other)
    models.ContactPreference.objects.create(
        owner=other, target=peer, is_starred=True, special_alert=True
    )

    assert client.get(STARRED_URL).json() == []
    card = next(
        m
        for m in client.get("/api/v1.0/directory/members/").json()["results"]
        if m["id"] == str(peer.id)
    )
    assert (card["is_starred"], card["special_alert"]) == (False, False)
