"""Bot identity minting, group membership and posting as a bot."""

# pylint: disable=redefined-outer-name,unused-argument

import logging
from unittest import mock

import pytest
from django.core.cache import cache

from core import models
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
    assistant = im_bots.get_builtin(im_bots.BOT_MEETING_ASSISTANT)
    assert assistant is not None
    assert assistant.name == "会议助手"


def test_the_seed_pks_are_deterministic():
    """Same bot, same id in dev, staging and production — which is what makes
    re-running the seed migration a no-op."""
    import uuid  # pylint: disable=import-outside-toplevel

    assistant = im_bots.get_builtin(im_bots.BOT_MEETING_ASSISTANT)
    expected = uuid.uuid5(
        uuid.NAMESPACE_OID, "we-meet:builtin-bot:meeting-assistant"
    )
    assert assistant.pk == expected


def test_posting_as_a_builtin_records_the_installation():
    with mock.patch("core.services.im_bots.make_admin_client") as factory, mock.patch(
        "core.services.im_bots.post_as"
    ) as post_as:
        factory.return_value = mock.Mock()
        post_as.return_value = JusiImMessageResponse(
            mid=1, cid=CID, sender_uid=BOT_UID, seq=1, ts=0
        )
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
