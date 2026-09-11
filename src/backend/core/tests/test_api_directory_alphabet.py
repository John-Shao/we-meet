"""通讯录 A–Z 索引:拼音排序、首字母分桶与索引条计数。

对应 ``User.full_name_pinyin`` / ``full_name_initial``(见 core/services/pinyin.py)
与 ``DirectoryMemberViewSet`` 的 ``?ordering=pinyin`` / ``?initial=`` / ``alphabet``。
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
    """名字变了,派生列跟着变 —— 没有这一步,排序和索引会各说各话。

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
    """数字/符号/空名字那一桶排最后 —— 索引条上它也在 A–Z 之后,顺序要一致。"""
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


def test_api_directory_members_start_at_initial():
    """?from_initial=L 从 L 开始 —— 点索引条的手感:起点之后还能一路往下滚。"""
    client, _ = _org_with(["张三", "李四", "李雷", "王五"])

    response = client.get(f"{MEMBERS_URL}?ordering=pinyin&from_initial=L")

    assert response.status_code == 200
    names = [n for n in _names(response) if n in {"张三", "李四", "李雷", "王五"}]
    # 不是「只有 L」:L 之后的 W/Z 也在,而且同一字母内按拼音排(lilei < lisi)。
    assert names == ["李雷", "李四", "王五", "张三"]


def test_api_directory_members_from_initial_excludes_earlier_letters():
    """起点之前的字母不出现 —— 否则「跳到 L」在屏幕上什么也没跳。"""
    client, _ = _org_with(["张三", "李四", "阿宝"])

    response = client.get(f"{MEMBERS_URL}?ordering=pinyin&from_initial=L")

    names = [n for n in _names(response) if n in {"张三", "李四", "阿宝"}]
    assert names == ["李四", "张三"]


def test_api_directory_members_from_initial_bucket_hash():
    """?from_initial=# 命中「分不出首字母」那一桶(数字人名)。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self")
    _membership(org, me)
    _membership(org, factories.UserFactory(full_name="1001"))
    _membership(org, factories.UserFactory(full_name="张三"))
    client = APIClient()
    client.force_login(me)

    response = client.get(f"{MEMBERS_URL}?ordering=pinyin&from_initial=%23")

    names = [n for n in _names(response) if n in {"1001", "张三"}]
    assert names == ["1001"]


def test_api_directory_members_ignores_bogus_from_initial():
    """非法起点当没传,而不是静默返回空列表(那会被读成「这个字母没人」)。"""
    client, _ = _org_with(["张三", "李四"])

    response = client.get(f"{MEMBERS_URL}?ordering=pinyin&from_initial=XY")

    assert response.status_code == 200
    assert len(response.json()["results"]) >= 3


def test_api_directory_members_start_at_a_returns_everything():
    """从 A 开始 = 整册人,顺序仍是拼音序(索引条上的第一个字母)。"""
    client, _ = _org_with(["张三", "李四"])

    from_a = client.get(f"{MEMBERS_URL}?from_initial=A")
    all_pinyin = client.get(f"{MEMBERS_URL}?ordering=pinyin")

    assert _names(from_a) == _names(all_pinyin)


def test_api_directory_from_initial_combines_with_search():
    """起点与就地搜索是「与」的关系,不是互相覆盖。"""
    client, _ = _org_with(["李四", "李雷", "张三"])

    response = client.get(f"{MEMBERS_URL}?ordering=pinyin&from_initial=L&q=雷")

    names = [n for n in _names(response) if n in {"李四", "李雷", "张三"}]
    assert names == ["李雷"]


def test_api_directory_alphabet_counts_per_initial():
    """索引条的数据:每个字母各有多少人,'#' 排最后。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Zed Caller")
    _membership(org, me)
    for name in ["张三", "李四", "李雷", "王五", "1001", "阿宝"]:
        _membership(org, factories.UserFactory(full_name=name))
    client = APIClient()
    client.force_login(me)

    response = client.get(f"{MEMBERS_URL}alphabet/")

    assert response.status_code == 200
    letters = response.json()["letters"]
    by_letter = {row["letter"]: row["count"] for row in letters}
    assert by_letter["L"] == 2  # 李四、李雷
    assert by_letter["Z"] == 2  # 张三 + 调用者 Zed Caller
    assert by_letter["W"] == 1
    assert by_letter["A"] == 1
    assert by_letter[pinyin.OTHER_INITIAL] == 1  # 1001
    # '#' 必须排在最后,而不是因为 ASCII 35 < 'A' 窜到最前。
    assert letters[-1]["letter"] == pinyin.OTHER_INITIAL
    assert [row["letter"] for row in letters[:-1]] == sorted(
        row["letter"] for row in letters[:-1]
    )


