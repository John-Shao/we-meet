"""Public webhook endpoint for group bots — 飞书-compatible.

    POST /api/bot/v1/hook/<token>
    {"msg_type": "text", "content": {"text": "构建失败"}}

The token in the path *is* the credential; there is no DRF authentication. The
optional gates an owner can turn on (signature / keywords / IP allowlist) mirror
飞书's three, down to the algorithm and the error codes, so a script already
posting to 飞书 works by changing one URL.

Delivery is synchronous. A webhook's whole value is that the caller learns
whether the message landed; queueing it would replace a real answer with an
unconditional 200 and leave a CI job reporting success for a message nobody got.
"""

import hashlib
import json
import logging

from django.conf import settings
from django.core.cache import cache
from django.db.models import F
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models
from core.api.throttling import (
    BotWebhookBurstThrottle,
    BotWebhookIPThrottle,
    BotWebhookTokenThrottle,
)
from core.services import bot_webhook as mapping
from core.services import im_bots
from core.services.jusi_im import (
    JusiImBadResponseError,
    JusiImServiceError,
    JusiImUnreachableError,
)

logger = logging.getLogger(__name__)

#: Successful responses are replayed for this long when the same request is
#: retried with an explicit ``X-Request-Id``.
_IDEMPOTENCY_SECONDS = 24 * 3600


def bot_response(code: int, message: str, http_status: int = 200, data=None):
    """飞书-shaped envelope. Kept even for failures — SDKs read ``code``."""
    return Response(
        {"code": code, "msg": message, "data": data or {}}, status=http_status
    )


def client_ip(request) -> str:
    """Best-effort client IP for the allowlist gate.

    ⚠️ Correctness here depends on the reverse-proxy chain in front of us: the
    left-most ``X-Forwarded-For`` entry is client-controlled and only trustworthy
    if every hop rewrites it. When the value cannot be parsed the allowlist check
    fails closed rather than passing everything (see
    ``bot_webhook.check_ip_allowed``) — an allowlist that quietly stops applying
    is worse than one that rejects.
    """
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR") or ""
    if forwarded:
        return forwarded.split(",")[0].strip()
    return (request.META.get("REMOTE_ADDR") or "").strip()


