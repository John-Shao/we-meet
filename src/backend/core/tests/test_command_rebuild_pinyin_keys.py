"""
``manage.py rebuild_pinyin_keys`` —— 滚动发布窗口留下的旧格式行的修复入口。

为什么值得一测:这些派生列是**旧代码也会写**的列(见命令的 docstring),而写错之后
不会报错,只会让那个人排到名册第一行、且搜不到他。既然唯一会自愈的路径是「有人再保存
一次这个用户」,这个命令就是发布后的兜底,它自己不能是错的:

- 必须能认出旧格式(没有桶类前缀 / ``search_key`` 为空),且**只**改这些行;
- 必须幂等(跑第二次什么都不改);
- ``--check`` 必须真的以非零退出码结束(部署后的门禁靠它,不是靠日志里的人眼)。
"""

import pytest
from django.core.management import call_command

from core import factories, models

pytestmark = pytest.mark.django_db


def _rewrite_like_an_old_release(user, *, sort_key, search_key, initial="?"):
    """照旧代码的写法把派生列写坏(绕过 ``save()``,它就是「旧镜像写过」的样子)。"""
    models.User.objects.filter(id=user.id).update(
        full_name_pinyin=sort_key,
        full_name_initial=initial,
        search_key=search_key,
    )


def test_rebuild_fixes_rows_written_by_an_older_release():
    """旧格式的排序键(无桶类前缀)与空 search_key 都要被修回来。"""
    zhangsan = factories.UserFactory(full_name="张三", short_name="", email="z@a.com")
    # 0144 之前:字母桶没有 '0' 前缀;0145 之前:search_key 根本不存在。
    _rewrite_like_an_old_release(
        zhangsan, sort_key="zhangsan", search_key="", initial="Z"
    )

    call_command("rebuild_pinyin_keys", verbosity=0)

    zhangsan.refresh_from_db()
    assert zhangsan.full_name_pinyin == "0zhangsan"
    assert zhangsan.full_name_initial == "Z"
    assert zhangsan.search_key == "zhangsan zs"


def test_rebuild_only_touches_stale_rows_and_is_idempotent():
    """算对了的行不该被写(没有变化就没有 update),重复跑是 no-op。"""
    stale = factories.UserFactory(full_name="夜来香", short_name="", email="y@a.com")
    fresh = factories.UserFactory(full_name="李四", short_name="", email="l@a.com")
    _rewrite_like_an_old_release(stale, sort_key="yelaixiang", search_key="")
    before = models.User.objects.get(id=fresh.id).search_key

    call_command("rebuild_pinyin_keys", verbosity=0)
    call_command("rebuild_pinyin_keys", verbosity=0)

    stale.refresh_from_db()
    fresh.refresh_from_db()
    assert stale.search_key == "yelaixiang ylx"
    assert stale.full_name_pinyin == "0yelaixiang"
    # 本来就算对的那些行一个字节都没动。
    assert fresh.search_key == before == "lisi ls"


def test_dry_run_reports_without_writing():
    """``--dry-run`` 只报告:发布前先看一眼有多少残留,不该顺手改库。"""
    user = factories.UserFactory(full_name="张三", short_name="", email="z@a.com")
    _rewrite_like_an_old_release(user, sort_key="zhangsan", search_key="")

    call_command("rebuild_pinyin_keys", "--dry-run", verbosity=0)

    user.refresh_from_db()
    assert user.full_name_pinyin == "zhangsan"  # 仍是坏的
    assert user.search_key == ""


def test_check_exits_non_zero_when_the_database_is_stale():
    """``--check`` 是部署后的门禁:还有残留就必须以非零退出码结束。"""
    user = factories.UserFactory(full_name="张三", short_name="", email="z@a.com")
    _rewrite_like_an_old_release(user, sort_key="zhangsan", search_key="")

    with pytest.raises(SystemExit) as excinfo:
        call_command("rebuild_pinyin_keys", "--check", verbosity=0)
    assert excinfo.value.code == 1
    # 门禁只报告,不修 —— 否则「检查」这一步会悄悄改变它正在检查的东西。
    user.refresh_from_db()
    assert user.full_name_pinyin == "zhangsan"

    # 修完之后同一个门禁应当是绿的(幂等的那一半)。
    call_command("rebuild_pinyin_keys", verbosity=0)
    call_command("rebuild_pinyin_keys", "--check", verbosity=0)


def test_rebuild_handles_a_batch_boundary():
    """批大小 1 时(每行一批)也得把每一行都修到 —— 收尾那次 flush 最容易漏。"""
    users = [
        factories.UserFactory(full_name=f"张三{i}", short_name="", email=f"z{i}@a.com")
        for i in range(3)
    ]
    for user in users:
        _rewrite_like_an_old_release(user, sort_key="zhangsan", search_key="")

    call_command("rebuild_pinyin_keys", "--batch-size", "1", verbosity=0)

    for index, user in enumerate(users):
        user.refresh_from_db()
        assert user.search_key.startswith(f"zhangsan{index}"), user.full_name
        assert user.full_name_pinyin.startswith("0zhangsan")
