"""Bot identity minting, group membership and posting as a bot."""

# pylint: disable=redefined-outer-name,unused-argument

import logging
import uuid
from unittest import mock

from django.core.cache import cache

import pytest

from core import models
from core.factories import UserFactory
from core.services import im_bots
from core.services.jusi_im import (
    JusiImAddMembersResponse,
    JusiImMessageResponse,
    JusiImTokenResponse,
    JusiImUnreachableError,
)

pytestmark = pytest.mark.django_db

CID = "11111111-1111-4111-8111-111111111111"
BOT_UID = "01900000-0000-7000-8000-0000000000b0"


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def bot():
    return models.ImBot.objects.create(
        kind=models.ImBotKindChoices.CUSTOM, name="构建通知"
    )


@pytest.fixture
def client():
    stub = mock.Mock()
    stub.issue_token.return_value = JusiImTokenResponse(
        uid=BOT_UID, token="tok", expires_at=1781700000
    )
    stub.add_bots.return_value = JusiImAddMembersResponse(
        cid=CID, added=1, removed=0, members=[BOT_UID]
    )
    stub.post_message.return_value = JusiImMessageResponse(
        mid=1, cid=CID, sender_uid=BOT_UID, seq=1, ts=1781700000
    )
    return stub


# ---- uid minting -------------------------------------------------------------


def test_uid_is_minted_lazily_and_backfilled(bot, client):
    assert im_bots.resolve_bot_uid(client, bot) == BOT_UID
    bot.refresh_from_db()
    assert bot.im_uid == BOT_UID


def test_a_cached_uid_costs_no_round_trip(bot, client):
    models.ImBot.objects.filter(pk=bot.pk).update(im_uid=BOT_UID)
    bot.refresh_from_db()
    assert im_bots.resolve_bot_uid(client, bot) == BOT_UID
    client.issue_token.assert_not_called()


def test_builtin_avatar_is_rendered_lazily_and_backfilled(client):
    assistant = im_bots.get_builtin(im_bots.BOT_TASK_ASSISTANT)
    assert assistant.avatar_key == ""
    expected_key = "bot/builtin/task-assistant-v2.png"

    with mock.patch(
        "core.services.im_bots.utils.render_bot_avatar_swatch",
        return_value=expected_key,
    ) as render:
        assert im_bots.resolve_bot_uid(client, assistant) == BOT_UID

    assistant.refresh_from_db()
    assert assistant.avatar_key == expected_key
    render.assert_called_once_with(
        color="#7C3AED",
        label="任务助手",
        glyph="task",
        object_key=expected_key,
    )


def test_an_old_builtin_avatar_is_replaced_without_a_migration(client):
    assistant = im_bots.get_builtin(im_bots.BOT_MEETING_ASSISTANT)
    assistant.avatar_key = "bot/old-generic-swatch.png"
    assistant.save(update_fields=["avatar_key"])
    expected_key = "bot/builtin/meeting-assistant-v2.png"

    with mock.patch(
        "core.services.im_bots.utils.render_bot_avatar_swatch",
        return_value=expected_key,
    ):
        assert im_bots.ensure_builtin_avatar(assistant) == expected_key

    assistant.refresh_from_db()
    assert assistant.avatar_key == expected_key


def test_builtin_avatar_failure_does_not_block_cached_uid(client):
    assistant = im_bots.get_builtin(im_bots.BOT_TASK_ASSISTANT)
    models.ImBot.objects.filter(pk=assistant.pk).update(im_uid=BOT_UID)
    assistant.refresh_from_db()

    with mock.patch(
        "core.services.im_bots.utils.render_bot_avatar_swatch", return_value=""
    ):
        assert im_bots.resolve_bot_uid(client, assistant) == BOT_UID


def test_the_external_id_can_never_collide_with_a_person(bot):
    """Keycloak subs are UUIDs; ``bot:<pk>`` is not one."""
    assert im_bots.external_id_for(bot) == f"bot:{bot.pk}"


