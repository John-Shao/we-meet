"""How departed members render outside the directory (P10 M1-f).

Two bugs offboarding would otherwise expose on day one:
  - ``im/users/resolve`` filtered on ACTIVE, so every message a leaver ever sent
    would fall back to a raw uid.
  - ``directory/members/{id}/`` 404s, white-screening the ``?member=<id>`` deep
    link that historical messages point at.
"""

from unittest import mock

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE
LEFT = models.MembershipStatusChoices.LEFT


def _member(org, user=None, **kw):
    return models.Membership.objects.create(
        organization=org,
        user=user or factories.UserFactory(),
        is_primary=kw.pop("is_primary", True),
        **kw,
    )


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


# --- im/users/resolve --------------------------------------------------------


def test_resolve_still_names_departed_colleagues():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    gone_user = factories.UserFactory(full_name="Gone Person", im_uid="uid-gone")
    _member(org, gone_user, status=LEFT, is_primary=False)

    response = _client(me).post(
        "/api/v1.0/im/users/resolve/", {"im_uids": ["uid-gone"]}, format="json"
    )
    assert response.status_code == 200, response.content
    body = response.json()
    assert "uid-gone" in body, "a leaver's old messages would render a raw uid"
    assert body["uid-gone"]["full_name"] == "Gone Person"
    assert body["uid-gone"]["left"] is True


def test_resolve_marks_active_colleagues_as_not_left():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    peer = factories.UserFactory(full_name="Still Here", im_uid="uid-active")
    _member(org, peer, is_primary=False)

    body = (
        _client(me)
        .post("/api/v1.0/im/users/resolve/", {"im_uids": ["uid-active"]}, format="json")
        .json()
    )
    assert body["uid-active"]["left"] is False


def test_resolve_does_not_leak_across_organizations():
    """Widening the status filter must not widen the org boundary."""
    org, other = factories.OrganizationFactory(), factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    stranger = factories.UserFactory(full_name="Stranger", im_uid="uid-other")
    _member(other, stranger, status=LEFT)

    body = (
        _client(me)
        .post("/api/v1.0/im/users/resolve/", {"im_uids": ["uid-other"]}, format="json")
        .json()
    )
    assert body == {}


def test_resolve_subs_marks_departed():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    gone = factories.UserFactory(full_name="Gone Person", sub="sub-gone")
    _member(org, gone, status=LEFT, is_primary=False)

    body = (
        _client(me)
        .post("/api/v1.0/im/users/resolve-subs/", {"subs": ["sub-gone"]}, format="json")
        .json()
    )
    assert body["sub-gone"]["left"] is True


# --- directory tombstone -----------------------------------------------------


def test_departed_member_returns_tombstone_not_404():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    department = models.Department.objects.create(organization=org, name="研发部")
    gone_user = factories.UserFactory(full_name="Gone Person")
    membership = _member(
        org, gone_user, department=department, title="Engineer", is_primary=False
    )
    membership.left_snapshot = membership.build_left_snapshot()
    membership.status = LEFT
    membership.save()

    response = _client(me).get(f"/api/v1.0/directory/members/{gone_user.id}/")
    assert response.status_code == 200, response.content
    card = response.json()
    assert card["left"] is True
    assert card["full_name"] == "Gone Person"
    assert card["department"]["name"] == "研发部"
    assert card["title"] == "Engineer"


def test_tombstone_withholds_contact_details():
    """Leaving the company revokes the directory's licence to share your number."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    gone_user = factories.UserFactory(
        full_name="Gone Person", email="gone@example.com", phone="13800001990"
    )
    _member(org, gone_user, status=LEFT, is_primary=False)

    card = _client(me).get(f"/api/v1.0/directory/members/{gone_user.id}/").json()
    assert "phone" not in card
    assert "email" not in card


def test_departed_member_absent_from_list():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    gone_user = factories.UserFactory()
    _member(org, gone_user, status=LEFT, is_primary=False)

    results = _client(me).get("/api/v1.0/directory/members/").json()["results"]
    assert str(gone_user.id) not in [row["id"] for row in results]


def test_active_member_card_reports_not_left():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    peer = factories.UserFactory()
    _member(org, peer)

    card = _client(me).get(f"/api/v1.0/directory/members/{peer.id}/").json()
    assert card["left"] is False


def test_stranger_still_404s():
    """The tombstone is for former colleagues, not a lookup for anyone at all."""
    org, other = factories.OrganizationFactory(), factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    stranger = factories.UserFactory()
    _member(other, stranger, status=LEFT)

    response = _client(me).get(f"/api/v1.0/directory/members/{stranger.id}/")
    assert response.status_code == 404


# --- department detail fields (P10 M1-h) -------------------------------------


def test_departments_carry_head_and_member_count():
    """Both have existed in the DTO since P1 with no UI reading them."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    head_user = factories.UserFactory(full_name="Team Lead")
    department = models.Department.objects.create(
        organization=org, name="研发部", head=head_user, code="D001"
    )
    _member(org, head_user, department=department, is_primary=False)
    _member(org, factories.UserFactory(), department=department, is_primary=False)

    rows = _client(me).get("/api/v1.0/directory/departments/").json()
    row = next(r for r in rows if r["id"] == str(department.id))
    assert row["head"]["full_name"] == "Team Lead"
    assert row["member_count"] == 2
    assert row["code"] == "D001"


