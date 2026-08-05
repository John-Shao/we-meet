"""审计动作目录 ``GET /admin/audit-logs/actions/``(线 B / B5a)。

前端原本硬编码了 10 个动作,而 ``AuditActionChoices`` 里有 53 个 —— 43 种动作
**在控制台里根本筛不出来**,包括全部机器人动作。目录改由后端吐之后,它
**不可能**再跟枚举漂移;这个文件钉住的就是「不可能」。
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db

URL = "/api/v1.0/admin/audit-logs/actions/"


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


@pytest.fixture
def owner():
    organization = factories.OrganizationFactory()
    user = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization,
        user=user,
        org_role=models.OrgRoleChoices.OWNER,
        is_primary=True,
    )
    return user


def test_the_catalogue_is_exactly_the_enum(owner):
    """**这条是整个改动的意义所在。** 少一个 = 那种动作筛不出来;多一个 =
    筛出来永远是空列表。两边都只能靠这条发现。"""
    rows = _client(owner).get(URL).data["actions"]
    assert [r["value"] for r in rows] == [
        value for value, _label in models.AuditActionChoices.choices
    ]


def test_the_catalogue_is_not_trivially_small(owner):
    """防的是「枚举被改成空的、上面那条依然全绿」。写死一个下界而不是精确值 ——
    精确值每加一个动作都要来改一次,那正是我们刚拆掉的那种耦合。"""
    rows = _client(owner).get(URL).data["actions"]
    assert len(rows) >= 50


def test_every_action_lands_in_a_named_group_not_other(owner):
    """``other`` 是兜底,不是归宿。一个新前缀掉进 other 说明 ACTION_GROUPS
    该补一行了 —— 宁可分组难看也不能让动作从下拉里消失,但也别默默难看下去。"""
    rows = _client(owner).get(URL).data["actions"]
    orphans = sorted(r["value"] for r in rows if r["group"] == "other")
    assert not orphans, f"这些动作没有归组:{orphans}"


def test_bot_actions_are_in_the_catalogue(owner):
    """线 B 的直接需求:「谁停用了生产机器人」要能被筛出来。"""
    values = {r["value"] for r in _client(owner).get(URL).data["actions"]}
    assert {"bot.create", "bot.update", "bot.delete", "bot.webhook_view"} <= values


def test_the_catalogue_needs_the_same_permission_as_the_log_itself(owner):
    """它描述的是这份日志的形状,不该比日志本身好拿。"""
    organization = models.Membership.objects.get(user=owner).organization
    outsider = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization,
        user=outsider,
        org_role=models.OrgRoleChoices.MEMBER,
        is_primary=True,
    )
    assert _client(outsider).get(URL).status_code == 403


def test_the_actions_route_did_not_swallow_the_list_route(owner):
    """``actions`` 作为方法名与 DRF 的路由装配挨得很近,加错一个字就可能
    把 list 顶掉。列表还能正常返回才算这条 action 挂对了地方。"""
    assert _client(owner).get("/api/v1.0/admin/audit-logs/").status_code == 200