def test_an_unusable_uid_degrades_instead_of_raising(bot, client, caplog):
    """The column is 36 chars. A malformed jusi answer must not surface as a
    DataError in the middle of somebody's approval flow."""
    client.issue_token.return_value = JusiImTokenResponse(
        uid="x" * 200, token="tok", expires_at=0
    )
    with caplog.at_level(logging.WARNING):
        assert im_bots.resolve_bot_uid(client, bot) == ""
    bot.refresh_from_db()
    assert bot.im_uid is None


# ---- membership --------------------------------------------------------------


def test_joining_uses_the_bot_role(bot, client):
    """role='bot' keeps it out of the roster and the member count (jusi P23)."""
    im_bots.ensure_member(client, CID, BOT_UID)
    client.add_bots.assert_called_once_with(CID, [BOT_UID])


def test_membership_is_cached_across_deliveries(bot, client):
    im_bots.ensure_member(client, CID, BOT_UID)
    im_bots.ensure_member(client, CID, BOT_UID)
    assert client.add_bots.call_count == 1


def test_force_skips_the_cache(bot, client):
    im_bots.ensure_member(client, CID, BOT_UID)
    im_bots.ensure_member(client, CID, BOT_UID, force=True)
    assert client.add_bots.call_count == 2


# ---- posting -----------------------------------------------------------------


def test_posting_sends_as_the_bot(bot, client):
    im_bots.post_as(client, bot, CID, "hello")
    assert client.post_message.call_args[1]["sender_uid"] == BOT_UID


def test_posting_records_the_installation_by_default(bot, client):
    """记账长在 ``post_as`` 里,不在各个通知路径上。

    以前它只长在 ``post_as_builtin`` 里,而审批助手和会议助手都是直接调
    ``post_as`` —— 于是它们发了几个月消息、一条安装记录都没有,C 端的群机器人
    列表和 M 端治理页里从来不存在。生产上 ``kind='builtin'`` 的安装数是 **0**,
    就是这么来的。
    """
    im_bots.post_as(client, bot, CID, "hello")
    assert models.ImBotInstallation.objects.filter(bot=bot, cid=CID).exists()


def test_posting_twice_does_not_duplicate_the_installation(bot, client):
    im_bots.post_as(client, bot, CID, "one")
    im_bots.post_as(client, bot, CID, "two")
    assert models.ImBotInstallation.objects.filter(bot=bot, cid=CID).count() == 1


def test_a_private_message_is_not_recorded(bot, client):
    """口径 A:治理页叫「群机器人」,一对一私信不进运营视野。

    这是全仓唯一传 ``record_installation=False`` 的调用(审批助手的私信通知),
    理由是(助手 × 每个人)的笛卡尔积会把几十个真正要治理的自定义机器人冲没。
    """
    im_bots.post_as(client, bot, CID, "你的申请已通过", record_installation=False)
    assert not models.ImBotInstallation.objects.filter(cid=CID).exists()


def test_direct_message_creates_bot_user_conversation_without_group_installation(
    bot, client
):
    user_uid = "01900000-0000-7000-8000-0000000000a1"
    models.ImBot.objects.filter(pk=bot.pk).update(im_uid=BOT_UID)
    bot.refresh_from_db()
    user = UserFactory(im_uid=user_uid)
    client.post_message.return_value = JusiImMessageResponse(
        mid=1, cid="direct", sender_uid=BOT_UID, seq=1, ts=1781700000
    )

    cid, result = im_bots.post_direct(client, bot, user, "会议纪要")

    lo, hi = sorted([BOT_UID, user_uid])
    assert cid == str(uuid.uuid5(uuid.NAMESPACE_OID, f"direct:{lo}:{hi}"))
    client.create_direct.assert_called_once_with(
        cid=cid, owner_uid=BOT_UID, peer_uid=user_uid
    )
    client.post_message.assert_called_once_with(
        cid=cid,
        body="会议纪要",
        sender_uid=BOT_UID,
        content_type="text",
        require_sender_membership=True,
    )
    client.add_bots.assert_not_called()
    assert result.sender_uid == BOT_UID
    assert not models.ImBotInstallation.objects.filter(cid=cid).exists()


