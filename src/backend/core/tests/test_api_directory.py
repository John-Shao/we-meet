"""
API tests for the directory (通讯录) endpoints.
"""

from unittest import mock

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db


def _membership(org, user, department=None, is_primary=True, **kwargs):
    """Helper to create an active membership."""
    return models.Membership.objects.create(
        organization=org,
        user=user,
        department=department,
        is_primary=is_primary,
        **kwargs,
    )


def test_api_directory_members_requires_authentication():
    """Anonymous users cannot browse the directory."""
    response = APIClient().get("/api/v1.0/directory/members/")
    assert response.status_code == 401


def test_api_directory_members_scoped_to_caller_organization():
    """A member sees their own org's people, never another org's."""
    org = factories.OrganizationFactory()
    other_org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self", email="caller@acme.com")
    _membership(org, me)
    peer = factories.UserFactory(full_name="Peer One", email="peer@acme.com")
    _membership(org, peer)
    stranger = factories.UserFactory(full_name="Stranger", email="x@other.com")
    _membership(other_org, stranger)

    client = APIClient()
    client.force_login(me)
    response = client.get("/api/v1.0/directory/members/")

    assert response.status_code == 200
    ids = {m["id"] for m in response.json()["results"]}
    assert str(peer.id) in ids
    assert str(me.id) in ids
    assert str(stranger.id) not in ids


def test_api_directory_members_excludes_device_accounts():
    """AI/device accounts must not appear in the human directory."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self", email="caller@acme.com")
    _membership(org, me)
    bot = factories.UserFactory(full_name="AI Bot", email="bot@acme.com", is_device=True)
    _membership(org, bot)

    client = APIClient()
    client.force_login(me)
    response = client.get("/api/v1.0/directory/members/")

    ids = {m["id"] for m in response.json()["results"]}
    assert str(bot.id) not in ids


def test_api_directory_members_search_by_query():
    """?q= filters on name and email."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self", email="caller@acme.com")
    _membership(org, me)
    alice = factories.UserFactory(full_name="Alice Anderson", email="alice@acme.com")
    _membership(org, alice)
    bob = factories.UserFactory(full_name="Bob Brown", email="bob@acme.com")
    _membership(org, bob)

    client = APIClient()
    client.force_login(me)
    response = client.get("/api/v1.0/directory/members/?q=alice")

    assert response.status_code == 200
    ids = {m["id"] for m in response.json()["results"]}
    assert ids == {str(alice.id)}


def test_api_directory_member_retrieve_by_user_id_flags_self():
    """Retrieve a member card by we-meet user id; is_self marks the caller."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self", email="caller@acme.com")
    _membership(org, me, department=None)

    client = APIClient()
    client.force_login(me)
    response = client.get(f"/api/v1.0/directory/members/{me.id}/")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(me.id)
    assert body["is_self"] is True


# ---- P3 phone: masking + reveal ----


def test_api_directory_phone_masked_for_others_full_for_self():
    """Others' phone is masked (138****1990); own card carries the full number."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Me", email="me@acme.com", phone="13800001990")
    peer = factories.UserFactory(
        full_name="Peer", email="peer@acme.com", phone="13911112222"
    )
    _membership(org, me)
    _membership(org, peer)

    client = APIClient()
    client.force_login(me)

    peer_card = client.get(f"/api/v1.0/directory/members/{peer.id}/").json()
    assert peer_card["phone"] == "139****2222"  # first 3 + last 4

    self_card = client.get(f"/api/v1.0/directory/members/{me.id}/").json()
    assert self_card["phone"] == "13800001990"  # full for self


def test_api_directory_phone_empty_when_unset():
    """No phone → empty string, never a masked '****'."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(email="me@acme.com")
    peer = factories.UserFactory(email="peer@acme.com", phone="")
    _membership(org, me)
    _membership(org, peer)

    client = APIClient()
    client.force_login(me)
    card = client.get(f"/api/v1.0/directory/members/{peer.id}/").json()
    assert card["phone"] == ""


def test_api_reveal_phone_returns_full_and_notifies():
    """reveal-phone returns the full number and fires the owner notice."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(email="me@acme.com")
    peer = factories.UserFactory(email="peer@acme.com", phone="13911112222")
    _membership(org, me)
    _membership(org, peer)

    client = APIClient()
    client.force_login(me)
    with mock.patch("core.api.directory.send_phone_viewed_notice") as notice:
        resp = client.post(f"/api/v1.0/directory/members/{peer.id}/reveal-phone/")

    assert resp.status_code == 200
    assert resp.json()["phone"] == "13911112222"
    notice.assert_called_once()


