"""
API tests for pinyin search in the directory: typing `ye` finds 夜来香.

这是用户诉求(「输入 ye,可以把夜来香这个人搜出来」)的可执行版本,钉在 HTTP 层:
搜索键由 `User.save()` 物化,查询侧只是 `contains` 一个折叠过的子串 —— 但两层
(物化 + 折叠 + OR)缺任何一环,下面的用例都会红。
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db


def _membership(org, user, department=None, is_primary=True, **kwargs):
    return models.Membership.objects.create(
        organization=org,
        user=user,
        department=department,
        is_primary=is_primary,
        **kwargs,
    )


def _org_with_members(**names):
    """建一个组织,`me` 是登录者,其余 kwargs 名 → full_name 各建一名成员。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self", email="caller@acme.com")
    _membership(org, me)
    for full_name, email in names.items():
        _membership(org, factories.UserFactory(full_name=full_name, email=email))
    client = APIClient()
    client.force_login(me)
    return client, org


def _ids(response):
    return {m["id"] for m in response.json()["results"]}


def test_search_by_pinyin_prefix():
    """用户诉求原话:输入 `ye`,把「夜来香」搜出来。"""
    client, org = _org_with_members(
        **{"夜来香": "yelaixiang@acme.com", "张三": "zhangsan@acme.com"}
    )
    yelaixiang = models.User.objects.get(full_name="夜来香")

    response = client.get("/api/v1.0/directory/members/?q=ye")

    assert response.status_code == 200
    assert str(yelaixiang.id) in _ids(response)
    # 不相关的人不进来。
    assert len(_ids(response)) == 1


def test_search_by_pinyin_initials():
    """输入 `ylx` 命中夜来香 —— 靠词袋里的首字母缩写。"""
    client, _ = _org_with_members(
        **{"夜来香": "yelaixiang@acme.com", "张三": "zhangsan@acme.com"}
    )
    response = client.get("/api/v1.0/directory/members/?q=ylx")
    assert response.status_code == 200
    assert len(_ids(response)) == 1
    assert response.json()["results"][0]["full_name"] == "夜来香"


def test_search_by_full_pinyin():
    client, _ = _org_with_members(
        **{"夜来香": "yelaixiang@acme.com", "欧阳修": "ouyangxiu@acme.com"}
    )
    response = client.get("/api/v1.0/directory/members/?q=ouyang")
    assert response.status_code == 200
    assert response.json()["results"][0]["full_name"] == "欧阳修"


def test_search_by_chinese_still_works():
    """汉字路径不回归 —— 那是另一条 OR 分支(full_name icontains)。"""
    client, _ = _org_with_members(
        **{"夜来香": "yelaixiang@acme.com", "张三": "zhangsan@acme.com"}
    )
    response = client.get("/api/v1.0/directory/members/?q=夜")
    assert response.status_code == 200
    assert response.json()["results"][0]["full_name"] == "夜来香"


def test_search_is_case_and_space_insensitive():
    """`Ye Lai` 与 `ye` 等价:查询词与键都折叠成小写、去空白。"""
    client, _ = _org_with_members(
        **{"夜来香": "yelaixiang@acme.com", "Yelena Smith": "yelena@acme.com"}
    )
    yelaixiang = models.User.objects.get(full_name="夜来香")
    yelena = models.User.objects.get(full_name="Yelena Smith")

    for q in ["Ye", "ye lai", "YEL"]:
        response = client.get(f"/api/v1.0/directory/members/?q={q}")
        ids = _ids(response)
        # Ye Lai → 夜来香;YEL → Yelena(但 YEL 也命中 yelaixiang 的前缀)。两类
        # 各自断言其命中即可,不强行要求只命中一个。
        if q in ("Ye", "ye lai"):
            assert str(yelaixiang.id) in ids, q
        if q == "YEL":
            assert str(yelena.id) in ids, q


def test_search_by_accent_folded_pinyin():
    """不输音标也能命中带音标的名字:ozturk → Öztürk。"""
    client, _ = _org_with_members(**{"Öztürk": "ozturk@acme.com"})
    response = client.get("/api/v1.0/directory/members/?q=ozturk")
    assert response.status_code == 200
    assert response.json()["results"][0]["full_name"] == "Öztürk"


def test_search_short_name_pinyin():
    """简称的拼音也进词袋:full=张三、short=三儿 → `se` 命中。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self", email="caller@acme.com")
    _membership(org, me)
    zhangsan = factories.UserFactory(
        full_name="张三", short_name="三儿", email="zhangsan@acme.com"
    )
    _membership(org, zhangsan)

    client = APIClient()
    client.force_login(me)
    response = client.get("/api/v1.0/directory/members/?q=se")

    assert response.status_code == 200
    assert str(zhangsan.id) in _ids(response)



def test_search_term_that_folds_to_nothing_matches_nobody():
    """一个折叠后为空的查询词不能把整个名册列出来。

    U+0301 是孤立的 NFD 组合音标(粘贴分解文本时最容易出现):`q` 非空,所以服务端
    会进筛选分支,但 `fold_search_query` 会把它折成空串。若照旧无条件 OR 进
    `search_key__contains`,那就是一条 `LIKE '%%'` —— OR 里一支恒真,筛选等于没有,
    用户会看到「全公司」而不是「没这个人」。
    """
    client, _ = _org_with_members(
        **{"夜来香": "yelaixiang@acme.com", "张三": "zhangsan@acme.com"}
    )

    # 用 params 传,免得手工拼一个非法/被转义的百分号序列。
    response = client.get("/api/v1.0/directory/members/", {"q": "\u0301"})

    assert response.status_code == 200
    assert response.json()["count"] == 0
    assert response.json()["results"] == []


def test_search_is_scoped_to_the_caller_organization():
    """别因为拼音搜索就把别的组织的人漏出来。"""
    org = factories.OrganizationFactory()
    other = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Caller Self", email="caller@acme.com")
    _membership(org, me)
    _membership(org, factories.UserFactory(full_name="夜来香", email="ylx@acme.com"))
    _membership(other, factories.UserFactory(full_name="夜来香", email="ylx@other.com"))

    client = APIClient()
    client.force_login(me)
    response = client.get("/api/v1.0/directory/members/?q=ylx")

    assert response.status_code == 200
    assert len(response.json()["results"]) == 1
    assert response.json()["results"][0]["email"] == "ylx@acme.com"


def test_rename_keeps_the_search_key_fresh():
    """改名字后搜索键要跟着变 —— update_fields 那条最容易漏的路径。"""
    client, org = _org_with_members(**{"张三": "zhangsan@acme.com"})
    zhangsan = models.User.objects.get(full_name="张三")
    assert "zhangsan" in zhangsan.search_key

    zhangsan.full_name = "李四"
    zhangsan.save(update_fields=["full_name"])
    zhangsan.refresh_from_db()

    assert "lisi" in zhangsan.search_key
    assert "zhangsan" not in zhangsan.search_key

    response = client.get("/api/v1.0/directory/members/?q=lisi")
    assert response.status_code == 200
    assert str(zhangsan.id) in _ids(response)
