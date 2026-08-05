"""Group bot management — ``/api/v1.0/im/bots/`` (对标飞书「群机器人」).

A REST resource rather than another batch of ``@action(detail=False)`` endpoints
on :class:`~core.api.im.ImViewSet`: bots are things with identities that get
listed, edited and deleted, and both clients want ordinary CRUD.

**Permissions.** Creating, editing, deleting and reading credentials is
owner-only. A webhook URL is a live write credential for the group, so "any
member may quietly open one" is not a defensible default; it also matches the
bar already set for renaming a group or removing a member, and 飞书's own
default. Listing is open to every member — everyone should be able to see what
is posting in their group — but the credential fields come back null unless the
caller is the owner.
"""

from __future__ import annotations

import ipaddress
import logging
import secrets

from django.conf import settings
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from core import models, utils
from core.api.directory import get_caller_organization
from core.api.im import (
    ImViewSet,
    JusiImInvalidResponseHTTPError,
    JusiImUnreachableHTTPError,
)
from core.services import im_bots
from core.services import outbound_http
from core.services.audit import record_audit
from core.services.jusi_im import (
    JusiImBadResponseError,
    JusiImServiceError,
    JusiImUnreachableError,
)

logger = logging.getLogger(__name__)

MAX_NAME_LENGTH = 32
MAX_DESCRIPTION_LENGTH = 256
MAX_KEYWORDS = 10
MAX_KEYWORD_LENGTH = 32
MAX_IP_ENTRIES = 10


def _bot_config() -> dict:
    return getattr(settings, "BOT_CONFIGURATION", None) or {}


def webhook_url_for(install) -> str:
    """Absolute URL a third party POSTs to. Empty for built-ins (no token).

    Falls back to ``EMAIL_APP_BASE_URL`` — the other setting that already means
    "our public origin" — so the URL is usable before anyone sets
    ``BOT_WEBHOOK_BASE_URL``. A relative URL would be worse than a wrong one:
    it is going into somebody's CI config, where it has to be absolute.
    """
    if not install.webhook_token:
        return ""
    base = str(_bot_config().get("webhook_base_url") or "").rstrip("/")
    if not base:
        base = str(getattr(settings, "EMAIL_APP_BASE_URL", "") or "").rstrip("/")
    return f"{base}/api/bot/v1/hook/{install.webhook_token}"


