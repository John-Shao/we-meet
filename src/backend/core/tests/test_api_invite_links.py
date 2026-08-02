"""Invite links, applications and approval (P10 M4).

Three clusters, and the weight is deliberately uneven:

- **what the anonymous endpoint refuses to say.** It is the only unauthenticated
  surface M4 adds, so the tests pin the uniform failure answer — the moment a
  wrong code and an expired code look different, guessing becomes enumeration.
- **approval placing somebody who is already a member.** Because of auto-join
  this is the *common* case, and `Membership` will not stop a duplicate:
  the unique constraints are `(user, department)` and `(user, organization)
  where is_primary`, so a second row with another department is accepted
  silently and the person appears twice in the directory.
- **the scope holding through approval.** Same bidirectional rule as M2-f.
"""

from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from core import factories, models
from core.services import invite_links

pytestmark = pytest.mark.django_db


def _org_owner():
    organization = factories.OrganizationFactory()
    user = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization,
        user=user,
        org_role=models.OrgRoleChoices.OWNER,
        is_primary=True,
    )
    return organization, user


def _client(user=None):
    client = APIClient()
    if user is not None:
        client.force_login(user)
    return client


def _link(organization, **kwargs):
    kwargs.setdefault("expires_at", timezone.now() + timedelta(days=7))
    return models.OrgInviteLink.objects.create(organization=organization, **kwargs)


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    """The throttle is cache-backed and buckets by IP — every test shares one."""
    cache.clear()
    yield
    cache.clear()


# --- the code itself -------------------------------------------------------


def test_a_code_is_generated_and_avoids_ambiguous_glyphs():
    organization, _owner = _org_owner()
    link = _link(organization)
    assert len(link.code) == models.INVITE_CODE_LENGTH
    assert set(link.code) <= set(models.INVITE_CODE_ALPHABET)
    # 0/O and 1/I/L are what people mistype off a whiteboard.
    assert not set(link.code) & set("01OIL")


def test_the_code_is_not_rewritten_on_later_saves():
    """It gets printed, pasted and turned into a QR the moment it exists."""
    organization, _owner = _org_owner()
    link = _link(organization)
    original = link.code
    link.title = "后端工程师"
    link.save()
    link.refresh_from_db()
    assert link.code == original


# --- what an anonymous visitor may know ------------------------------------


def test_anonymous_can_read_who_is_inviting_them():
    organization, _owner = _org_owner()
    department = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    link = _link(organization, department=department)

    response = _client().get(f"/api/v1.0/invite/{link.code}/")
    assert response.status_code == 200
    assert response.data["valid"] is True
    assert response.data["organization_name"] == organization.name
    assert response.data["department_name"] == "研发部"


def test_the_anonymous_response_names_no_people():
    """An anonymous endpoint that echoes a person is a hole in the directory."""
    organization, owner = _org_owner()
    owner.full_name = "王大锤"
    owner.save()
    link = _link(organization, created_by=owner)

    body = str(_client().get(f"/api/v1.0/invite/{link.code}/").data)
    assert "王大锤" not in body
    assert str(owner.id) not in body


@pytest.mark.parametrize(
    "kill",
    [
        pytest.param({"expires_at": "PAST"}, id="expired"),
        pytest.param({"is_active": False}, id="revoked"),
        pytest.param({"max_uses": 1, "used_count": 1}, id="exhausted"),
    ],
)
def test_every_failure_looks_identical(kill):
    """Any difference between these is an oracle for enumerating codes."""
    organization, _owner = _org_owner()
    link = _link(organization)
    if kill.get("expires_at") == "PAST":
        kill = {**kill, "expires_at": timezone.now() - timedelta(minutes=1)}
    models.OrgInviteLink.objects.filter(pk=link.pk).update(**kill)

    dead = _client().get(f"/api/v1.0/invite/{link.code}/")
    # A code that was never issued — the baseline every failure must match.
    nonexistent = _client().get("/api/v1.0/invite/ZZZZZZZZ/")

    assert dead.status_code == nonexistent.status_code == 200
    assert dead.data == nonexistent.data == {"valid": False}


def test_a_usable_link_and_a_dead_one_differ_only_in_valid():
    organization, _owner = _org_owner()
    good = _link(organization)
    assert _client().get(f"/api/v1.0/invite/{good.code}/").data["valid"] is True
    assert _client().get("/api/v1.0/invite/ZZZZZZZZ/").data == {"valid": False}


