"""按部门授权 + 组织级权限 = 一句兑现不了的承诺(线 B / B2)。

机器人装在会话里,会话不属于任何部门;审计日志、看板、角色目录同理 ——
这些资源上**根本没有部门这个维度**。

所以「部门作用域的角色 + 这些码」必须在**创建那一刻**就被拒,而不是让它存下来
然后每次点进去 403。后者的体验是:角色编辑器告诉你你能看机器人,你点进去
被拒绝,你去问管理员,管理员看了眼配置说「明明给你了啊」。
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models, permissions_registry

pytestmark = pytest.mark.django_db


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


@pytest.fixture
def world():
    organization = factories.OrganizationFactory()
    owner_user = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization,
        user=owner_user,
        org_role=models.OrgRoleChoices.OWNER,
        is_primary=True,
    )
    department = models.Department.objects.create(
        organization=organization, name="Eng"
    )
    target = factories.UserFactory()
    target_membership = models.Membership.objects.create(
        organization=organization,
        user=target,
        department=department,
        org_role=models.OrgRoleChoices.MEMBER,
        is_primary=True,
    )
    return {
        "organization": organization,
        "owner": owner_user,
        "department": department,
        "membership": target_membership,
    }


def _role(organization, *permissions, code="custom"):
    return models.AdminRole.objects.create(
        organization=organization,
        code=code,
        name=code,
        permissions=list(permissions),
    )


def _assign(client, role, membership, department=None):
    body = {
        "role": str(role.pk),
        "membership": str(membership.pk),
        "scope_type": (
            models.AdminScopeChoices.DEPARTMENTS
            if department
            else models.AdminScopeChoices.ALL
        ),
    }
    if department:
        body["department_ids"] = [str(department.pk)]
    return client.post("/api/v1.0/admin/role-assignments/", body, format="json")


# ---- 源头:角色分配 ------------------------------------------------------------


@pytest.mark.parametrize("code", sorted(permissions_registry.UNSCOPABLE))
def test_an_unscopable_permission_cannot_be_granted_by_department(world, code):
    role = _role(world["organization"], code, code=f"r-{code.replace('.', '-')}")
    response = _assign(
        _client(world["owner"]), role, world["membership"], world["department"]
    )
    assert response.status_code == 400, response.data
    assert "scope_type" in response.data


@pytest.mark.parametrize("code", sorted(permissions_registry.UNSCOPABLE))
def test_the_same_role_is_fine_over_the_whole_organization(world, code):
    """拒的是**组合**,不是这些码本身。"""
    role = _role(world["organization"], code, code=f"ok-{code.replace('.', '-')}")
    response = _assign(_client(world["owner"]), role, world["membership"])
    assert response.status_code == 201, response.data


def test_a_scopable_role_can_still_be_scoped_to_a_department(world):
    """回归:这条校验不该把正常的部门授权也拦掉。"""
    role = _role(world["organization"], "org.member.read", "org.member.write")
    response = _assign(
        _client(world["owner"]), role, world["membership"], world["department"]
    )
    assert response.status_code == 201, response.data


def test_the_error_names_the_offending_codes(world):
    """只说「不行」的话,管理员得自己去猜是哪一个码 —— 而角色可能有十几个。"""
    role = _role(world["organization"], "org.member.read", "org.bot.read")
    response = _assign(
        _client(world["owner"]), role, world["membership"], world["department"]
    )
    assert "org.bot.read" in str(response.data["scope_type"])
    assert "org.member.read" not in str(response.data["scope_type"])


# ---- 另一头:改角色的权限集 ----------------------------------------------------
#
# 上面那道守卫只管**授予**那一步,而角色的权限集是可以事后改的:先按部门授出去、
# 再回来给角色勾上 org.bot.read,整条守卫就绕过去了 —— 而这正是真实部署里最容易
# 走到的顺序(先建角色分下去,用起来才发现少个权限)。真机验收时发现的。


def _patch_permissions(client, role, permissions):
    return client.patch(
        f"/api/v1.0/admin/roles/{role.pk}/",
        {"permissions": permissions},
        format="json",
    )


def test_a_department_scoped_role_cannot_be_handed_an_unscopable_code(world):
    role = _role(world["organization"], "org.member.read")
    client = _client(world["owner"])
    assert (
        _assign(client, role, world["membership"], world["department"]).status_code
        == 201
    )

    response = _patch_permissions(client, role, ["org.member.read", "org.bot.read"])
    assert response.status_code == 400, response.data
    assert "org.bot.read" in str(response.data["permissions"])
    role.refresh_from_db()
    assert role.permissions == ["org.member.read"], "被拒了就不该写进去"


def test_an_org_wide_holder_does_not_block_the_permission(world):
    """拒的仍然是**组合**。整个组织作用域的持有人一点问题都没有。"""
    role = _role(world["organization"], "org.member.read")
    client = _client(world["owner"])
    assert _assign(client, role, world["membership"]).status_code == 201

    response = _patch_permissions(client, role, ["org.member.read", "org.bot.read"])
    assert response.status_code == 200, response.data


def test_a_role_nobody_holds_can_take_the_permission(world):
    """没有部门作用域的持有人就没有承诺可以食言 —— 别把正常编辑也拦掉。"""
    role = _role(world["organization"], "org.member.read")
    response = _patch_permissions(
        _client(world["owner"]), role, ["org.member.read", "org.bot.read"]
    )
    assert response.status_code == 200, response.data


def test_removing_permissions_from_a_scoped_role_is_never_blocked(world):
    """收窄权限永远该放行 —— 否则一个配坏了的角色就再也修不回来了。"""
    role = _role(world["organization"], "org.member.read")
    client = _client(world["owner"])
    _assign(client, role, world["membership"], world["department"])
    assert _patch_permissions(client, role, []).status_code == 200


# ---- 两头的错误都带机器可读的 code --------------------------------------------


def _flat(value):
    """DRF 在 serializer 里抛的 ``ValidationError`` 会被 ``as_serializer_error``
    把**每个值**都规整成列表 —— 包括我们挂上去的 ``code``/``count``。

    在 viewset 方法里抛的则原样是标量(群机器人回调地址那条就是)。同一个后端
    两种形状,所以前端 ``apiErrorCode`` 两种都认;这里跟着断言真实的线上形状,
    别把它抹平成「我以为的样子」。
    """
    return [str(v) for v in value] if isinstance(value, list) else str(value)


def test_both_ends_carry_a_machine_readable_code(world):
    """后端 `.po` 里这两条都没有中文,真机上管理员看到的是一句英文,而管理台
    其余部分全是中文。所以带一个 code 让前端映射 —— 与回调地址被拒时那条
    (`outbound_http` 的 category)是同一套路。"""
    client = _client(world["owner"])

    scoped_role = _role(world["organization"], "org.bot.read", code="a")
    assign = _assign(client, scoped_role, world["membership"], world["department"])
    assert _flat(assign.data["code"]) == ["unscopable_scope"]
    assert _flat(assign.data["codes"]) == ["org.bot.read"]

    plain_role = _role(world["organization"], "org.member.read", code="b")
    _assign(client, plain_role, world["membership"], world["department"])
    patched = _patch_permissions(client, plain_role, ["org.bot.read"])
    assert _flat(patched.data["code"]) == ["unscopable_assigned"]
    assert _flat(patched.data["codes"]) == ["org.bot.read"]
    # 插值用 —— 「已按部门授予给 1 人」比「已被授予」更能让人知道去改哪里。
    assert _flat(patched.data["count"]) == ["1"]


# ---- 注册表本身 ---------------------------------------------------------------


def test_the_three_bot_codes_exist_and_are_grantable():
    for code in ("org.bot.read", "org.bot.write", "org.bot.secret.read"):
        assert code in permissions_registry.ALL_PERMISSIONS
    # 不在 OWNER_ONLY:那条线是给提权原语的,读机器人凭据是横向能力够不上。
    assert not (
        {"org.bot.read", "org.bot.write", "org.bot.secret.read"}
        & permissions_registry.OWNER_ONLY
    )


def test_reading_bot_credentials_is_filed_as_sensitive():
    """它不是「读」,是**给自己发消息的权力** —— 而且撤销权限收不回已经泄露的
    凭据。归 sensitive 分组是为了在角色编辑器里跟其他读权限分开显示。"""
    _label, group = permissions_registry.PERMISSIONS["org.bot.secret.read"]
    assert group == "sensitive"


def test_no_builtin_role_gets_the_credential_permission():
    """必须 owner 明确勾选。内置角色里出现它 = 装个机器人就等于把凭据发给了
    一批人。"""
    for code, (_label, granted) in permissions_registry.BUILTIN_ROLES.items():
        assert "org.bot.secret.read" not in granted, code


def test_it_manages_integrations_so_it_gets_read_and_write():
    """机器人是集成,IT 管集成。这两个码是**和 M 端机器人页同一批**授出去的
    —— 授一个还没有页面的权限,导航会给他显示一个点不开的入口。"""
    _label, granted = permissions_registry.BUILTIN_ROLES["it"]
    assert {"org.bot.read", "org.bot.write"} <= granted


def test_hr_and_admin_office_do_not_get_bot_codes():
    """治理机器人不在他们的职责里 —— 授了只会让两个看板多一个用不上的入口。"""
    for code in ("hr", "admin_office"):
        _label, granted = permissions_registry.BUILTIN_ROLES[code]
        assert not (granted & {"org.bot.read", "org.bot.write"}), code


def test_every_unscopable_code_is_a_real_permission():
    """打错一个字的话它就是个永远匹配不上的死码,校验静默失效。"""
    assert permissions_registry.UNSCOPABLE <= permissions_registry.ALL_PERMISSIONS