def test_api_directory_alphabet_respects_department_filter():
    """索引条跟着当前部门走 —— 不然点一个部门后字母数还是全公司的。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self")
    _membership(org, me)
    eng = models.Department.objects.create(organization=org, name="Engineering")
    _membership(org, factories.UserFactory(full_name="张三"), department=eng)
    _membership(org, factories.UserFactory(full_name="李四"), department=eng)

    client = APIClient()
    client.force_login(me)
    response = client.get(f"{MEMBERS_URL}alphabet/?department={eng.id}")

    assert response.status_code == 200
    assert {row["letter"] for row in response.json()["letters"]} == {"L", "Z"}


def test_api_directory_alphabet_ignores_from_initial_param():
    """alphabet 不吃 ?from_initial= —— 它问的就是「每个字母各有多少人」。"""
    client, _ = _org_with(["张三", "李四"])

    response = client.get(f"{MEMBERS_URL}alphabet/?from_initial=L&ordering=pinyin")

    assert response.status_code == 200
    letters = {row["letter"] for row in response.json()["letters"]}
    assert {"L", "Z"} <= letters


def test_api_directory_department_members_order_by_pinyin():
    """部门成员接口同样支持拼音序与起点(几百人的部门是同一个问题)。"""
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
    from_li = client.get(
        f"/api/v1.0/directory/departments/{eng.id}/members/"
        "?ordering=pinyin&from_initial=L"
    )

    assert [n for n in _names(ordered) if n != "Caller Self"] == [
        "李四",
        "王五",
        "张三",
    ]
    assert _names(from_li) == ["李四", "王五", "张三"]


def test_api_directory_member_card_exposes_initial():
    """成员卡片带上首字母:前端拿它画分组头,不自己重算拼音。"""
    client, _ = _org_with(["张三"])

    response = client.get(f"{MEMBERS_URL}?ordering=pinyin&from_initial=Z")
    rows = {row["full_name"]: row for row in response.json()["results"]}

    assert rows["张三"]["initial"] == "Z"


def test_api_directory_alphabet_is_org_scoped():
    """字母计数不能漏出别的组织的人 —— 聚合查询是最容易漏掉组织隔离的地方。"""
    org = factories.OrganizationFactory()
    other = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self")
    _membership(org, me)
    _membership(org, factories.UserFactory(full_name="张三"))
    _membership(other, factories.UserFactory(full_name="李四"))  # L 桶只属于别的组织

    client = APIClient()
    client.force_login(me)
    letters = {
        row["letter"] for row in client.get(f"{MEMBERS_URL}alphabet/").json()["letters"]
    }

    assert "Z" in letters  # 自己组织的张三
    assert "L" not in letters  # 别的组织的李四


def test_api_directory_pinyin_order_files_accented_latin_names():
    """带音标的拉丁名(法/德/荷/北欧姓名)照字母归档,而不是被丢进「其他」桶。

    产品明确支持 fr / de / nl —— 这些组织看到的名册必须和纯英文组织一样正常:
    排序按字母,索引条上 E 就是 E。
    """
    client, _ = _org_with(["Zoe", "Émile", "Ørsted", "Łukasz"])

    ordered = client.get(f"{MEMBERS_URL}?ordering=pinyin")
    names = [
        n
        for n in _names(ordered)
        if n in {"Zoe", "Émile", "Ørsted", "Łukasz"}
    ]
    assert names == ["Émile", "Łukasz", "Ørsted", "Zoe"]

    letters = {
        row["letter"] for row in client.get(f"{MEMBERS_URL}alphabet/").json()["letters"]
    }
    assert {"E", "L", "O", "Z"} <= letters
    assert pinyin.OTHER_INITIAL not in letters


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