class ImBotViewSet(viewsets.ViewSet):
    """CRUD for the bots installed in one conversation."""

    permission_classes = [permissions.IsAuthenticated]

    # ---- helpers ----

    def _client(self):
        return ImViewSet()._make_client()  # pylint: disable=protected-access

    def _me(self, client):
        """Short-lived IM token for the caller — how membership is proven."""
        return ImViewSet._issue(  # pylint: disable=protected-access
            client, ImViewSet._external_id(self.request.user)  # noqa: SLF001
        )

    def _require_membership(self, cid: str, *, owner_only: bool):
        """Ask jusi whether the caller belongs here; jusi is the roster's truth."""
        client = self._client()
        me = self._me(client)
        # pylint: disable=protected-access
        ImViewSet._require_role(ImViewSet(), client, cid, me, owner_only=owner_only)
        return client

    def _install_or_404(self, pk):
        install = (
            models.ImBotInstallation.objects.select_related("bot")
            .filter(pk=pk)
            .first()
        )
        if install is None:
            raise NotFound("bot not found")
        return install

    def _serialize(self, install, *, is_owner: bool) -> dict:
        bot = install.bot
        data = {
            "id": str(install.pk),
            "cid": install.cid,
            "kind": bot.kind,
            "slug": bot.slug,
            "uid": bot.im_uid or "",
            "name": bot.name,
            "description": bot.description,
            "avatar_url": utils.generate_profile_image_get_url("avatar", bot.avatar_key),
            "avatar_color_index": bot.avatar_color_index,
            "is_active": install.is_active and bot.is_active,
            "disabled_reason": install.disabled_reason,
            "created_at": install.created_at.isoformat(),
            "last_used_at": (
                install.last_used_at.isoformat() if install.last_used_at else None
            ),
            "message_count": install.message_count,
        }
        # Credentials and gates are configuration, not public information: a
        # member can see that a bot exists, not how to post as it.
        if is_owner:
            data.update(
                {
                    "webhook_url": webhook_url_for(install),
                    "sign_verify_enabled": install.sign_verify_enabled,
                    "keywords": list(install.keywords or []),
                    "ip_allowlist": list(install.ip_allowlist or []),
                    # 出站回调(A3)。**callback_secret 不回** —— 与
                    # signing_secret 同档,要看得走单独的凭据接口。
                    "callback_url": install.callback_url,
                    "callback_include_identity": install.callback_include_identity,
                    "callback_enabled": install.callback_enabled,
                    "callback_failure_count": install.callback_failure_count,
                }
            )
        else:
            data.update(
                {
                    "webhook_url": None,
                    "sign_verify_enabled": None,
                    "keywords": None,
                    "ip_allowlist": None,
                    "callback_url": None,
                    "callback_include_identity": None,
                    "callback_enabled": None,
                    "callback_failure_count": None,
                }
            )
        return data

    # ---- validation ----

    @staticmethod
    def _clean_name(raw, *, required: bool) -> str | None:
        if raw is None:
            if required:
                raise ValidationError({"name": "name is required"})
            return None
        name = str(raw).strip()
        if not name:
            raise ValidationError({"name": "name is required"})
        # UTF-16 code units, matching JS `.length` and Kotlin `.length` so a name
        # the form accepted is never rejected here.
        if len(name.encode("utf-16-le")) // 2 > MAX_NAME_LENGTH:
            raise ValidationError({"name": f"name exceeds {MAX_NAME_LENGTH} characters"})
        return name

    @staticmethod
    def _clean_description(raw) -> str | None:
        if raw is None:
            return None
        text = str(raw).strip()
        if len(text.encode("utf-16-le")) // 2 > MAX_DESCRIPTION_LENGTH:
            raise ValidationError(
                {"description": f"description exceeds {MAX_DESCRIPTION_LENGTH} characters"}
            )
        return text

    @staticmethod
    def _clean_keywords(raw) -> list | None:
        if raw is None:
            return None
        if not isinstance(raw, list):
            raise ValidationError({"keywords": "expected a list"})
        cleaned = [str(k).strip() for k in raw if str(k).strip()]
        if len(cleaned) > MAX_KEYWORDS:
            raise ValidationError({"keywords": f"at most {MAX_KEYWORDS} keywords"})
        for word in cleaned:
            if len(word) > MAX_KEYWORD_LENGTH:
                raise ValidationError(
                    {"keywords": f"each keyword must be ≤ {MAX_KEYWORD_LENGTH} characters"}
                )
        return cleaned

    @staticmethod
    def _clean_ip_allowlist(raw) -> list | None:
        if raw is None:
            return None
        if not isinstance(raw, list):
            raise ValidationError({"ip_allowlist": "expected a list"})
        cleaned = []
        for entry in raw:
            text = str(entry).strip()
            if not text:
                continue
            try:
                ipaddress.ip_network(text, strict=False)
            except ValueError as exc:
                raise ValidationError(
                    {"ip_allowlist": f"{text!r} is not an IP or CIDR"}
                ) from exc
            cleaned.append(text)
        if len(cleaned) > MAX_IP_ENTRIES:
            raise ValidationError({"ip_allowlist": f"at most {MAX_IP_ENTRIES} entries"})
        return cleaned

    @staticmethod
    def _clean_avatar_key(raw) -> str | None:
        """Only keys this API minted. Otherwise a caller could point a bot's
        avatar at somebody's profile picture by pasting their object key."""
        if raw is None:
            return None
        key = str(raw).strip()
        if not key:
            return ""
        if not key.startswith(utils.BOT_AVATAR_PREFIX):
            raise ValidationError({"avatar_key": "unexpected object key"})
        return key

    @staticmethod
    def _clean_color_index(raw) -> int | None:
        if raw is None:
            return None
        try:
            index = int(raw)
        except (TypeError, ValueError) as exc:
            raise ValidationError({"avatar_color_index": "expected an integer"}) from exc
        if not 0 <= index < len(im_bots.BOT_AVATAR_PALETTE):
            raise ValidationError({"avatar_color_index": "out of palette range"})
        return index

    # ---- read ----

    def list(self, request):
        """``GET /im/bots/?cid=<cid>`` — every bot in one conversation."""
        cid = str(request.query_params.get("cid") or "").strip()
        if not cid:
            raise ValidationError({"cid": "cid is required"})
        client = self._client()
        me = self._me(client)
        # pylint: disable=protected-access
        roster = ImViewSet._require_role(ImViewSet(), client, cid, me, owner_only=False)
        is_owner = any(
            m.get("uid") == me.uid and m.get("role") == "owner" for m in roster
        )
        installs = (
            models.ImBotInstallation.objects.select_related("bot")
            .filter(cid=cid)
            .order_by("created_at")
        )
        return Response([self._serialize(i, is_owner=is_owner) for i in installs])

    def retrieve(self, request, pk=None):
        """``GET /im/bots/{id}/`` — owner-only; the credential lives here."""
        install = self._install_or_404(pk)
        self._require_membership(install.cid, owner_only=True)
        return Response(self._serialize(install, is_owner=True))

    @action(detail=True, methods=["get"], url_path="secret")
    def secret(self, request, pk=None):
        """``GET /im/bots/{id}/secret/`` — the signing secret, audited.

        Split from the detail payload so the list view never ships N secrets to
        a browser, and so "someone looked at this credential" is a discrete
        event we can record.
        """
        install = self._install_or_404(pk)
        self._require_membership(install.cid, owner_only=True)
        record_audit(
            actor=request.user,
            organization=get_caller_organization(request.user),
            action=models.AuditActionChoices.BOT_WEBHOOK_VIEW,
            target_type="im_bot",
            target_id=install.pk,
            target_label=install.bot.name,
        )
        return Response({"secret": install.signing_secret})

    # ---- write ----

    def create(self, request):
        """``POST /im/bots/`` — create a custom webhook bot in a conversation."""
        data = request.data or {}
        cid = str(data.get("cid") or "").strip()
        if not cid:
            raise ValidationError({"cid": "cid is required"})
        client = self._require_membership(cid, owner_only=True)

        limit = int(_bot_config().get("max_bots_per_conversation") or 10)
        existing = models.ImBotInstallation.objects.filter(
            cid=cid, bot__kind=models.ImBotKindChoices.CUSTOM
        ).count()
        if existing >= limit:
            raise ValidationError(
                {"cid": f"this conversation already has {limit} custom bots"}
            )

        name = self._clean_name(data.get("name"), required=True)
        description = self._clean_description(data.get("description")) or ""
        avatar_key = self._clean_avatar_key(data.get("avatar_key")) or ""
        color_index = self._clean_color_index(data.get("avatar_color_index")) or 0

        bot = models.ImBot.objects.create(
            kind=models.ImBotKindChoices.CUSTOM,
            name=name,
            description=description,
            avatar_key=avatar_key,
            avatar_color_index=color_index,
            organization=get_caller_organization(request.user),
            created_by=request.user,
        )
        if not bot.avatar_key:
            # No upload → render the chosen swatch so every client (and the push
            # notification) has a real image to show. Best-effort by design.
            rendered = utils.render_bot_avatar_swatch(
                color=im_bots.palette_color(color_index), label=name
            )
            if rendered:
                models.ImBot.objects.filter(pk=bot.pk).update(avatar_key=rendered)
                bot.avatar_key = rendered

        install = models.ImBotInstallation.objects.create(
            bot=bot,
            cid=cid,
            webhook_token=secrets.token_urlsafe(32),
            signing_secret=secrets.token_urlsafe(24),
            sign_verify_enabled=bool(data.get("sign_verify_enabled")),
            keywords=self._clean_keywords(data.get("keywords")) or [],
            ip_allowlist=self._clean_ip_allowlist(data.get("ip_allowlist")) or [],
            created_by=request.user,
        )

        # Join now rather than on first message: the group should show the bot
        # as soon as it is added, and a failure here is worth surfacing while
        # the user is still looking at the form.
        try:
            bot_uid = im_bots.resolve_bot_uid(client, bot)
            im_bots.ensure_member(client, cid, bot_uid, force=True)
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            raise JusiImInvalidResponseHTTPError(detail=str(exc)) from exc

        self._announce(client, cid, f"{self._actor_name()} 添加了机器人「{bot.name}」")
        record_audit(
            actor=request.user,
            organization=get_caller_organization(request.user),
            action=models.AuditActionChoices.BOT_CREATE,
            target_type="im_bot",
            target_id=install.pk,
            target_label=bot.name,
        )
        return Response(
            self._serialize(install, is_owner=True), status=status.HTTP_201_CREATED
        )

    def partial_update(self, request, pk=None):
        """``PATCH /im/bots/{id}/`` — rename, re-describe, or change the gates."""
        install = self._install_or_404(pk)
        self._require_membership(install.cid, owner_only=True)
        data = request.data or {}
        bot = install.bot
        builtin = bot.kind == models.ImBotKindChoices.BUILTIN

        bot_fields = []
        if not builtin:
            # A built-in's name/description/avatar ship with the release; letting
            # one group rename 会议助手 would fork an identity shared by all of them.
            name = self._clean_name(data.get("name"), required=False)
            if name is not None:
                bot.name = name
                bot_fields.append("name")
            description = self._clean_description(data.get("description"))
            if description is not None:
                bot.description = description
                bot_fields.append("description")
            avatar_key = self._clean_avatar_key(data.get("avatar_key"))
            if avatar_key is not None:
                bot.avatar_key = avatar_key
                bot_fields.append("avatar_key")
            color_index = self._clean_color_index(data.get("avatar_color_index"))
            if color_index is not None:
                bot.avatar_color_index = color_index
                bot_fields.append("avatar_color_index")
                if avatar_key in (None, ""):
                    rendered = utils.render_bot_avatar_swatch(
                        color=im_bots.palette_color(color_index), label=bot.name
                    )
                    if rendered:
                        bot.avatar_key = rendered
                        bot_fields.append("avatar_key")
        if bot_fields:
            models.ImBot.objects.filter(pk=bot.pk).update(
                **{f: getattr(bot, f) for f in bot_fields}
            )

        install_fields = []
        if "sign_verify_enabled" in data:
            install.sign_verify_enabled = bool(data["sign_verify_enabled"])
            install_fields.append("sign_verify_enabled")
        keywords = self._clean_keywords(data.get("keywords"))
        if keywords is not None:
            install.keywords = keywords
            install_fields.append("keywords")
        allowlist = self._clean_ip_allowlist(data.get("ip_allowlist"))
        if allowlist is not None:
            install.ip_allowlist = allowlist
            install_fields.append("ip_allowlist")
        if "callback_url" in data:
            raw = str(data.get("callback_url") or "").strip()
            if raw:
                # 写入时就校验,群主当场看到报错。发送时还会再走一遍 ——
                # DNS 会变,写入时合法不代表发送时合法。
                try:
                    outbound_http.validate_url(raw)
                except outbound_http.OutboundBlocked as exc:
                    raise ValidationError(
                        {"callback_url": f"address not allowed ({exc.category})"}
                    ) from exc
                if not install.callback_secret:
                    install.callback_secret = secrets.token_urlsafe(32)[:64]
                    install_fields.append("callback_secret")
            install.callback_url = raw
            # 改地址视为「重新开始」:清零失败计数并重新启用,否则群主修好了
            # 地址却还停在自动停用状态,只能靠猜。
            install.callback_failure_count = 0
            install.callback_enabled = True
            install_fields.extend(
                ["callback_url", "callback_failure_count", "callback_enabled"]
            )
        if "callback_include_identity" in data:
            install.callback_include_identity = bool(data["callback_include_identity"])
            install_fields.append("callback_include_identity")
        if "is_active" in data:
            # The supported way to silence a built-in assistant in one group.
            install.is_active = bool(data["is_active"])
            install.disabled_reason = "" if install.is_active else "disabled_by_owner"
            install_fields.extend(["is_active", "disabled_reason"])
        if install_fields:
            models.ImBotInstallation.objects.filter(pk=install.pk).update(
                **{f: getattr(install, f) for f in install_fields}
            )

        record_audit(
            actor=request.user,
            organization=get_caller_organization(request.user),
            action=models.AuditActionChoices.BOT_UPDATE,
            target_type="im_bot",
            target_id=install.pk,
            target_label=bot.name,
        )
        install.refresh_from_db()
        return Response(self._serialize(install, is_owner=True))

    def destroy(self, request, pk=None):
        """``DELETE /im/bots/{id}/`` — remove a custom bot from the group."""
        install = self._install_or_404(pk)
        client = self._require_membership(install.cid, owner_only=True)
        bot = install.bot
        if bot.kind == models.ImBotKindChoices.BUILTIN:
            # Deleting would silently switch off a product feature with no way
            # back; PATCH is_active=false is the reversible thing users mean.
            raise ValidationError(
                {"kind": "built-in assistants cannot be removed; disable them instead"}
            )

        if bot.im_uid:
            try:
                client.remove_members(install.cid, [bot.im_uid])
            except JusiImServiceError:
                logger.warning(
                    "bot removal: jusi remove_members failed for %s", install.pk,
                    exc_info=True,
                )
            im_bots.forget_membership(install.cid, bot.im_uid)

        name, cid = bot.name, install.cid
        install.delete()
        # A custom bot's identity belongs to exactly one installation, so it goes
        # with it — leaving it behind would keep a resolvable name for a bot that
        # no longer exists anywhere.
        bot.delete()

        self._announce(client, cid, f"{self._actor_name()} 移除了机器人「{name}」")
        record_audit(
            actor=request.user,
            organization=get_caller_organization(request.user),
            action=models.AuditActionChoices.BOT_DELETE,
            target_type="im_bot",
            target_id=pk,
            target_label=name,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="reset-secret")
    def reset_secret(self, request, pk=None):
        """Rotate the signing secret. Old signatures stop verifying immediately."""
        install = self._install_or_404(pk)
        self._require_membership(install.cid, owner_only=True)
        secret = secrets.token_urlsafe(24)
        models.ImBotInstallation.objects.filter(pk=install.pk).update(
            signing_secret=secret
        )
        record_audit(
            actor=request.user,
            organization=get_caller_organization(request.user),
            action=models.AuditActionChoices.BOT_SECRET_RESET,
            target_type="im_bot",
            target_id=install.pk,
            target_label=install.bot.name,
        )
        return Response({"secret": secret})

    @action(detail=True, methods=["post"], url_path="reset-token")
    def reset_token(self, request, pk=None):
        """Rotate the webhook token — the old URL 400s from the next call on."""
        install = self._install_or_404(pk)
        self._require_membership(install.cid, owner_only=True)
        if install.bot.kind == models.ImBotKindChoices.BUILTIN:
            raise ValidationError({"kind": "built-in assistants have no webhook"})
        models.ImBotInstallation.objects.filter(pk=install.pk).update(
            webhook_token=secrets.token_urlsafe(32)
        )
        install.refresh_from_db()
        record_audit(
            actor=request.user,
            organization=get_caller_organization(request.user),
            action=models.AuditActionChoices.BOT_SECRET_RESET,
            target_type="im_bot",
            target_id=install.pk,
            target_label=install.bot.name,
        )
        return Response({"webhook_url": webhook_url_for(install)})

    @action(detail=False, methods=["post"], url_path="avatar-upload-url")
    def avatar_upload_url(self, request):
        """Presigned PUT for a bot avatar, before the bot exists."""
        data = request.data or {}
        content_type = str(data.get("content_type") or "")
        if content_type not in utils.ALLOWED_PROFILE_IMAGE_MIME_TYPES:
            raise ValidationError({"content_type": "unsupported image type"})
        try:
            size = int(data.get("size") or 0)
        except (TypeError, ValueError) as exc:
            raise ValidationError({"size": "expected an integer"}) from exc
        if size <= 0 or size > utils.MAX_PROFILE_IMAGE_SIZE:
            raise ValidationError({"size": "size out of range"})
        return Response(
            utils.generate_bot_avatar_upload_url(content_type=content_type, size=size)
        )

    # ---- misc ----

    def _actor_name(self) -> str:
        return ImViewSet._display_name(self.request.user)  # pylint: disable=protected-access

    @staticmethod
    def _announce(client, cid: str, body: str) -> None:
        """Leave a trace in the conversation when a bot joins or leaves.

        Deliberately a ``system`` message (centred grey bar), not a message from
        the bot: this is a group operation, like adding a member, not the bot
        speaking.
        """
        # pylint: disable=protected-access
        ImViewSet._post_system_message(client, cid, body)
