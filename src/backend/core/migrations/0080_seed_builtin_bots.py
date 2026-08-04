# Data migration — 群机器人: seed the three built-in assistant identities.
#
# These give the notifications we already send a face. Today 会议纪要 / 日程变更 /
# 审批 all arrive from jusi's all-zero SYSTEM uid, which both clients render as a
# centred grey bar with no avatar and no name — fine for "张三 退出群聊", wrong
# for "your meeting minutes are ready".
#
# Only the *identity* is seeded here. Two things are deliberately left out:
#
#   - ``im_uid``: minting one is an HTTP call to jusi, and this migration runs in
#     the helm pre-upgrade job where jusi may not be reachable yet. It is minted
#     lazily on first use and backfilled (core.services.im_bots.resolve_bot_uid).
#   - ``ImBotInstallation`` rows: a built-in bot joins a conversation the first
#     time it has something to say there, not upfront for every group that ever
#     existed.
#
# Primary keys are derived from the slug so the same bot has the same id in dev,
# staging and production — which makes the rows safe to reference in fixtures and
# makes re-running this migration a no-op.

import uuid

from django.db import migrations

BUILTIN_BOT_NAMESPACE = "we-meet:builtin-bot:"

# (slug, name, description, avatar_color_index)
BUILTIN_BOTS = [
    ("meeting-assistant", "会议助手", "会议纪要与文档通知", 0),
    ("calendar-assistant", "日程助手", "日程变更提醒", 2),
    ("approval-assistant", "审批助手", "审批流程通知", 5),
]


def builtin_bot_id(slug: str) -> uuid.UUID:
    """Deterministic pk for a built-in bot, stable across environments."""
    return uuid.uuid5(uuid.NAMESPACE_OID, f"{BUILTIN_BOT_NAMESPACE}{slug}")


def seed_builtin_bots(apps, schema_editor):
    """Create the three assistants. Idempotent; never overwrites a live row.

    ``organization=None`` makes them global: every organization resolves the
    same 会议助手, and a bot identity carries nothing org-private (a name, a
    description, a swatch avatar).
    """
    ImBot = apps.get_model("core", "ImBot")
    for slug, name, description, color in BUILTIN_BOTS:
        ImBot.objects.get_or_create(
            id=builtin_bot_id(slug),
            defaults={
                "kind": "builtin",
                "slug": slug,
                "name": name,
                "description": description,
                "avatar_color_index": color,
                "organization": None,
                "is_active": True,
            },
        )


def unseed_builtin_bots(apps, schema_editor):
    """Reverse: drop the seeded identities and their installations.

    Safe to cascade — an installation of a built-in bot holds no user
    configuration worth preserving (no webhook token, no security settings);
    it is just "this assistant has spoken in this group".
    """
    ImBot = apps.get_model("core", "ImBot")
    ImBot.objects.filter(id__in=[builtin_bot_id(slug) for slug, *_ in BUILTIN_BOTS]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0079_im_bot"),
    ]

    operations = [
        migrations.RunPython(seed_builtin_bots, reverse_code=unseed_builtin_bots),
    ]