class BotWebhookView(APIView):
    """Receive an external message and post it into the bot's conversation."""

    authentication_classes: list = []
    permission_classes: list = []
    throttle_classes = [
        BotWebhookIPThrottle,
        BotWebhookTokenThrottle,
        BotWebhookBurstThrottle,
    ]

    def throttled(self, request, wait):
        """Answer 429 in the 飞书 envelope instead of DRF's ``{"detail": …}``.

        Senders parse ``code``; handing them a different shape only when they
        are being rate-limited is exactly when a client is least able to cope.
        """
        raise BotThrottled()

    def handle_exception(self, exc):
        if isinstance(exc, BotThrottled):
            return bot_response(
                mapping.CODE_RATE_LIMITED,
                "too many request",
                status.HTTP_429_TOO_MANY_REQUESTS,
            )
        return super().handle_exception(exc)

    def post(self, request, token=None):
        raw = request.body or b""
        if len(raw) > mapping.MAX_BODY_BYTES:
            return bot_response(
                mapping.CODE_BODY_TOO_LARGE,
                "request body too large",
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )

        install = (
            models.ImBotInstallation.objects.select_related("bot")
            .filter(webhook_token=token)
            .first()
            if token
            else None
        )
        if install is None:
            return bot_response(
                mapping.CODE_BAD_TOKEN, mapping.MSG_BAD_TOKEN, status.HTTP_400_BAD_REQUEST
            )
        if not install.is_active or not install.bot.is_active:
            return bot_response(mapping.CODE_BOT_DISABLED, "bot is disabled")

        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return bot_response(
                mapping.CODE_BAD_BODY, "invalid request body", status.HTTP_400_BAD_REQUEST
            )

        gate = self._check_gates(install, payload, request)
        if gate is not None:
            return gate

        cached = self._replay(install, request, raw)
        if cached is not None:
            return Response(cached, status=status.HTTP_200_OK)

        try:
            message = mapping.build_message(payload)
        except mapping.BotPayloadError as exc:
            return bot_response(exc.code, exc.message, exc.http_status)

        # Keywords gate the *rendered* text, so a keyword can match words the
        # sender can actually see rather than JSON we happened to generate.
        if not mapping.check_keywords(message.plain, install.keywords):
            return bot_response(mapping.CODE_NO_KEYWORD, mapping.MSG_NO_KEYWORD)

        return self._deliver(install, message, request, raw)

    # ---- gates ----

    def _check_gates(self, install, payload, request):
        if install.sign_verify_enabled and not mapping.check_signature(
            payload if isinstance(payload, dict) else {}, install.signing_secret
        ):
            return bot_response(mapping.CODE_BAD_SIGN, mapping.MSG_BAD_SIGN)
        if not mapping.check_ip_allowed(client_ip(request), install.ip_allowlist):
            return bot_response(mapping.CODE_IP_NOT_ALLOWED, "ip not in whitelist")
        return None

    # ---- idempotency ----

    @staticmethod
    def _dedupe_key(install, request, raw: bytes) -> tuple[str, int] | None:
        """(cache key, ttl) for this request, or None when dedupe is off.

        An explicit ``X-Request-Id`` is honoured for a day — the sender is
        telling us two calls are the same call. Without one we fall back to
        hashing the body over a **very short** window, because "the same text
        twice" is normal traffic for a monitoring bot and only a retry arrives
        within seconds.
        """
        request_id = (request.headers.get("X-Request-Id") or "").strip()[:128]
        if request_id:
            return f"bot:idem:{install.pk}:{request_id}", _IDEMPOTENCY_SECONDS
        cfg = getattr(settings, "BOT_CONFIGURATION", None) or {}
        window = int(cfg.get("dedupe_seconds") or 0)
        if window <= 0:
            return None
        digest = hashlib.sha256(raw).hexdigest()
        return f"bot:idem:{install.pk}:h:{digest}", window

    def _replay(self, install, request, raw: bytes):
        entry = self._dedupe_key(install, request, raw)
        if entry is None:
            return None
        return cache.get(entry[0])

    def _remember(self, install, request, raw: bytes, body: dict) -> None:
        entry = self._dedupe_key(install, request, raw)
        if entry is not None:
            cache.set(entry[0], body, entry[1])

    # ---- delivery ----

    def _deliver(self, install, message, request, raw: bytes):
        client = im_bots.make_admin_client()
        if client is None:
            return bot_response(
                mapping.CODE_IM_UNAVAILABLE,
                "im service unavailable",
                status.HTTP_502_BAD_GATEWAY,
            )
        try:
            result = im_bots.post_as(
                client,
                install.bot,
                install.cid,
                message.body,
                content_type=message.content_type,
            )
        except JusiImBadResponseError:
            # 4xx from jusi on a known-good payload means the conversation is
            # gone (dissolved, or the bot was removed). Disable the installation
            # so we stop hammering, and say so — this is self-healing, no cron.
            logger.warning(
                "bot webhook: conversation gone, disabling install=%s cid=%s",
                install.pk,
                install.cid,
                exc_info=True,
            )
            models.ImBotInstallation.objects.filter(pk=install.pk).update(
                is_active=False, disabled_reason="conversation_gone"
            )
            return bot_response(
                mapping.CODE_CONVERSATION_GONE,
                "conversation not found",
                status.HTTP_404_NOT_FOUND,
            )
        except (JusiImUnreachableError, JusiImServiceError):
            logger.warning(
                "bot webhook: im unavailable install=%s", install.pk, exc_info=True
            )
            return bot_response(
                mapping.CODE_IM_UNAVAILABLE,
                "im service unavailable",
                status.HTTP_502_BAD_GATEWAY,
            )

        models.ImBotInstallation.objects.filter(pk=install.pk).update(
            last_used_at=timezone.now(), message_count=F("message_count") + 1
        )
        body = {
            "code": mapping.CODE_OK,
            "msg": "success",
            "data": {"mid": result.mid, "seq": result.seq},
        }
        self._remember(install, request, raw, body)
        return Response(body, status=status.HTTP_200_OK)


class BotThrottled(Exception):
    """Internal marker so ``throttled()`` can produce a 飞书-shaped 429."""
