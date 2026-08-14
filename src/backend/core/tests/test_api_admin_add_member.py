"""Adding a member by phone number (P10 M2-g).

The feature this replaces shipped and could not be used: invitations were keyed
on email, while every account in production signs in with a mobile OTP and
carries an email synthesized from the number. An administrator holds phone
numbers, so the dialog asked for a value they had no way to know.

Two things here are worth more than the endpoint tests:

- **the login ordering.** A phone invitation can only be redeemed on a first
  sign-in, and only if the phone is known by the time invitations are claimed.
  Get that order wrong and nothing fails — the person just lands on the default
  membership, and ``already_member`` makes every later login skip the invitation
  for good. A silent, permanent, one-shot miss.
- **normalization.** The number an administrator types and the number Keycloak
  stores are rarely spelled the same way.
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services.invitation_provisioning import claim_pending_invitations
from core.services.phone import normalize_cn_phone, phone_variants

pytestmark = pytest.mark.django_db

PHONE = "13800000001"


def _admin_client(organization=None):
    organization = organization or factories.OrganizationFactory()
    user = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization,
        user=user,
        org_role=models.OrgRoleChoices.OWNER,
        is_primary=True,
    )
    client = APIClient()
    client.force_login(user)
    return client, organization, user


def _add(client, **payload):
    return client.post("/api/v1.0/admin/invitations/", payload, format="json")


# --- normalization ---------------------------------------------------------


@pytest.mark.parametrize(
    "written",
    [
        "13800000001",
        "138 0000 0001",
        "138-0000-0001",
        "+8613800000001",
        "8613800000001",
        "008613800000001",
        " 13800000001 ",
    ],
)
def test_every_way_of_writing_one_number_collapses_to_the_same_value(written):
    assert normalize_cn_phone(written) == PHONE


@pytest.mark.parametrize(
    "written",
    ["", None, "12345", "12800000001", "1380000000", "138000000012", "abcdefghijk"],
)
def test_things_that_are_not_mobile_numbers_normalize_to_nothing(written):
    assert normalize_cn_phone(written) == ""


def test_a_landline_prefixed_number_is_not_mistaken_for_a_country_code():
    """``8613...`` is a country code; ``86138`` alone is not — only strip when
    what is left is itself a valid number."""
    assert normalize_cn_phone("8612345678901") == ""


def test_variants_cover_how_keycloak_might_have_written_it():
    assert set(phone_variants("138 0000 0001")) == {
        PHONE,
        f"+86{PHONE}",
        f"86{PHONE}",
    }
    assert phone_variants("not a number") == []


# --- adding by phone -------------------------------------------------------


def test_add_a_member_with_only_a_phone_number():
    client, _org, _me = _admin_client()
    response = _add(client, phone="138 0000 0001", full_name="张三")

    assert response.status_code == 201, response.data
    invitation = models.OrgInvitation.objects.get()
    assert invitation.phone == PHONE  # stored canonical, not as typed
    assert invitation.email == ""
    assert invitation.full_name == "张三"
    assert invitation.status == models.InvitationStatusChoices.PENDING


def test_a_malformed_number_is_refused():
    client, _org, _me = _admin_client()
    response = _add(client, phone="1234")
    assert response.status_code == 400
    assert "phone" in response.data


def test_neither_key_is_refused():
    client, _org, _me = _admin_client()
    response = _add(client, full_name="无名氏")
    assert response.status_code == 400


def test_a_phone_only_invitation_carries_no_domain_warning():
    """No email is not a foreign domain."""
    client, organization, _me = _admin_client()
    organization.primary_domain = "we-meet.online"
    organization.save()

    response = _add(client, phone=PHONE)
    assert response.status_code == 201, response.data
    assert response.data["domain_warning"] is False


def test_the_same_number_cannot_be_queued_twice():
    """Feishu's rule: one number, one entry per company."""
    client, _org, _me = _admin_client()
    assert _add(client, phone=PHONE).status_code == 201
    again = _add(client, phone=f"+86{PHONE}")  # a different spelling, same person
    assert again.status_code == 400
    assert str(again.data["code"][0]) == "pending_phone"
    assert models.OrgInvitation.objects.count() == 1


def test_two_different_phone_only_invitations_coexist():
    """The email uniqueness constraint must not treat "" as one person."""
    client, _org, _me = _admin_client()
    assert _add(client, phone=PHONE).status_code == 201
    assert _add(client, phone="13900000002").status_code == 201
    assert models.OrgInvitation.objects.count() == 2


def test_adding_someone_already_in_the_directory_is_refused():
    client, organization, _me = _admin_client()
    models.Membership.objects.create(
        organization=organization,
        user=factories.UserFactory(phone=f"+86{PHONE}"),
        is_primary=True,
    )
    response = _add(client, phone=PHONE)
    assert response.status_code == 400
    assert str(response.data["code"][0]) == "already_member"
    assert "already" in str(response.data).lower()


def test_adding_a_departed_member_points_at_rehire():
    """Not "already here" — their membership exists but they are gone.

    An invitation for them would be marked accepted on the next sign-in while
    no membership is created, leaving the admin with a vanished invitation and
    a still-departed person.
    """
    client, organization, _me = _admin_client()
    models.Membership.objects.create(
        organization=organization,
        user=factories.UserFactory(phone=PHONE),
        is_primary=True,
        status=models.MembershipStatusChoices.LEFT,
    )
    response = _add(client, phone=PHONE)
    assert response.status_code == 400
    assert str(response.data["code"][0]) == "departed_member"
    assert "离职" in str(response.data)