def test_resolution_is_throttled(monkeypatch):
    """Guessing has to be slow; the uniform answer above makes it useless.

    The rate is patched on the class rather than through ``REST_FRAMEWORK``:
    DRF binds ``SimpleRateThrottle.THROTTLE_RATES`` to the settings dict at
    import time, so a settings override reaches it only by accident of import
    order — which is exactly why this test passed alone and failed in the suite.
    ``SimpleRateThrottle.__init__`` honours a class-level ``rate``.
    """
    from core.api.invite import InviteThrottle

    monkeypatch.setattr(InviteThrottle, "rate", "3/minute", raising=False)
    client = _client()
    for _ in range(3):
        assert client.get("/api/v1.0/invite/ZZZZZZZZ/").status_code == 200
    assert client.get("/api/v1.0/invite/ZZZZZZZZ/").status_code == 429


def test_the_throttle_has_its_own_bucket():
    """Sharing AnonRateThrottle's default bucket would starve the QR-login poll."""
    from core.api.invite import InviteThrottle

    assert InviteThrottle.scope == "invite_code"


# --- applying --------------------------------------------------------------


def test_applying_files_a_pending_request():
    organization, _owner = _org_owner()
    department = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    link = _link(organization, department=department)
    applicant = factories.UserFactory(full_name="张三", phone="13800000001")

    response = _client(applicant).post(f"/api/v1.0/invite/{link.code}/apply/")
    assert response.status_code == 201, response.data

    join_request = models.OrgJoinRequest.objects.get()
    assert join_request.status == "pending"
    # Snapshots, not joins: the reviewer reads who applied.
    assert join_request.full_name == "张三"
    assert join_request.phone == "13800000001"
    assert join_request.department_id == department.id


def test_an_open_link_admits_without_review():
    organization, _owner = _org_owner()
    department = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    link = _link(organization, department=department, require_approval=False)
    applicant = factories.UserFactory()

    response = _client(applicant).post(f"/api/v1.0/invite/{link.code}/apply/")
    assert response.status_code == 200, response.data
    assert response.data["status"] == "approved"

    membership = models.Membership.objects.get(
        organization=organization, user=applicant
    )
    assert membership.department_id == department.id


def test_applying_twice_returns_the_same_request():
    organization, _owner = _org_owner()
    link = _link(organization)
    applicant = factories.UserFactory()
    client = _client(applicant)

    first = client.post(f"/api/v1.0/invite/{link.code}/apply/")
    second = client.post(f"/api/v1.0/invite/{link.code}/apply/")
    assert first.data["id"] == second.data["id"]
    assert models.OrgJoinRequest.objects.count() == 1


def test_someone_already_placed_exactly_there_is_told_so():
    """Filing a request a reviewer can only rubber-stamp is worse than saying no."""
    organization, _owner = _org_owner()
    department = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    link = _link(organization, department=department)
    already = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization, user=already, department=department, is_primary=True
    )

    response = _client(already).post(f"/api/v1.0/invite/{link.code}/apply/")
    assert response.status_code == 409
    assert response.data["code"] == "already_member"


def test_an_existing_member_in_another_department_may_still_apply():
    """Because of auto-join everyone is already a member — that must not block."""
    organization, _owner = _org_owner()
    engineering = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    link = _link(organization, department=engineering)
    applicant = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization, user=applicant, department=None, is_primary=True
    )

    response = _client(applicant).post(f"/api/v1.0/invite/{link.code}/apply/")
    assert response.status_code == 201, response.data


def test_applying_with_a_dead_link_is_refused_in_the_same_words():
    organization, _owner = _org_owner()
    link = _link(organization, expires_at=timezone.now() - timedelta(minutes=1))
    applicant = factories.UserFactory()

    dead = _client(applicant).post(f"/api/v1.0/invite/{link.code}/apply/")
    missing = _client(applicant).post("/api/v1.0/invite/ZZZZZZZZ/apply/")
    assert dead.status_code == missing.status_code == 400
    assert dead.data["detail"] == missing.data["detail"]


