"""导航显示什么,端点就得放什么进来(线 B / B5b)。

## 这个文件存在的理由

控制台的侧边栏按**权限码**过滤(`AdminShell.tsx`,每项一个 `permission`),
而端点各自有自己的门。两边一旦对不上,症状是**只有非 owner 才看得到的**:

* owner / administrator 持 `ALL_PERMISSIONS`,两种门都过 —— 开发和验收基本
  都是用 owner 账号做的,所以**永远看不到这个 bug**
* 被授了内置角色的人看得到菜单项、点进去 403

M 端上线以来 hr / it / admin_office 三个内置角色的看板就一直是坏的,
`admin_stats` / `admin_audit` / `admin_meeting_rooms`(4 个 viewset)/
`admin_invitations` 共 4 处都还是 `IsOrgAdmin`(= owner/administrator 成员角色),
而导航按 `org.stats.read` 等权限码放行。

## 为什么不是逐个端点写 403 测试

那样每加一个页面就要记得再写一条,而**忘了写**恰恰是这个 bug 的成因。
这里改成从**内置角色**出发反过来查:一个角色只要持有某个导航码,对应端点就
必须让他过。新增页面时把它加进 `NAV_CONTRACT` 一行,三个角色自动全测。
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.permissions_registry import BUILTIN_ROLES

pytestmark = pytest.mark.django_db


#: 导航权限码 → 该菜单项点进去会打的端点。
#:
#: **与 `AdminShell.tsx` 的 `permission` 字段逐条对应。** 前端加一项、后端
#: 加一个 admin 端点,都要在这里加一行 —— 这张表就是那份契约本身。
NAV_CONTRACT: list[tuple[str, str]] = [
    ("org.stats.read", "/api/v1.0/admin/stats/overview/"),
    ("org.member.read", "/api/v1.0/admin/memberships/"),
    ("org.group.read", "/api/v1.0/admin/user-groups/"),
    ("org.role.read", "/api/v1.0/admin/roles/"),
    ("org.invitation.write", "/api/v1.0/admin/invitations/"),
    ("org.meeting_room.write", "/api/v1.0/admin/meeting-rooms/"),
    ("org.meeting_room.write", "/api/v1.0/admin/meeting-room-nodes/"),
    ("org.meeting_room.write", "/api/v1.0/admin/meeting-room-facilities/"),
    ("org.meeting_room.write", "/api/v1.0/admin/meeting-room-bookings/"),
    ("org.audit.read", "/api/v1.0/admin/audit-logs/"),
    ("org.department.read", "/api/v1.0/admin/departments/"),
]


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _role_holder(organization, code: str):
    """一个只有该内置角色、成员角色是普通 member 的人。

    `org_role` 必须是 MEMBER —— 设成 ADMINISTRATOR 的话 `ALL_PERMISSIONS`
    会让每一条都通过,这个测试就变成永远绿的空转。
    """
    user = factories.UserFactory()
    membership = models.Membership.objects.create(
        organization=organization,
        user=user,
        org_role=models.OrgRoleChoices.MEMBER,
        is_primary=True,
    )
    label, permissions = BUILTIN_ROLES[code]
    role = models.AdminRole.objects.create(
        organization=organization,
        code=code,
        name=str(label),
        permissions=sorted(permissions),
    )
    models.AdminRoleAssignment.objects.create(
        role=role, membership=membership, scope_type=models.AdminScopeChoices.ALL
    )
    return user


@pytest.mark.parametrize("role_code", sorted(BUILTIN_ROLES))
@pytest.mark.parametrize(("permission", "url"), NAV_CONTRACT)
def test_a_builtin_role_can_reach_every_page_its_permissions_show_it(
    role_code, permission, url
):
    organization = factories.OrganizationFactory()
    _label, granted = BUILTIN_ROLES[role_code]
    if permission not in granted:
        pytest.skip(f"{role_code} 没有 {permission},导航本来就不显示这一项")

    user = _role_holder(organization, role_code)
    response = _client(user).get(url)

    assert response.status_code != 403, (
        f"内置角色 {role_code} 持有 {permission},控制台会给他显示这一项,"
        f"但 {url} 拒绝了他 —— 导航与端点的门对不上。"
        f"多半是端点还挂着 IsOrgAdmin(成员角色)而不是 HasOrgPermission(权限码)。"
    )


@pytest.mark.parametrize(("permission", "url"), NAV_CONTRACT)
def test_someone_with_no_admin_role_at_all_is_still_refused(permission, url):
    """反向哨兵:上面那条如果因为「端点根本不设防」而全绿,这条会红。

    没有它,把某个端点的 permission_classes 删空也能让整个文件通过。
    """
    organization = factories.OrganizationFactory()
    user = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization,
        user=user,
        org_role=models.OrgRoleChoices.MEMBER,
        is_primary=True,
    )
    assert _client(user).get(url).status_code == 403, f"{url} 对普通成员没有设防"


#: 这些码管的是**页面里的一个动作**,不是一个页面 —— 所以 NAV_CONTRACT 里
#: 没有它们不是遗漏。持有它们的人是靠同页的读码看到入口的。
#:
#: 新增权限码时必须在这里或 NAV_CONTRACT 二选一登记,下面那条会逼你做这个
#: 决定 —— 「它是开一扇门还是开一个按钮」正是最容易糊过去的一步。
ACTION_ONLY_PERMISSIONS = frozenset(
    {
        "org.department.write",  # /org 里改部门树
        "org.member.write",  # /org 里改人
        "org.member.offboard",  # /org 里离职(单独授权:动 Keycloak 和资源归属)
        "org.group.write",  # /groups 里改组
        "org.import.write",  # /org 里的批量导入
        "org.ai_quota.read",  # 配额面板,挂在别的页里
    }
)


def test_every_permission_a_builtin_role_grants_is_registered_somewhere():
    """内置角色被授了某个码,却既不对应页面也没登记成页内动作 —— 那要么是有个
    页面漏登记了,要么这个码根本是死的。两种都该被看见。"""
    covered = {permission for permission, _url in NAV_CONTRACT}
    granted = set()
    for _label, permissions in BUILTIN_ROLES.values():
        granted |= set(permissions)
    missing = sorted(granted - covered - ACTION_ONLY_PERMISSIONS)
    assert not missing, (
        f"这些码被内置角色授出去了,但既不在 NAV_CONTRACT 也不在 "
        f"ACTION_ONLY_PERMISSIONS:{missing}。它开的是一扇门还是一个按钮?"
    )


def test_the_two_registries_do_not_overlap():
    """一个码同时被登记成「页面」和「只是页内动作」,说明有人两边都加了一遍
    好让上面那条闭嘴。"""
    overlap = sorted({p for p, _u in NAV_CONTRACT} & ACTION_ONLY_PERMISSIONS)
    assert not overlap, f"重复登记:{overlap}"