def test_api_reveal_phone_self_no_notice():
    """Revealing own number returns it but sends no notice."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(email="me@acme.com", phone="13800001990")
    _membership(org, me)

    client = APIClient()
    client.force_login(me)
    with mock.patch("core.api.directory.send_phone_viewed_notice") as notice:
        resp = client.post(f"/api/v1.0/directory/members/{me.id}/reveal-phone/")

    assert resp.status_code == 200
    assert resp.json()["phone"] == "13800001990"
    notice.assert_not_called()


def test_api_reveal_phone_cross_org_404():
    """A member from another org is invisible → reveal 404, no notice."""
    org = factories.OrganizationFactory()
    other = factories.OrganizationFactory()
    me = factories.UserFactory(email="me@acme.com")
    stranger = factories.UserFactory(email="s@other.com", phone="13777778888")
    _membership(org, me)
    _membership(other, stranger)

    client = APIClient()
    client.force_login(me)
    with mock.patch("core.api.directory.send_phone_viewed_notice") as notice:
        resp = client.post(
            f"/api/v1.0/directory/members/{stranger.id}/reveal-phone/"
        )

    assert resp.status_code == 404
    notice.assert_not_called()


def test_api_reveal_phone_notice_failure_still_returns():
    """A jusi hiccup in the notice must not fail the reveal."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(email="me@acme.com")
    peer = factories.UserFactory(email="peer@acme.com", phone="13911112222")
    _membership(org, me)
    _membership(org, peer)

    client = APIClient()
    client.force_login(me)
    with mock.patch(
        "core.api.directory.send_phone_viewed_notice",
        side_effect=RuntimeError("jusi down"),
    ):
        resp = client.post(f"/api/v1.0/directory/members/{peer.id}/reveal-phone/")

    assert resp.status_code == 200
    assert resp.json()["phone"] == "13911112222"


def test_api_directory_departments_scoped_and_listed():
    """Department list returns the caller org's tree, not other orgs'."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    root = models.Department.objects.create(organization=org, name="Root")
    models.Department.objects.create(organization=org, name="Child", parent=root)
    other_org = factories.OrganizationFactory()
    models.Department.objects.create(organization=other_org, name="Foreign")

    client = APIClient()
    client.force_login(me)
    response = client.get("/api/v1.0/directory/departments/")

    assert response.status_code == 200
    names = [d["name"] for d in response.json()]
    assert "Root" in names
    assert "Child" in names
    assert "Foreign" not in names


def test_api_directory_department_members_action():
    """departments/{id}/members lists that department's members."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    eng = models.Department.objects.create(organization=org, name="Engineering")
    dev = factories.UserFactory(full_name="Dev One")
    _membership(org, dev, department=eng)

    client = APIClient()
    client.force_login(me)
    response = client.get(f"/api/v1.0/directory/departments/{eng.id}/members/")

    assert response.status_code == 200
    ids = {m["id"] for m in response.json()["results"]}
    assert str(dev.id) in ids


def test_api_directory_department_members_include_subtree():
    """?include_subtree=true also returns members of descendant departments."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    parent = models.Department.objects.create(organization=org, name="Parent")
    child = models.Department.objects.create(
        organization=org, name="Child", parent=parent
    )
    child_member = factories.UserFactory(full_name="Child Member")
    _membership(org, child_member, department=child)

    client = APIClient()
    client.force_login(me)
    flat = client.get(f"/api/v1.0/directory/departments/{parent.id}/members/")
    subtree = client.get(
        f"/api/v1.0/directory/departments/{parent.id}/members/?include_subtree=true"
    )

    flat_ids = {m["id"] for m in flat.json()["results"]}
    subtree_ids = {m["id"] for m in subtree.json()["results"]}
    assert str(child_member.id) not in flat_ids
    assert str(child_member.id) in subtree_ids


def test_api_directory_empty_for_user_without_membership():
    """A user with no membership sees an empty directory (no cross-org leak)."""
    org = factories.OrganizationFactory()
    factories.UserFactory(full_name="Has Org")
    _membership(org, factories.UserFactory())
    orphan = factories.UserFactory()  # no membership

    client = APIClient()
    client.force_login(orphan)
    response = client.get("/api/v1.0/directory/members/")

    assert response.status_code == 200
    assert response.json()["results"] == []


def test_api_directory_excludes_oidc_less_accounts():
    """Django-admin accounts (no OIDC sub) must not pollute the people directory."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self", email="caller@acme.com")
    _membership(org, me)
    # createsuperuser-style account: admin_email only, no OIDC sub / name / email.
    admin_only = factories.UserFactory(
        sub=None, full_name=None, short_name=None, email=None, is_staff=True
    )
    _membership(org, admin_only)

    client = APIClient()
    client.force_login(me)
    response = client.get("/api/v1.0/directory/members/")

    ids = {m["id"] for m in response.json()["results"]}
    assert str(me.id) in ids
    assert str(admin_only.id) not in ids
