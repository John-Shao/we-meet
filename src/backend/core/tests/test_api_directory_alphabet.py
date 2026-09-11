"""通讯录的拼音排序与首字母:``User.full_name_pinyin`` / ``full_name_initial``。

对应 ``core/services/pinyin.py`` 与 ``DirectoryMemberViewSet`` 的 ``?ordering=pinyin``。

（曾经的 ``?from_initial=`` 与 ``alphabet/`` 端点随 A–Z 索引条一起删了 —— 见
git log 里那两笔「drop the A-Z index rail」/「remove the dead pinyin-index endpoints」。
本文件现在只钉排序键、首字母与墓碑卡。）
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services import pinyin

pytestmark = pytest.mark.django_db

MEMBERS_URL = "/api/v1.0/directory/members/"


def _membership(org, user, department=None, is_primary=True, **kwargs):
    return models.Membership.objects.create(
        organization=org,
        user=user,
        department=department,
        is_primary=is_primary,
        **kwargs,
    )


def _org_with(client_names):
    """建一个组织 + 调用者 + 给定姓名的成员们,返回 (client, [姓名 → user])。

    调用者自己也在目录里(和真实情况一致),断言时按姓名取值而不是按下标。
    """
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self", email="caller@acme.com")
    _membership(org, me)
    users = [me]
    for name in client_names:
        user = factories.UserFactory(full_name=name)
        _membership(org, user)
        users.append(user)
    client = APIClient()
    client.force_login(me)
    return client, users


def _names(response):
    return [row["full_name"] for row in response.json()["results"]]


def test_model_save_keeps_pinyin_columns_in_sync():
    """名字变了,派生列跟着变 —— 没有这一步,排序和搜索会各说各话。

    键的格式写死在这里(而不是拿 ``pinyin_sort_key()`` 跟自己比):它是**存储约定**,
    前端/迁移/索引都依赖它,变了就该有一条测试红。
    """
    user = factories.UserFactory(full_name="张三", short_name="")
    assert user.full_name_pinyin == "0zhangsan"
    assert user.full_name_initial == "Z"
    assert user.search_key == "zhangsan zs"

    user.full_name = "李四"
    user.save()
    user.refresh_from_db()
    assert user.full_name_pinyin == "0lisi"
    assert user.full_name_initial == "L"
    assert user.search_key == "lisi ls"


def test_model_save_with_update_fields_still_writes_pinyin():
    """``save(update_fields=["full_name"])`` 也要把派生列带上。

    改昵称的接口正是这么写的(viewsets 里的 profile 更新)—— 漏掉的话会留下一个
    「名字变了、排序键/搜索键还是旧的」的用户,而且要到下次有人改这个用户才被发现。
    """
    user = factories.UserFactory(full_name="张三", short_name="")
    user.full_name = "王五"
    user.save(update_fields=["full_name"])

    user.refresh_from_db()
    assert user.full_name_pinyin == "0wangwu"
    assert user.full_name_initial == "W"
    assert user.search_key == "wangwu ww"


def test_model_save_prefixes_the_hash_bucket_key():
    """数字/符号名字落库时带 '1' 桶类前缀:桶序是**数据**,不是查询时的表达式。

    前缀在改名时要跟着变回 '0' —— 否则一个从「1001」改成「张三」的用户会永远留在
    名册最后面。
    """
    user = factories.UserFactory(full_name="1001")
    assert user.full_name_pinyin == "11001"
    assert user.full_name_initial == pinyin.OTHER_INITIAL

    user.full_name = "张三"
    user.save()
    user.refresh_from_db()
    assert user.full_name_pinyin == "0zhangsan"
    assert user.full_name_initial == "Z"


def test_api_directory_members_default_order_is_untouched():
    """不加参数就还是老行为(编码序)—— Android 端与既有调用点不受影响。"""
    client, _ = _org_with(["张三", "李四", "王五"])

    response = client.get(MEMBERS_URL)

    assert response.status_code == 200
    names = [n for n in _names(response) if n in {"张三", "李四", "王五"}]
    assert names == ["张三", "李四", "王五"]  # 编码序,不是拼音序


def test_api_directory_members_order_by_pinyin():
    """?ordering=pinyin 按拼音排 —— 与编码序不同,这正是加这一列的理由。"""
    client, _ = _org_with(["张三", "李四", "王五", "Alice"])

    response = client.get(f"{MEMBERS_URL}?ordering=pinyin")

    assert response.status_code == 200
    names = [n for n in _names(response) if n in {"张三", "李四", "王五", "Alice"}]
    assert names == ["Alice", "李四", "王五", "张三"]


def test_api_directory_members_pinyin_order_puts_other_bucket_last():
    """数字/符号/空名字那一桶排最后 —— 与首字母分桶的顺序一致。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self")
    _membership(org, me)
    for name in ["解九", "1001", "阿宝"]:
        _membership(org, factories.UserFactory(full_name=name))
    client = APIClient()
    client.force_login(me)

    response = client.get(f"{MEMBERS_URL}?ordering=pinyin")

    names = [n for n in _names(response) if n in {"解九", "1001", "阿宝"}]
    # 纯字符串序会把 '1001' 排最前(数字 < 字母);'#' 桶必须在最后。
    assert names == ["阿宝", "解九", "1001"]