def test_a_member_of_another_organization_is_not_a_duplicate():
    client, _org, _me = _admin_client()
    other = factories.OrganizationFactory()
    models.Membership.objects.create(
        organization=other, user=factories.UserFactory(phone=PHONE), is_primary=True
    )
    assert _add(client, phone=PHONE).status_code == 201


# --- redemption ------------------------------------------------------------


def _pending(organization, **kwargs):
    return models.OrgInvitation.objects.create(
        organization=organization, status=models.InvitationStatusChoices.PENDING, **kwargs
    )


def test_a_phone_invitation_is_redeemed_on_login():
    organization = factories.OrganizationFactory()
    department = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    _pending(organization, phone=PHONE, department=department, title="后端工程师")

    user = factories.UserFactory(phone=PHONE, email="")
    assert claim_pending_invitations(user) == 1

    membership = models.Membership.objects.get(user=user)
    assert membership.department_id == department.id
    assert membership.title == "后端工程师"


def test_redemption_survives_a_differently_written_number():
    """Keycloak stores what the sign-in flow wrote; the admin typed 11 digits."""
    organization = factories.OrganizationFactory()
    _pending(organization, phone=PHONE)

    user = factories.UserFactory(phone=f"+86{PHONE}", email="")
    assert claim_pending_invitations(user) == 1


def test_a_phone_from_the_oidc_claims_wins_over_an_unsynced_user():
    """First login: User.phone may still be empty when the claims already say it."""
    organization = factories.OrganizationFactory()
    _pending(organization, phone=PHONE)

    user = factories.UserFactory(phone="", email="")
    assert claim_pending_invitations(user, phone=f"86{PHONE}") == 1


def test_an_unmatched_number_claims_nothing():
    organization = factories.OrganizationFactory()
    _pending(organization, phone=PHONE)

    user = factories.UserFactory(phone="13900000009", email="")
    assert claim_pending_invitations(user) == 0
    assert not models.Membership.objects.filter(user=user).exists()


def test_email_invitations_still_work():
    """M2-g must not narrow what already shipped."""
    organization = factories.OrganizationFactory()
    _pending(organization, email="zhangsan@example.com")

    user = factories.UserFactory(email="ZhangSan@Example.com")
    assert claim_pending_invitations(user) == 1


def test_the_invited_name_does_not_overwrite_the_identity_providers():
    """full_name is recomputed from the claims each login; writing it here would
    be reverted at the next sign-in and look like data loss."""
    organization = factories.OrganizationFactory()
    _pending(organization, phone=PHONE, full_name="张三")

    user = factories.UserFactory(phone=PHONE, email="", full_name="WeMeet-0001")
    claim_pending_invitations(user)

    user.refresh_from_db()
    assert user.full_name == "WeMeet-0001"


# --- the ordering ----------------------------------------------------------


def test_the_phone_is_known_before_invitations_are_claimed(monkeypatch):
    """The regression this whole feature rests on.

    Runs the real ``post_get_or_create_user`` with a stubbed Keycloak sync. If
    the sync ran after the claim (as it did until M2-g), the invitation would
    not match, ``ensure_default_org_membership`` would hand out a plain
    membership, and this asserts exactly that difference: which department the
    person ends up in.
    """
    from core.authentication.backends import OIDCAuthenticationBackend

    organization = factories.OrganizationFactory()
    department = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    _pending(organization, phone=PHONE, department=department)

    user = factories.UserFactory(phone="", email="")

    def fake_sync(target):
        target.phone = PHONE
        target.save(update_fields=["phone"])

    monkeypatch.setattr(
        "core.authentication.backends.sync_user_phone", fake_sync
    )

    OIDCAuthenticationBackend().post_get_or_create_user(
        user, {"email": ""}, is_new_user=True
    )

    membership = models.Membership.objects.get(user=user, organization=organization)
    assert membership.department_id == department.id, (
        "the invitation was not redeemed — the phone was still unknown when "
        "claim_pending_invitations ran"
    )


def test_a_missed_claim_is_permanent(monkeypatch, settings):
    """Why the ordering is not merely 'nicer': there is no second chance.

    Simulates the old order by not syncing the phone at all, then signs in again
    with the phone present. ``ensure_default_org_membership`` has meanwhile
    given the person a plain membership, so the second attempt matches the
    invitation, finds them already a member, and marks it accepted without
    applying anything. The department is lost silently and for good.

    The invitation is created in the **bootstrap** organization on purpose:
    that is the one the fallback writes into, and a single-tenant deployment
    (which every we-meet install is today) has no other. Point them at
    different organizations and the bug disappears — which is exactly why it
    survived review.
    """
    from core.authentication.backends import OIDCAuthenticationBackend

    settings.ORGANIZATION_BOOTSTRAP_SLUG = "default"
    # The bootstrap organization is created by a P1 migration, so take the one
    # that is already there rather than colliding with it.
    organization = models.Organization.objects.get(slug="default")
    department = models.Department.objects.create(
        organization=organization, name="研发部"
    )
    invitation = _pending(organization, phone=PHONE, department=department)

    user = factories.UserFactory(phone="", email="", sub="kc-sub-1")
    monkeypatch.setattr(
        "core.authentication.backends.sync_user_phone", lambda _u: None
    )
    backend = OIDCAuthenticationBackend()
    backend.post_get_or_create_user(user, {"email": ""}, is_new_user=True)

    # Second login, phone now known — too late.
    user.phone = PHONE
    user.save(update_fields=["phone"])
    backend.post_get_or_create_user(user, {"email": ""}, is_new_user=False)

    invitation.refresh_from_db()
    assert invitation.status == models.InvitationStatusChoices.ACCEPTED
    assert (
        models.Membership.objects.get(
            user=user, organization=organization
        ).department_id
        is None
    ), "the invited department was applied on a later login — the miss was not permanent"