def test_applying_anonymously_is_refused():
    organization, _owner = _org_owner()
    link = _link(organization)
    assert _client().post(f"/api/v1.0/invite/{link.code}/apply/").status_code in (
        401,
        403,
    )


# --- approval: the branch that matters -------------------------------------


def test_approving_an_existing_member_updates_instead_of_duplicating():
    """`Membership` will NOT stop the duplicate — see the module docstring."""
    organization, owner = _org_owner()
    engineering = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    link = _link(organization, department=engineering)
    applicant = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization, user=applicant, department=None, is_primary=True
    )
    join_request = invite_links.apply_to_link(link, applicant)

    response = _client(owner).post(
        f"/api/v1.0/admin/join-requests/{join_request.id}/approve/", {}, format="json"
    )
    assert response.status_code == 200, response.data

    memberships = models.Membership.objects.filter(
        organization=organization, user=applicant
    )
    assert memberships.count() == 1, "a second membership row appeared"
    assert memberships.first().department_id == engineering.id


def test_approving_creates_a_membership_when_there_is_none():
    organization, owner = _org_owner()
    engineering = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    link = _link(organization, department=engineering)
    applicant = factories.UserFactory()
    join_request = invite_links.apply_to_link(link, applicant)

    _client(owner).post(
        f"/api/v1.0/admin/join-requests/{join_request.id}/approve/", {}, format="json"
    )
    assert models.Membership.objects.filter(
        organization=organization, user=applicant, department=engineering
    ).exists()


def test_approving_a_departed_person_rehires_them():
    organization, owner = _org_owner()
    engineering = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    link = _link(organization, department=engineering)
    applicant = factories.UserFactory()
    membership = models.Membership.objects.create(
        organization=organization,
        user=applicant,
        is_primary=True,
        status=models.MembershipStatusChoices.LEFT,
    )
    join_request = invite_links.apply_to_link(link, applicant)

    _client(owner).post(
        f"/api/v1.0/admin/join-requests/{join_request.id}/approve/", {}, format="json"
    )
    membership.refresh_from_db()
    assert membership.status == models.MembershipStatusChoices.ACTIVE
    assert membership.department_id == engineering.id
    assert models.Membership.objects.filter(user=applicant).count() == 1


def test_approving_does_not_quietly_unsuspend():
    """A suspension is an administrator's decision, not this endpoint's to undo."""
    organization, owner = _org_owner()
    engineering = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    link = _link(organization, department=engineering)
    applicant = factories.UserFactory()
    membership = models.Membership.objects.create(
        organization=organization,
        user=applicant,
        is_primary=True,
        status=models.MembershipStatusChoices.SUSPENDED,
    )
    join_request = invite_links.apply_to_link(link, applicant)

    _client(owner).post(
        f"/api/v1.0/admin/join-requests/{join_request.id}/approve/", {}, format="json"
    )
    membership.refresh_from_db()
    assert membership.status == models.MembershipStatusChoices.SUSPENDED
    assert membership.department_id == engineering.id


def test_the_reviewer_can_override_the_department():
    organization, owner = _org_owner()
    engineering = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    sales = models.Department.objects.create(organization=organization, name="销售部")
    link = _link(organization, department=engineering)
    applicant = factories.UserFactory()
    join_request = invite_links.apply_to_link(link, applicant)

    _client(owner).post(
        f"/api/v1.0/admin/join-requests/{join_request.id}/approve/",
        {"department": str(sales.id)},
        format="json",
    )
    assert models.Membership.objects.get(
        organization=organization, user=applicant
    ).department_id == sales.id


def test_a_link_revoked_after_the_application_blocks_approval():
    """The expiry is only worth anything if it is checked when it matters."""
    organization, owner = _org_owner()
    link = _link(organization)
    applicant = factories.UserFactory()
    join_request = invite_links.apply_to_link(link, applicant)

    models.OrgInviteLink.objects.filter(pk=link.pk).update(is_active=False)

    response = _client(owner).post(
        f"/api/v1.0/admin/join-requests/{join_request.id}/approve/", {}, format="json"
    )
    assert response.status_code == 400