def test_api_directory_department_members_order_by_pinyin():
    """部门成员接口同样支持拼音序(几百人的部门是同一个问题)。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self")
    _membership(org, me)
    eng = models.Department.objects.create(organization=org, name="Engineering")
    for name in ["张三", "李四", "王五"]:
        _membership(org, factories.UserFactory(full_name=name), department=eng)
    client = APIClient()
    client.force_login(me)

    ordered = client.get(
        f"/api/v1.0/directory/departments/{eng.id}/members/?ordering=pinyin"
    )

    assert [n for n in _names(ordered) if n != "Caller Self"] == [
        "李四",
        "王五",
        "张三",
    ]


def test_api_directory_member_card_exposes_initial():
    """成员卡片带上首字母:前端拿它画分组头,不自己重算拼音。"""
    client, _ = _org_with(["张三"])

    response = client.get(f"{MEMBERS_URL}?ordering=pinyin")
    rows = {row["full_name"]: row for row in response.json()["results"]}

    assert rows["张三"]["initial"] == "Z"


def test_api_directory_pinyin_order_files_accented_latin_names():
    """带音标的拉丁名(法/德/荷/北欧姓名)照字母归档,而不是被丢进「其他」桶。

    产品明确支持 fr / de / nl —— 这些组织看到的名册必须和纯英文组织一样正常:
    排序按字母,E 就是 E。
    """
    client, _ = _org_with(["Zoe", "Émile", "Ørsted", "Łukasz"])

    ordered = client.get(f"{MEMBERS_URL}?ordering=pinyin")
    names = [
        n
        for n in _names(ordered)
        if n in {"Zoe", "Émile", "Ørsted", "Łukasz"}
    ]
    assert names == ["Émile", "Łukasz", "Ørsted", "Zoe"]


def test_api_directory_departed_card_carries_initial():
    """墓碑卡与在世成员**同一张卡的形状**:少一个 initial,前端列表就会缺一格。

    已离职的人仍然要有拼音首字母 —— 它由名字算出来,与在职状态无关。
    """
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    gone = factories.UserFactory(full_name="张三")
    membership = _membership(org, gone, is_primary=False)
    membership.left_snapshot = membership.build_left_snapshot()
    membership.status = models.MembershipStatusChoices.LEFT
    membership.save()

    client = APIClient()
    client.force_login(me)
    card = client.get(f"{MEMBERS_URL}{gone.id}/").json()

    assert card["left"] is True
    assert card["initial"] == "Z"