def test_bookkeeping_never_breaks_a_post(bot, client, caplog):
    """记账挂了只该在日志里出现 —— 消息已经发出去了,不能因此抛。"""
    with mock.patch(
        "core.services.im_bots.models.ImBotInstallation.objects.get_or_create",
        side_effect=RuntimeError("db is having a day"),
    ), caplog.at_level(logging.WARNING):
        result = im_bots.post_as(client, bot, CID, "hello")
    assert result.mid == 1
    assert "installation bookkeeping failed" in caplog.text


def test_a_silent_downgrade_to_system_is_detected_and_logged(bot, client, caplog):
    """jusi rewrites a non-member sender to the all-zero uid and still returns
    200 — there is no exception to catch, so we compare what came back."""
    client.post_message.return_value = JusiImMessageResponse(
        mid=1, cid=CID, sender_uid=im_bots.SYSTEM_UID, seq=1, ts=0
    )
    im_bots.ensure_member(client, CID, BOT_UID)  # warm the cache
    with caplog.at_level(logging.ERROR):
        im_bots.post_as(client, bot, CID, "hello")
    assert "downgraded to SYSTEM" in caplog.text
    # …and the cached membership is dropped so the next post re-joins.
    im_bots.ensure_member(client, CID, BOT_UID)
    assert client.add_bots.call_count == 2


# ---- built-in assistants -----------------------------------------------------


def test_builtins_are_seeded_and_lookup_by_slug_works():
    expected = {
        im_bots.BOT_MEETING_ASSISTANT: ("会议助手", "会议纪要与文档通知", 0),
        im_bots.BOT_CALENDAR_ASSISTANT: ("日程助手", "日程变更提醒", 2),
        im_bots.BOT_APPROVAL_ASSISTANT: ("审批助手", "审批流程通知", 5),
        im_bots.BOT_TASK_ASSISTANT: ("任务助手", "任务分派与进度通知", 6),
    }

    for slug, (name, description, color) in expected.items():
        assistant = im_bots.get_builtin(slug)
        assert assistant is not None
        assert (
            assistant.name,
            assistant.description,
            assistant.avatar_color_index,
        ) == (
            name,
            description,
            color,
        )


def test_the_seed_pks_are_deterministic():
    """Same bot, same id in dev, staging and production — which is what makes
    re-running the seed migration a no-op."""
    assistant = im_bots.get_builtin(im_bots.BOT_MEETING_ASSISTANT)
    expected = uuid.uuid5(
        uuid.NAMESPACE_OID, "we-meet:builtin-bot:meeting-assistant"
    )
    assert assistant.pk == expected

    task_assistant = im_bots.get_builtin(im_bots.BOT_TASK_ASSISTANT)
    expected_task = uuid.uuid5(uuid.NAMESPACE_OID, "we-meet:builtin-bot:task-assistant")
    assert task_assistant.pk == expected_task


def test_posting_as_a_builtin_records_the_installation(client):
    """**刻意不 mock ``post_as``。**

    以前这条 mock 掉了它 —— 而记账正是在 ``post_as`` 里,于是这个测试证明的
    只是「``post_as_builtin`` 自己那一行记账还在」,照不出「走 ``post_as`` 的
    另外两个助手一条都不记」。这跟 SNI 那次是同一个形状:mock 掉了唯一要紧的
    那一层,测试全绿而生产上是坏的。
    """
    with mock.patch("core.services.im_bots.make_admin_client") as factory:
        factory.return_value = client
        im_bots.post_as_builtin(im_bots.BOT_MEETING_ASSISTANT, CID, "纪要已生成")

    install = models.ImBotInstallation.objects.get(cid=CID)
    assert install.bot.slug == im_bots.BOT_MEETING_ASSISTANT
    assert install.webhook_token is None, "a built-in has nothing to POST to"


def test_a_builtin_post_never_raises():
    """The caller's real work (generating the summary) already succeeded;
    failing it because a bubble did not appear would be the wrong trade."""
    with mock.patch("core.services.im_bots.make_admin_client") as factory, mock.patch(
        "core.services.im_bots.post_as", side_effect=JusiImUnreachableError("down")
    ):
        factory.return_value = mock.Mock()
        assert im_bots.post_as_builtin(im_bots.BOT_MEETING_ASSISTANT, CID, "x") is None