def test_the_quota_counts_approvals_not_applications():
    """A few rejected applicants must not use up a link."""
    organization, owner = _org_owner()
    link = _link(organization, max_uses=2)
    rejected = invite_links.apply_to_link(link, factories.UserFactory())
    approved = invite_links.apply_to_link(link, factories.UserFactory())

    client = _client(owner)
    client.post(
        f"/api/v1.0/admin/join-requests/{rejected.id}/reject/",
        {"reason": "不认识"},
        format="json",
    )
    client.post(
        f"/api/v1.0/admin/join-requests/{approved.id}/approve/", {}, format="json"
    )

    link.refresh_from_db()
    assert link.used_count == 1


def test_rejecting_records_the_reason():
    organization, owner = _org_owner()
    link = _link(organization)
    join_request = invite_links.apply_to_link(link, factories.UserFactory())

    response = _client(owner).post(
        f"/api/v1.0/admin/join-requests/{join_request.id}/reject/",
        {"reason": "不是我们公司的人"},
        format="json",
    )
    assert response.status_code == 200
    join_request.refresh_from_db()
    assert join_request.status == "rejected"
    assert join_request.reject_reason == "不是我们公司的人"
    assert not models.Membership.objects.filter(user=join_request.user).exists()


def test_a_handled_request_cannot_be_handled_again():
    organization, owner = _org_owner()
    link = _link(organization)
    join_request = invite_links.apply_to_link(link, factories.UserFactory())
    client = _client(owner)

    client.post(
        f"/api/v1.0/admin/join-requests/{join_request.id}/approve/", {}, format="json"
    )
    second = client.post(
        f"/api/v1.0/admin/join-requests/{join_request.id}/reject/", {}, format="json"
    )
    assert second.status_code == 400


# --- scope -----------------------------------------------------------------


def _scoped_hr(organization, department, permissions):
    hr_user = factories.UserFactory()
    membership = models.Membership.objects.create(
        organization=organization, user=hr_user, department=department, is_primary=True
    )
    role = models.AdminRole.objects.create(
        organization=organization, code="hr", name="HR", permissions=permissions
    )
    assignment = models.AdminRoleAssignment.objects.create(
        role=role, membership=membership, scope_type=models.AdminScopeChoices.DEPARTMENTS
    )
    models.AdminRoleScopeDepartment.objects.create(
        assignment=assignment, department=department
    )
    return hr_user


def test_a_scoped_reviewer_sees_only_their_subtree():
    organization, _owner = _org_owner()
    engineering = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    sales = models.Department.objects.create(organization=organization, name="销售部")
    inside = invite_links.apply_to_link(
        _link(organization, department=engineering), factories.UserFactory()
    )
    outside = invite_links.apply_to_link(
        _link(organization, department=sales), factories.UserFactory()
    )

    hr = _scoped_hr(organization, engineering, ["org.member.read", "org.member.write"])
    response = _client(hr).get("/api/v1.0/admin/join-requests/")
    ids = {row["id"] for row in response.data["results"]}
    assert str(inside.id) in ids
    assert str(outside.id) not in ids


def test_a_scoped_reviewer_cannot_place_outside_the_scope():
    organization, _owner = _org_owner()
    engineering = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    sales = models.Department.objects.create(organization=organization, name="销售部")
    join_request = invite_links.apply_to_link(
        _link(organization, department=engineering), factories.UserFactory()
    )
    hr = _scoped_hr(organization, engineering, ["org.member.read", "org.member.write"])

    response = _client(hr).post(
        f"/api/v1.0/admin/join-requests/{join_request.id}/approve/",
        {"department": str(sales.id)},
        format="json",
    )
    assert response.status_code == 403


def test_a_scoped_holder_cannot_issue_an_organization_wide_link():
    """No department = organization level, which is inside nobody's subtree."""
    organization, _owner = _org_owner()
    engineering = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    hr = _scoped_hr(organization, engineering, ["org.invitation.write"])

    response = _client(hr).post(
        "/api/v1.0/admin/invite-links/", {"expires_in_days": 7}, format="json"
    )
    assert response.status_code == 403


# --- link lifecycle from the console ---------------------------------------


def test_issuing_a_link_from_the_console():
    organization, owner = _org_owner()
    department = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    response = _client(owner).post(
        "/api/v1.0/admin/invite-links/",
        {"department": str(department.id), "expires_in_days": 3, "max_uses": 5},
        format="json",
    )
    assert response.status_code == 201, response.data
    assert len(response.data["code"]) == models.INVITE_CODE_LENGTH

    link = models.OrgInviteLink.objects.get()
    assert link.require_approval is True  # the default must survive the round trip
    assert link.expires_at > timezone.now()


