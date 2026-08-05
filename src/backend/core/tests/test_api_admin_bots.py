"""M 端群机器人治理 ``/admin/bots/``(线 B / B3)。

这里钉住的几条,每一条对应设计里一个「本来会错」的地方:

* 跨组织隔离,而且**内置助手的 organization 是 NULL** —— 只认
  ``bot__organization`` 会把内置助手全部漏掉(或者全部漏给别人)
* 序列化结果里**不能出现 signing_secret / webhook_url**
* ``enable`` 必须调得到一台**已停用**的机器人(筛选留在 detail 路由上是个
  很容易犯的错,那会让「已停用」变成 404)
* M 端停用**只动安装,不动 ImBot** —— 内置 bot 是全局的,停用身份会打到
  别的组织
"""

import json

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db

BASE = "/api/v1.0/admin/bots/"
CID = "44444444-4444-4444-8444-444444444444"
OTHER_CID = "55555555-5555-4555-8555-555555555555"


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _person(organization, role=models.OrgRoleChoices.MEMBER):
    user = factories.UserFactory()
    membership = models.Membership.objects.create(
        organization=organization, user=user, org_role=role, is_primary=True
    )
    return user, membership


def _grant(organization, membership, *codes, scope_all=True, department=None):
    role = models.AdminRole.objects.create(
        organization=organization,
        code=f"r{membership.pk.hex[:8]}",
        name="custom",
        permissions=list(codes),
    )
    assignment = models.AdminRoleAssignment.objects.create(
        role=role,
        membership=membership,
        scope_type=(
            models.AdminScopeChoices.ALL
            if scope_all
            else models.AdminScopeChoices.DEPARTMENTS
        ),
    )
    if department is not None:
        models.AdminRoleScopeDepartment.objects.create(
            assignment=assignment, department=department
        )
    return role


def _install(organization=None, *, cid=CID, kind="custom", name="构建通知", **extra):
    bot = models.ImBot.objects.create(
        kind=kind,
        name=name,
        # 内置助手的 slug 有格式校验(字母数字下划线连字符)+ 唯一约束,
        # 不能拿中文名当 slug。
        slug="test-assistant" if kind == "builtin" else "",
        organization=organization,
    )
    return models.ImBotInstallation.objects.create(
        bot=bot,
        cid=cid,
        # 内置助手没有 webhook token —— 它们不接受外部投递。给它一个假 token
        # 会撞上 unique 约束(同一个群里既有自定义又有内置时)。
        webhook_token=(f"tok-{name}-{cid[:8]}" if kind == "custom" else None),
        signing_secret="SIGNING-SECRET-VALUE",
        **extra,
    )


@pytest.fixture
def world():
    organization = factories.OrganizationFactory()
    owner, _ = _person(organization, models.OrgRoleChoices.OWNER)
    install = _install(organization)
    models.ImConversation.objects.create(
        cid=CID, organization=organization, name="发布通知群"
    )
    return {"organization": organization, "owner": owner, "install": install}


# ---- 组织隔离 -----------------------------------------------------------------


def test_another_organizations_bot_is_invisible(world):
    other = factories.OrganizationFactory()
    _install(other, cid=OTHER_CID, name="别人家的")
    rows = _client(world["owner"]).get(BASE).data["results"]
    assert [r["name"] for r in rows] == ["构建通知"]


def test_a_builtin_assistant_is_matched_through_the_conversation_projection(world):
    """内置助手的 ``bot.organization`` 是 NULL —— ``filter(bot__organization=org)``
    会把它们**全部静默漏掉**。归属只能靠会话投影认。"""
    _install(None, cid=CID, kind="builtin", name="日程助手")
    rows = _client(world["owner"]).get(f"{BASE}?kind=builtin").data["results"]
    assert [r["name"] for r in rows] == ["日程助手"]


def test_a_builtin_in_a_conversation_we_do_not_own_stays_invisible(world):
    """没有投影就看不见 —— **fail closed**。宁可少显示一个,不能把别的组织的
    机器人显示给你。"""
    _install(None, cid=OTHER_CID, kind="builtin", name="别处的助手")
    rows = _client(world["owner"]).get(f"{BASE}?kind=builtin").data["results"]
    assert rows == []


