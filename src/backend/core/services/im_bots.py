"""Group bots — identity minting, group membership, and posting as a bot.

The one place that knows how a bot becomes able to speak in a conversation.
Three things have to be true, and getting any of them wrong fails *silently*:

1. The bot must exist in jusi (``users`` row), so ``members.uid`` FKs resolve.
   Minted lazily via ``issue_token`` under a ``bot:<pk>`` external id — a
   namespace no Keycloak ``sub`` can collide with.
2. The bot must be a member of the conversation. ``POST /admin/messages``
   validates an explicit ``sender_uid`` against the member set and, when it
   fails, **rewrites the sender to the all-zero SYSTEM uid and returns 200**.
   There is no error to catch, so :func:`post_as` asserts on the response.
3. It must join with jusi role='bot' (P23), or it shows up in the roster and
   the member count, and can inherit the group when the owner leaves.

Built-in assistants (会议助手 / 日程助手 / 审批助手) are seeded by migration 0080
and looked up here by slug; custom webhook bots are created through the
management API. Both speak through the same path.
"""

import logging

from django.core.cache import cache

from core import models
from core.services.jusi_im import (
    JusiImAdminClient,
    JusiImServiceError,
)

logger = logging.getLogger(__name__)

# jusi-light-im's reserved SYSTEM uid (see jusi 002_system_user.sql). Lives here
# rather than in approval.py (its original home) so calendar / summary / bot code
# can share one definition instead of three literals.
SYSTEM_UID = "00000000-0000-0000-0000-000000000000"

# Built-in assistant slugs. Seeded by migration 0080_seed_builtin_bots.
BOT_MEETING_ASSISTANT = "meeting-assistant"
BOT_CALENDAR_ASSISTANT = "calendar-assistant"
BOT_APPROVAL_ASSISTANT = "approval-assistant"

# Short TTL: the token is thrown away, we only want the uid + lazy registration.
_MINT_TTL_SECONDS = 60

# How long we trust "this bot is already in this group". Re-adding is cheap and
# idempotent, so the only cost of a miss is one extra admin call; the cache is
# invalidated eagerly whenever jusi tells us the membership did not hold.
_MEMBER_CACHE_SECONDS = 600

#: Shared bot avatar palette. Web (`botAvatar.ts`) and Android
#: (`BotAvatarPalette`) carry the same eight values in the same order.
#: ⚠️ The **index** is what is stored, so reordering this list silently
#: recolours every bot that already exists. Changing a colour means changing it
#: in all three places.
BOT_AVATAR_PALETTE = (
    "#3370FF",
    "#0891B2",
    "#16A34A",
    "#65A30D",
    "#D97706",
    "#EA580C",
    "#7C3AED",
    "#DB2777",
)


def external_id_for(bot) -> str:
    """jusi ``users.external_id`` for a bot. Never collides with a person's sub."""
    return f"bot:{bot.pk}"


def palette_color(index) -> str:
    """Hex for a palette index, clamped — an out-of-range index is not an error."""
    try:
        idx = int(index)
    except (TypeError, ValueError):
        idx = 0
    return BOT_AVATAR_PALETTE[idx % len(BOT_AVATAR_PALETTE)]


def make_admin_client() -> JusiImAdminClient | None:
    """Build an admin client from settings, or None when IM is unconfigured."""
    from django.conf import settings

    cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
    if not cfg:
        logger.error("im_bots: JUSI_IM_CONFIGURATION not configured")
        return None
    return JusiImAdminClient(
        api_url=str(cfg["api_url"]),
        admin_hmac_secret=str(cfg["admin_hmac_secret"]),
        timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
    )


def resolve_bot_uid(client, bot) -> str:
    """Return the bot's jusi uid, minting and backfilling it on first use.

    Not done in the seed migration on purpose: that runs in the helm pre-upgrade
    job, where jusi may not be reachable — and a migration that needs the network
    is a migration that fails a deploy.
    """
    if bot.im_uid:
        return bot.im_uid
    resolved = client.issue_token(
        external_id=external_id_for(bot), ttl_seconds=_MINT_TTL_SECONDS
    )
    bot.im_uid = resolved.uid
    # update_fields + no full_clean: this is a cache backfill, not a user edit,
    # and racing writers would both land the same value anyway.
    models.ImBot.objects.filter(pk=bot.pk).update(im_uid=resolved.uid)
    return resolved.uid