def test_member_count_excludes_departed_and_devices():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    department = models.Department.objects.create(organization=org, name="Eng")
    _member(org, factories.UserFactory(), department=department, is_primary=False)
    _member(
        org,
        factories.UserFactory(),
        department=department,
        status=LEFT,
        is_primary=False,
    )
    _member(
        org,
        factories.UserFactory(is_device=True),
        department=department,
        is_primary=False,
    )

    rows = _client(me).get("/api/v1.0/directory/departments/").json()
    row = next(r for r in rows if r["id"] == str(department.id))
    assert row["member_count"] == 1


# --- im/users/resolve: 群机器人 ------------------------------------------------
#
# Bots are not Users, so they can only be named through this same endpoint —
# it is the one call every client already makes for every uid in a conversation.


def test_resolve_names_a_custom_bot_in_my_organization():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    models.ImBot.objects.create(
        kind=models.ImBotKindChoices.CUSTOM,
        name="构建通知",
        description="CI 构建结果推送",
        im_uid="uid-bot-1",
        organization=org,
    )

    body = (
        _client(me)
        .post("/api/v1.0/im/users/resolve/", {"im_uids": ["uid-bot-1"]}, format="json")
        .json()
    )
    assert body["uid-bot-1"]["full_name"] == "构建通知"
    assert body["uid-bot-1"]["is_bot"] is True
    assert body["uid-bot-1"]["description"] == "CI 构建结果推送"
    assert body["uid-bot-1"]["left"] is False


def test_resolve_hides_a_bot_from_another_organization():
    """Same rule as people: a name is org-scoped."""
    mine = factories.OrganizationFactory()
    theirs = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(mine, me)
    models.ImBot.objects.create(
        kind=models.ImBotKindChoices.CUSTOM,
        name="别家的机器人",
        im_uid="uid-bot-other",
        organization=theirs,
    )

    body = (
        _client(me)
        .post(
            "/api/v1.0/im/users/resolve/", {"im_uids": ["uid-bot-other"]}, format="json"
        )
        .json()
    )
    assert "uid-bot-other" not in body


def test_resolve_names_a_builtin_assistant_for_everyone():
    """Built-ins carry nothing org-private, and every group has the same ones."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    assistant = models.ImBot.objects.get(slug="meeting-assistant")
    models.ImBot.objects.filter(pk=assistant.pk).update(im_uid="uid-meeting-assistant")

    with mock.patch("core.api.im.im_bots.ensure_builtin_avatar") as ensure_avatar:
        body = (
            _client(me)
            .post(
                "/api/v1.0/im/users/resolve/",
                {"im_uids": ["uid-meeting-assistant"]},
                format="json",
            )
            .json()
        )
    assert body["uid-meeting-assistant"]["full_name"] == "会议助手"
    assert body["uid-meeting-assistant"]["is_bot"] is True
    ensure_avatar.assert_called_once()


def test_resolve_skips_a_deactivated_bot():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    models.ImBot.objects.create(
        kind=models.ImBotKindChoices.CUSTOM,
        name="停用的",
        im_uid="uid-bot-off",
        organization=org,
        is_active=False,
    )

    body = (
        _client(me)
        .post("/api/v1.0/im/users/resolve/", {"im_uids": ["uid-bot-off"]}, format="json")
        .json()
    )
    assert "uid-bot-off" not in body


def test_resolve_marks_real_people_without_the_bot_flag():
    """Clients branch on presence; a person must never look like a bot."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _member(org, me)
    colleague = factories.UserFactory(full_name="张三", im_uid="uid-human")
    _member(org, colleague, is_primary=False)

    body = (
        _client(me)
        .post("/api/v1.0/im/users/resolve/", {"im_uids": ["uid-human"]}, format="json")
        .json()
    )
    assert body["uid-human"].get("is_bot") is None