# ---- 默认视角 -----------------------------------------------------------------


def test_builtins_are_hidden_unless_explicitly_asked_for(world):
    """内置助手是(助手 × 会话)的笛卡尔积,几千行会把真正要治理的几十个
    自定义 bot 冲没。"""
    _install(None, cid=CID, kind="builtin", name="日程助手")
    default = _client(world["owner"]).get(BASE).data["results"]
    assert [r["name"] for r in default] == ["构建通知"]


def test_the_group_name_comes_from_the_projection(world):
    (row,) = _client(world["owner"]).get(BASE).data["results"]
    assert row["conversation_name"] == "发布通知群"


def test_a_meeting_group_reads_its_name_from_the_room_not_a_snapshot(world):
    """房间改名后治理页要立刻跟着改 —— 所以会议群的名字是 join 出来的,不存。"""
    room = factories.RoomFactory(name="周会")
    models.MeetingConversation.objects.create(room=room, cid=OTHER_CID)
    models.ImConversation.objects.create(
        cid=OTHER_CID, organization=world["organization"]
    )
    _install(world["organization"], cid=OTHER_CID, name="会议助手")

    rows = _client(world["owner"]).get(BASE).data["results"]
    names = {r["name"]: r["conversation_name"] for r in rows}
    assert names["会议助手"] == "周会"

    room.name = "双周会"
    room.save()
    rows = _client(world["owner"]).get(BASE).data["results"]
    assert {r["name"]: r["conversation_name"] for r in rows}["会议助手"] == "双周会"


# ---- 凭据从不随列表下发 ---------------------------------------------------------


def test_no_credential_ever_appears_in_the_list(world):
    """**这条最容易在后续改动里被破坏。** 一页 100 行就是 100 张活凭证进了
    浏览器内存和 HTTP 缓存。"""
    response = _client(world["owner"]).get(BASE)
    body = json.dumps(response.data)
    assert "signing_secret" not in body
    assert "SIGNING-SECRET-VALUE" not in body
    assert "webhook_url" not in body
    assert "/api/bot/v1/hook/" not in body


def test_the_detail_route_ships_no_credentials_either(world):
    body = json.dumps(_client(world["owner"]).get(f"{BASE}{world['install'].pk}/").data)
    assert "SIGNING-SECRET-VALUE" not in body


def test_the_list_says_whether_a_callback_exists_but_not_where_it_points(world):
    models.ImBotInstallation.objects.filter(pk=world["install"].pk).update(
        callback_url="https://ci.example.com/hook"
    )
    (row,) = _client(world["owner"]).get(BASE).data["results"]
    assert row["has_callback"] is True
    assert "ci.example.com" not in json.dumps(row)


# ---- 停用 / 启用 --------------------------------------------------------------


def test_disable_then_enable_a_bot(world):
    client = _client(world["owner"])
    install_id = world["install"].pk
    assert client.post(f"{BASE}{install_id}/disable/").status_code == 200
    world["install"].refresh_from_db()
    assert world["install"].is_active is False
    assert client.post(f"{BASE}{install_id}/enable/").status_code == 200
    world["install"].refresh_from_db()
    assert world["install"].is_active is True


def test_enable_can_reach_an_already_disabled_bot(world):
    """**回归**:把 ``active`` 筛选留在 detail 路由上会让「已停用」变 404,
    于是 enable 永远调不到 —— 与 admin_invite_links 里那条注释同一个坑。"""
    client = _client(world["owner"])
    install_id = world["install"].pk
    client.post(f"{BASE}{install_id}/disable/")
    assert client.get(f"{BASE}?active=0").data["results"][0]["id"] == str(install_id)
    assert client.get(f"{BASE}{install_id}/").status_code == 200
    assert client.post(f"{BASE}{install_id}/enable/").status_code == 200


def test_disabling_a_builtin_never_touches_the_global_bot_row(world):
    """内置 bot 的 ``organization`` 是 NULL —— 停用那个身份是**全局**停用,
    会打到别的组织。M 端只动安装。"""
    install = _install(None, cid=CID, kind="builtin", name="日程助手")
    _client(world["owner"]).post(f"{BASE}{install.pk}/disable/")
    install.refresh_from_db()
    install.bot.refresh_from_db()
    assert install.is_active is False
    assert install.bot.is_active is True