def test_an_absurd_expiry_is_refused():
    organization, owner = _org_owner()
    response = _client(owner).post(
        "/api/v1.0/admin/invite-links/", {"expires_in_days": 3650}, format="json"
    )
    assert response.status_code == 400


def test_revoking_deactivates_and_expires_its_pending_applications():
    organization, owner = _org_owner()
    link = _link(organization)
    join_request = invite_links.apply_to_link(link, factories.UserFactory())

    response = _client(owner).delete(f"/api/v1.0/admin/invite-links/{link.id}/")
    assert response.status_code == 204

    link.refresh_from_db()
    join_request.refresh_from_db()
    assert link.is_active is False
    # Otherwise a revoked link leaves a badge nobody can ever clear.
    assert join_request.status == "expired"


def test_issuing_a_link_requires_the_permission():
    organization, _owner = _org_owner()
    outsider = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization, user=outsider, is_primary=True
    )
    response = _client(outsider).post(
        "/api/v1.0/admin/invite-links/", {"expires_in_days": 7}, format="json"
    )
    assert response.status_code == 403


# --- the applicant's own view ----------------------------------------------


def test_an_applicant_can_see_and_withdraw_their_application():
    organization, _owner = _org_owner()
    link = _link(organization)
    applicant = factories.UserFactory()
    join_request = invite_links.apply_to_link(link, applicant)
    client = _client(applicant)

    listing = client.get("/api/v1.0/join-requests/mine/")
    assert [row["id"] for row in listing.data] == [str(join_request.id)]

    cancelled = client.post(f"/api/v1.0/join-requests/{join_request.id}/cancel/")
    assert cancelled.status_code == 200
    join_request.refresh_from_db()
    assert join_request.status == "cancelled"


def test_one_applicant_cannot_withdraw_anothers():
    organization, _owner = _org_owner()
    join_request = invite_links.apply_to_link(
        _link(organization), factories.UserFactory()
    )
    response = _client(factories.UserFactory()).post(
        f"/api/v1.0/join-requests/{join_request.id}/cancel/"
    )
    assert response.status_code == 404


# --- the auto-join switch (M4-d) -------------------------------------------


def test_auto_join_is_on_unless_an_organization_turns_it_off(settings):
    """The absent key must read as True — nothing changes for anyone who has
    not opted in."""
    from core.authentication.backends import OIDCAuthenticationBackend

    settings.ORGANIZATION_BOOTSTRAP_SLUG = "default"
    organization = models.Organization.objects.get(slug="default")
    assert "auto_join_enabled" not in (organization.settings or {})

    user = factories.UserFactory(sub="kc-auto-1")
    OIDCAuthenticationBackend.ensure_default_org_membership(user)
    assert models.Membership.objects.filter(
        user=user, organization=organization
    ).exists()


def test_turning_auto_join_off_stops_the_membership_being_created(settings):
    from core.authentication.backends import OIDCAuthenticationBackend

    settings.ORGANIZATION_BOOTSTRAP_SLUG = "default"
    organization = models.Organization.objects.get(slug="default")
    organization.settings = {**(organization.settings or {}), "auto_join_enabled": False}
    organization.save()

    user = factories.UserFactory(sub="kc-auto-2")
    OIDCAuthenticationBackend.ensure_default_org_membership(user)
    assert not models.Membership.objects.filter(user=user).exists()


def test_the_switch_does_not_disturb_someone_who_is_already_a_member(settings):
    """Turning it off is not a mass eviction."""
    from core.authentication.backends import OIDCAuthenticationBackend

    settings.ORGANIZATION_BOOTSTRAP_SLUG = "default"
    organization = models.Organization.objects.get(slug="default")
    user = factories.UserFactory(sub="kc-auto-3")
    membership = models.Membership.objects.create(
        organization=organization, user=user, is_primary=True
    )

    organization.settings = {**(organization.settings or {}), "auto_join_enabled": False}
    organization.save()
    OIDCAuthenticationBackend.ensure_default_org_membership(user)

    membership.refresh_from_db()
    assert membership.status == models.MembershipStatusChoices.ACTIVE
