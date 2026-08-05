"""会话投影的写入语义(线 B / B2)。

jusi 没有任何 admin 读接口,所以 M 端「这个机器人装在哪个群」的群名只能本地
投影。投影只有一个写入函数,因为**只有一种写法是安全的** —— 散着写四遍
``get_or_create`` 迟早有一处把 ``organization`` 也覆盖了。
"""

import pytest

from core import factories, models
from core.services import im_conversations

pytestmark = pytest.mark.django_db

CID = "22222222-2222-4222-8222-222222222222"


def test_the_first_write_records_everything():
    organization = factories.OrganizationFactory()
    user = factories.UserFactory()
    im_conversations.project(
        CID, name="发布通知群", organization=organization, created_by=user
    )
    row = models.ImConversation.objects.get(cid=CID)
    assert row.name == "发布通知群"
    assert row.organization_id == organization.pk
    assert row.created_by_id == user.pk


def test_the_name_is_overwritten_because_it_means_last_renamed_to():
    im_conversations.project(CID, name="旧名")
    im_conversations.project(CID, name="新名")
    assert models.ImConversation.objects.get(cid=CID).name == "新名"


def test_the_owning_organization_is_written_once_and_never_moved():
    """**这条是这个模块存在的安全理由。** 不这样的话,别组织的人改一次群名
    就能把归属改走 —— 而归属正是治理页判「这个群归不归你管」的依据。"""
    mine = factories.OrganizationFactory()
    theirs = factories.OrganizationFactory()
    im_conversations.project(CID, name="我的群", organization=mine)
    im_conversations.project(CID, name="改个名", organization=theirs)
    assert models.ImConversation.objects.get(cid=CID).organization_id == mine.pk


def test_the_creator_is_also_write_once():
    first = factories.UserFactory()
    second = factories.UserFactory()
    im_conversations.project(CID, created_by=first)
    im_conversations.project(CID, created_by=second)
    assert models.ImConversation.objects.get(cid=CID).created_by_id == first.pk


def test_omitting_the_name_does_not_blank_an_existing_one():
    """装机器人那条路径不知道群名,传的是 None。如果它被当成空串,装一个机器人
    就会把群名抹掉。``None`` 是「这次不涉及名字」,``""`` 才是「清空」。"""
    im_conversations.project(CID, name="发布通知群")
    im_conversations.project(CID, organization=factories.OrganizationFactory())
    assert models.ImConversation.objects.get(cid=CID).name == "发布通知群"


def test_an_explicit_empty_name_does_clear_it():
    im_conversations.project(CID, name="发布通知群")
    im_conversations.project(CID, name="")
    assert models.ImConversation.objects.get(cid=CID).name == ""


def test_a_late_organization_fills_an_empty_one():
    """兜底写入点的意义:群可能建在本表存在之前,那一行的 organization 是空的,
    装机器人时补上。**保证每个装了机器人的群一定有组织归属。**"""
    im_conversations.project(CID, name="老群")
    organization = factories.OrganizationFactory()
    im_conversations.project(CID, organization=organization)
    assert models.ImConversation.objects.get(cid=CID).organization_id == organization.pk


def test_a_blank_cid_is_ignored_rather_than_creating_a_junk_row():
    im_conversations.project("")
    im_conversations.project("   ")
    assert not models.ImConversation.objects.exists()


def test_a_long_name_is_truncated_not_rejected():
    """群名上限 60,但投影的列是 120 —— 宽一档是为了别让一次记账因为长度炸掉。
    真炸了也只是记账失败,不该拖垮改名本身。"""
    im_conversations.project(CID, name="长" * 500)
    assert len(models.ImConversation.objects.get(cid=CID).name) == 120


def test_bookkeeping_never_breaks_the_real_work(monkeypatch):
    """建群失败要报错;建群成功但没记上账,只该在日志里出现。"""

    def _boom(*args, **kwargs):
        raise RuntimeError("db is having a moment")

    monkeypatch.setattr(
        models.ImConversation.objects, "get_or_create", _boom, raising=True
    )
    im_conversations.project(CID, name="不该抛")  # 不抛 = 通过


# ---- 迁移 0083 的回填 ----------------------------------------------------------


def test_backfill_creates_one_row_per_conversation_with_the_owning_org():
    """迁移里的回填在**空表上永远是绿的** —— 一个写错的关联路径
    (``bot__organization_id`` 之类)要有数据才暴露,而生产上刚好有数据。

    直接调那个函数而不是跑迁移:要验的是那条查询,不是 Django 的迁移机制。
    """
    from django.apps import apps as global_apps  # noqa: PLC0415
    from importlib import import_module  # noqa: PLC0415

    migration = import_module("core.migrations.0083_im_conversation")
    organization = factories.OrganizationFactory()
    creator = factories.UserFactory()
    bot = models.ImBot.objects.create(
        kind="custom", name="构建通知", organization=organization
    )
    for cid in (CID, "33333333-3333-4333-8333-333333333333"):
        models.ImBotInstallation.objects.create(
            bot=bot, cid=cid, webhook_token=None, created_by=creator
        )
    models.ImConversation.objects.all().delete()

    migration.backfill_from_installations(global_apps, None)

    rows = {r.cid: r for r in models.ImConversation.objects.all()}
    assert set(rows) == {CID, "33333333-3333-4333-8333-333333333333"}
    assert rows[CID].organization_id == organization.pk
    assert rows[CID].created_by_id == creator.pk
    # jusi 没有 admin 读接口,回填时无从得知群名 —— 前端对空名显示「未命名群聊」
    # 加可复制的 cid 前 12 位,运营拿这串能去 IM 侧对上。
    assert rows[CID].name == ""


def test_backfill_is_idempotent_and_never_touches_an_existing_row():
    from django.apps import apps as global_apps  # noqa: PLC0415
    from importlib import import_module  # noqa: PLC0415

    migration = import_module("core.migrations.0083_im_conversation")
    mine = factories.OrganizationFactory()
    theirs = factories.OrganizationFactory()
    bot = models.ImBot.objects.create(kind="custom", name="b", organization=theirs)
    models.ImBotInstallation.objects.create(bot=bot, cid=CID, webhook_token=None)
    im_conversations.project(CID, name="已经记过了", organization=mine)

    migration.backfill_from_installations(global_apps, None)

    row = models.ImConversation.objects.get(cid=CID)
    assert row.name == "已经记过了"
    assert row.organization_id == mine.pk
    assert models.ImConversation.objects.count() == 1
