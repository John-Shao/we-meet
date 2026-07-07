"""P0 离线推送的两个入口 (docs/features/foundation_p0_p3.md §P0):

- ``POST/DELETE /api/v1.0/push/tokens/`` — App 端注册/注销个推 cid(用户态)。
- ``POST /api/agent/push-hook/`` — jusi-light-im p14 webhook 的接收端(内部,
  HMAC 校验,规范串与 jusi push.Sign 完全同构:method\\npath\\nts\\nbody)。
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time

from django.conf import settings
from django.utils import timezone

from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from core.models import DevicePushToken
from core.services.push_send import notify_offline

logger = logging.getLogger(__name__)


class PushTokenView(APIView):
    """Register / unregister the caller's device push token."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        cid = str((request.data or {}).get("cid") or "").strip()
        if not cid:
            return Response(
                {"cid": "cid is required"}, status=status.HTTP_400_BAD_REQUEST
            )
        data = request.data or {}
        token, created = DevicePushToken.objects.update_or_create(
            provider=DevicePushToken.Provider.GETUI,
            cid=cid,
            defaults={
                # Re-binding on account switch: the row follows the CURRENT user.
                "user": request.user,
                "device_id": str(data.get("device_id") or "")[:128],
                "platform": str(data.get("platform") or "")[:16],
                "app_version": str(data.get("app_version") or "")[:32],
                "last_seen_at": timezone.now(),
            },
        )
        return Response(
            {"id": str(token.id), "cid": token.cid},
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    def delete(self, request):
        cid = str((request.data or {}).get("cid") or "").strip()
        if not cid:
            return Response(
                {"cid": "cid is required"}, status=status.HTTP_400_BAD_REQUEST
            )
        deleted, _ = DevicePushToken.objects.filter(
            user=request.user, cid=cid
        ).delete()
        return Response({"deleted": deleted}, status=status.HTTP_200_OK)


class ImPushHookView(APIView):
    """jusi-light-im p14 offline-push webhook receiver (internal surface).

    Auth: X-Timestamp + X-Signature, HMAC-SHA256 over
    ``method\\npath\\nts\\nbody`` with ``PUSH_CONFIGURATION.webhook_secret``.
    Fail-closed: unset secret disables the endpoint entirely.
    """

    authentication_classes: list = []
    permission_classes: list = []

    def post(self, request):
        cfg = getattr(settings, "PUSH_CONFIGURATION", None) or {}
        secret = str(cfg.get("webhook_secret") or "")
        if len(secret) < 32:
            logger.warning("push-hook rejected: webhook_secret unset/too short")
            return Response(status=status.HTTP_404_NOT_FOUND)

        ts = request.headers.get("X-Timestamp") or ""
        sig = request.headers.get("X-Signature") or ""
        if not ts or not sig:
            return Response(status=status.HTTP_401_UNAUTHORIZED)
        try:
            skew = abs(time.time() - float(int(ts)))
        except ValueError:
            return Response(status=status.HTTP_401_UNAUTHORIZED)
        if skew > float(cfg.get("webhook_skew_seconds") or 300):
            return Response(status=status.HTTP_401_UNAUTHORIZED)

        mac = hmac.new(secret.encode("utf-8"), digestmod=hashlib.sha256)
        mac.update(request.method.encode("ascii"))
        mac.update(b"\n")
        mac.update(request.path.encode("utf-8"))
        mac.update(b"\n")
        mac.update(ts.encode("ascii"))
        mac.update(b"\n")
        mac.update(request.body)
        if not hmac.compare_digest(mac.hexdigest(), sig):
            return Response(status=status.HTTP_401_UNAUTHORIZED)

        sent = notify_offline(request.data or {})
        return Response({"pushed": sent}, status=status.HTTP_200_OK)