def test_an_unseeded_builtin_is_skipped_not_crashed():
    assert im_bots.post_as_builtin("no-such-assistant", CID, "x") is None


def test_only_the_private_message_path_opts_out_of_bookkeeping():
    """``record_installation=False`` 全仓只该有一处。

    默认开就是为了「忘了记」这件事不再发生,但这道保护只在**没人顺手关掉它**
    时成立。关掉是一个产品决定(这条会话不进治理页),不该是某次调试的残留 ——
    所以多出一处就红,让它必须经过 review。
    """
    import pathlib  # noqa: PLC0415

    root = pathlib.Path(__file__).resolve().parents[2]
    hits = [
        path.relative_to(root).as_posix()
        for path in root.rglob("*.py")
        if "tests" not in path.parts
        and "record_installation=False" in path.read_text(encoding="utf-8")
    ]
    assert hits == ["services/approval.py"], hits


# ---- palette -----------------------------------------------------------------


def test_the_palette_has_eight_colours():
    """Web (`botAvatar.ts`) and Android (`BotAvatarPalette`) carry the same
    eight in the same order — the stored value is the *index*."""
    assert len(im_bots.BOT_AVATAR_PALETTE) == 8


def test_an_out_of_range_palette_index_wraps_rather_than_raising():
    assert im_bots.palette_color(99) in im_bots.BOT_AVATAR_PALETTE
    assert im_bots.palette_color(None) == im_bots.BOT_AVATAR_PALETTE[0]
    assert im_bots.palette_color("nonsense") == im_bots.BOT_AVATAR_PALETTE[0]


# ---- avatar swatch -----------------------------------------------------------


def test_the_swatch_is_drawn_without_a_font():
    """飞书-style robot mark, not the bot's initial.

    Pillow's bundled font has no CJK glyphs: 「测试机器人」 and 「构建通知」
    rendered byte-identical notdef boxes. Two differently-named bots must not
    produce the same picture, and neither may look like a broken glyph.
    """
    from PIL import Image, ImageDraw  # pylint: disable=import-outside-toplevel

    from core import utils  # pylint: disable=import-outside-toplevel

    drawn = []
    for color in ("#3370FF", "#DB2777"):
        image = Image.new("RGB", (64, 64), color)
        utils._draw_bot_glyph(ImageDraw.Draw(image), 64, color)  # noqa: SLF001
        drawn.append(image.tobytes())
        # The mark is white on the swatch colour, so both must be present.
        colors = {c for _, c in image.getcolors(maxcolors=1 << 16)}
        assert (255, 255, 255) in colors, "the robot mark did not render"

    assert drawn[0] != drawn[1], "different palette colours produced the same image"


def test_builtin_assistant_glyphs_are_visually_distinct():
    """Each built-in should communicate its job, not just wear another colour."""
    from PIL import Image, ImageDraw  # pylint: disable=import-outside-toplevel

    from core import utils  # pylint: disable=import-outside-toplevel

    rendered = set()
    for glyph in ("meeting", "calendar", "approval", "task"):
        image = Image.new("RGB", (64, 64), "#3370FF")
        utils._draw_bot_glyph(  # noqa: SLF001
            ImageDraw.Draw(image), 64, "#3370FF", glyph
        )
        colors = {color for _, color in image.getcolors(maxcolors=1 << 16)}
        assert (255, 255, 255) in colors, f"{glyph} mark did not render"
        rendered.add(image.tobytes())

    assert len(rendered) == 4


def test_the_s3_client_disables_request_checksums():
    """boto3 ≥1.36 adds a CRC32 header to every PUT; Aliyun OSS rejects it.

    Every other caller only *signs* a URL for the client to PUT, so boto3 never
    touches OSS and this never showed up — until the bot avatar became the first
    real ``put_object`` and silently wrote nothing.
    """
    from core import utils  # pylint: disable=import-outside-toplevel

    client = utils._profile_s3_client()  # noqa: SLF001
    assert client.meta.config.request_checksum_calculation == "when_required"
    assert client.meta.config.response_checksum_validation == "when_required"