def test_disable_records_its_own_audit_action(world):
    """不复用 ``bot.update`` —— 「谁停了生产机器人」是这块唯一真正要能被筛出来
    的事件,混进 C 端改个名也用的那个动作里等于没做。"""
    _client(world["owner"]).post(
        f"{BASE}{world['install'].pk}/disable/", {"reason": "刷屏"}, format="json"
    )
    row = models.AuditLog.objects.filter(
        action=models.AuditActionChoices.BOT_DISABLE
    ).get()
    assert row.metadata["surface"] == "admin"
    assert row.metadata["reason"] == "刷屏"


# ---- 凭据接口 -----------------------------------------------------------------


def test_reading_a_credential_is_one_row_and_one_audit_entry(world):
    response = _client(world["owner"]).get(f"{BASE}{world['install'].pk}/credential/")
    assert response.status_code == 200
    assert response.data["signing_secret"] == "SIGNING-SECRET-VALUE"
    assert "/api/bot/v1/hook/" in response.data["webhook_url"]
    row = models.AuditLog.objects.filter(
        action=models.AuditActionChoices.BOT_WEBHOOK_VIEW
    ).get()
    assert row.metadata["surface"] == "admin"


# ---- 权限矩阵 -----------------------------------------------------------------


def test_read_alone_cannot_disable(world):
    """停用会让**别人的** CI 告警断掉。并进 read 等于「让 IT 看看有哪些机器人」
    顺带给了「让 IT 弄坏财务的告警」。"""
    user, membership = _person(world["organization"])
    _grant(world["organization"], membership, "org.bot.read")
    client = _client(user)
    assert client.get(BASE).status_code == 200
    assert client.post(f"{BASE}{world['install'].pk}/disable/").status_code == 403


def test_write_does_not_imply_reading_credentials(world):
    user, membership = _person(world["organization"])
    _grant(world["organization"], membership, "org.bot.read", "org.bot.write")
    client = _client(user)
    assert client.post(f"{BASE}{world['install'].pk}/disable/").status_code == 200
    assert (
        client.get(f"{BASE}{world['install'].pk}/credential/").status_code == 403
    )


def test_the_credential_permission_is_enough_on_its_own(world):
    user, membership = _person(world["organization"])
    _grant(world["organization"], membership, "org.bot.read", "org.bot.secret.read")
    assert (
        _client(user).get(f"{BASE}{world['install'].pk}/credential/").status_code == 200
    )


def test_someone_with_no_bot_permission_sees_nothing(world):
    user, _membership = _person(world["organization"])
    assert _client(user).get(BASE).status_code == 403


# ---- 部门作用域 ---------------------------------------------------------------


def test_a_department_scoped_caller_gets_403_not_an_empty_list(world):
    """过滤成空读作「你们组织没有机器人」,是一句假话;403 读作「这页不归你管」,
    是真话。

    源头在角色分配那里就堵了(见 test_admin_unscopable_permissions),这条守的是
    **存量**:在源头堵上之前建的坏组合已经在库里了。
    """
    department = models.Department.objects.create(
        organization=world["organization"], name="Eng"
    )
    user, membership = _person(world["organization"])
    membership.department = department
    membership.save()
    _grant(
        world["organization"],
        membership,
        "org.bot.read",
        scope_all=False,
        department=department,
    )
    assert _client(user).get(BASE).status_code == 403


# ---- 刻意没有的东西 -----------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [("post", BASE), ("delete", f"{BASE}{{pk}}/"), ("patch", f"{BASE}{{pk}}/")],
)
def test_there_is_no_create_update_or_destroy(world, method, path):
    """装机器人是群主在 C 端做的;删除要调 jusi remove_members 并在群里留痕。
    从这里删一行,群里会留下一个还在说话、治理页上却不存在的机器人。

    改名/改配置同理 —— M 端的手段只有**停用**:可见、有 disabled_reason、可逆。
    """
    url = path.format(pk=world["install"].pk)
    response = getattr(_client(world["owner"]), method)(url, {}, format="json")
    assert response.status_code == 405, response.status_code