def _member_cache_key(cid: str, uid: str) -> str:
    return f"im_bot_member:{cid}:{uid}"


def ensure_member(client, cid: str, bot_uid: str, *, force: bool = False) -> None:
    """Make sure the bot is in the conversation with role='bot'.

    Cached because it runs on every webhook delivery. ``force`` skips the cache,
    which is what :func:`post_as` does after catching a silent downgrade.
    """
    key = _member_cache_key(cid, bot_uid)
    if not force and cache.get(key):
        return
    client.add_bots(cid, [bot_uid])
    cache.set(key, True, _MEMBER_CACHE_SECONDS)


def forget_membership(cid: str, bot_uid: str) -> None:
    """Drop the cached "already a member" bit so the next post re-adds."""
    cache.delete(_member_cache_key(cid, bot_uid))


def post_as(client, bot, cid: str, body: str, *, content_type: str = "text"):
    """Post ``body`` into ``cid`` as ``bot``. Returns the jusi message response.

    Raises the usual ``JusiImServiceError`` subclasses; callers that must not
    fail (built-in notifications) should use :func:`post_as_builtin`.
    """
    bot_uid = resolve_bot_uid(client, bot)
    ensure_member(client, cid, bot_uid)
    result = client.post_message(
        cid=cid, body=body, sender_uid=bot_uid, content_type=content_type
    )
    if result.sender_uid and result.sender_uid != bot_uid:
        # jusi accepted the message but rewrote the sender — the bot was not a
        # member (jusi restarted with a stale cache on our side, or the group was
        # recreated). The message is already out under the SYSTEM identity and
        # cannot be recalled; all we can do is shout and re-add for next time.
        logger.error(
            "im_bots: message downgraded to SYSTEM — bot=%s cid=%s wanted=%s got=%s",
            bot.pk,
            cid,
            bot_uid,
            result.sender_uid,
        )
        forget_membership(cid, bot_uid)
    return result


def get_builtin(slug: str):
    """Look up a seeded assistant, or None if the seed migration has not run."""
    return models.ImBot.objects.filter(
        slug=slug, kind=models.ImBotKindChoices.BUILTIN, is_active=True
    ).first()


def post_as_builtin(slug: str, cid: str, body: str, *, content_type: str = "text"):
    """Best-effort notification from a built-in assistant. Never raises.

    Returns the message response, or None when anything went wrong — IM
    unconfigured, the assistant not seeded, jusi unreachable. Callers are
    notification paths whose real job (generating the summary, moving the event)
    has already succeeded; failing them because a chat bubble did not appear
    would be the wrong trade.
    """
    bot = get_builtin(slug)
    if bot is None:
        logger.warning("im_bots: built-in bot %r not seeded; skipping post", slug)
        return None
    client = make_admin_client()
    if client is None:
        return None
    try:
        result = post_as(client, bot, cid, body, content_type=content_type)
    except JusiImServiceError:
        logger.warning(
            "im_bots: built-in %s post failed for cid=%s", slug, cid, exc_info=True
        )
        return None
    _touch_installation(bot, cid)
    return result


def _touch_installation(bot, cid: str) -> None:
    """Record that this bot is present in this conversation.

    Built-ins have no webhook token — the row exists so the group's 群机器人 list
    can show them (P23 removed bots from the jusi roster, so this is the only
    place that knows).
    """
    try:
        models.ImBotInstallation.objects.get_or_create(
            bot=bot, cid=cid, defaults={"webhook_token": None}
        )
    except Exception:  # pragma: no cover - bookkeeping must never break a post
        logger.warning(
            "im_bots: installation bookkeeping failed bot=%s cid=%s",
            bot.pk,
            cid,
            exc_info=True,
        )
