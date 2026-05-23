"""QR-code login: web shows a QR, App scans + confirms, web polls for the token.

Flow (web ↔ backend ↔ App):

    1. Web         POST /api/qr-login/initiate/         → {token, expires_in}
                   renders the QR encoding
                       we-meet://qr-login?token=<token>
    2. App         scans the QR, deeplink opens the scan-confirm screen
    3. App         POST /api/qr-login/scan/   (Bearer)  → {user}
                   marks the token as "scanned, awaiting App user's tap"
    4. Web         GET  /api/qr-login/poll/?token=...   → {status: scanned, user}
                   while polling every 2s
    5. App user    taps "确认登录"
       App         POST /api/qr-login/confirm/ (Bearer) → {success: true}
                   backend mints a fresh access/refresh for the App user via
                   Keycloak Token Exchange (the same path mobile_auth uses)
                   and parks the token in the Redis entry
    6. Web         next poll → {status: confirmed, access_token, ...}
                   stores in localStorage, refetches /users/me/, done.

The Redis entry self-destructs once the web has read it (one-shot delivery)
and any state lives for at most 5 minutes regardless. Tokens are 32 hex chars
(16 random bytes) — collision risk on a 5-minute window is negligible.

Cancel path: App POST /api/qr-login/cancel/ → poll returns {status: cancelled}
so the web can show "user declined" and regenerate.
"""

import logging
import secrets

import requests
from django.conf import settings
from django.core.cache import cache
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle, UserRateThrottle
from rest_framework.views import APIView

from .mobile_auth import _admin_realm_url, _get_service_account_token, _token_exchange

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cache state machine
# ---------------------------------------------------------------------------

_CACHE_PREFIX = "qr_login:"
_TTL_SECONDS = 300  # 5 min — long enough to scan-and-confirm, short enough
#                              to keep abandoned tokens out of the cache.

STATUS_PENDING = "pending"
STATUS_SCANNED = "scanned"
STATUS_CONFIRMED = "confirmed"
STATUS_CANCELLED = "cancelled"


def _key(token: str) -> str:
    return f"{_CACHE_PREFIX}{token}"


def _get_keycloak_user_attrs(user_id: str, sa_token: str) -> dict | None:
    """Fetch a Keycloak user's attributes (phoneNumber, firstName, ...).

    Returns the parsed user dict, or None on error.
    """
    try:
        resp = requests.get(
            f"{_admin_realm_url()}/users/{user_id}",
            headers={"Authorization": f"Bearer {sa_token}"},
            timeout=10,
            verify=settings.OIDC_VERIFY_SSL,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception:
        logger.exception("Failed to fetch Keycloak user %s", user_id)
        return None


def _user_display(user_id: str, sa_token: str) -> dict:
    """Build the {phone, name} payload echoed back to App + web during scan.

    Falls back to placeholders on lookup failure — the App still needs *some*
    label to render the confirmation screen.
    """
    data = _get_keycloak_user_attrs(user_id, sa_token) or {}
    attrs = data.get("attributes") or {}
    phone_list = attrs.get("phoneNumber") or []
    phone = phone_list[0] if phone_list else ""
    name = data.get("firstName") or data.get("username") or ""
    return {"phone": phone, "name": name}


# ---------------------------------------------------------------------------
# Throttles
# ---------------------------------------------------------------------------


class QrInitiateThrottle(AnonRateThrottle):
    """Cap QR generation per IP — the only anonymous-creating endpoint."""

    rate = "30/min"


class QrPollThrottle(AnonRateThrottle):
    """Web polls every 2s; allow ~1 req/s of headroom."""

    rate = "120/min"


class QrUserThrottle(UserRateThrottle):
    """App-side scan/confirm/cancel."""

    rate = "60/min"


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


class QrInitiateView(APIView):
    """Mint a fresh QR token.

    POST /api/qr-login/initiate/
    Response: {"token": "<32hex>", "expires_in": 300}
    """

    permission_classes = [AllowAny]
    throttle_classes = [QrInitiateThrottle]

    def post(self, request):
        token = secrets.token_hex(16)
        cache.set(
            _key(token),
            {"status": STATUS_PENDING},
            timeout=_TTL_SECONDS,
        )
        return Response({"token": token, "expires_in": _TTL_SECONDS})


class QrPollView(APIView):
    """Web polls for the token's current state.

    GET /api/qr-login/poll/?token=...
    Responses (varies by status):
      - {"status": "pending"}
      - {"status": "scanned", "user": {"phone": "...", "name": "..."}}
      - {"status": "confirmed", "access_token": "...", ...}
      - {"status": "cancelled"}
      - {"status": "expired"}              ← cache miss
    """

    permission_classes = [AllowAny]
    throttle_classes = [QrPollThrottle]

    def get(self, request):
        token = request.query_params.get("token", "").strip()
        if not token:
            return Response(
                {"error": "token is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        entry = cache.get(_key(token))
        if not entry:
            return Response({"status": "expired"})

        st = entry.get("status")

        if st == STATUS_CONFIRMED:
            # One-shot delivery — drop the entry so the access token can't be
            # observed twice (defence in depth even though it's already
            # inside a 5-minute TTL).
            cache.delete(_key(token))
            return Response(
                {
                    "status": STATUS_CONFIRMED,
                    "access_token": entry.get("access_token"),
                    "refresh_token": entry.get("refresh_token"),
                    "token_type": entry.get("token_type", "Bearer"),
                    "expires_in": entry.get("expires_in", 3600),
                }
            )

        if st == STATUS_SCANNED:
            return Response(
                {"status": STATUS_SCANNED, "user": entry.get("user", {})}
            )

        if st == STATUS_CANCELLED:
            cache.delete(_key(token))
            return Response({"status": STATUS_CANCELLED})

        # Default: pending.
        return Response({"status": STATUS_PENDING})


class QrScanView(APIView):
    """App reports that its user has scanned the QR; awaits the user's tap.

    POST /api/qr-login/scan/
    Body: {"token": "..."}
    Response: {"user": {"phone": "...", "name": "..."}}
    """

    permission_classes = [IsAuthenticated]
    throttle_classes = [QrUserThrottle]

    def post(self, request):
        token = (request.data.get("token") or "").strip()
        if not token:
            return Response(
                {"error": "token is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        entry = cache.get(_key(token))
        if not entry:
            return Response(
                {"error": "二维码已过期"}, status=status.HTTP_404_NOT_FOUND
            )
        if entry.get("status") not in (STATUS_PENDING, STATUS_SCANNED):
            return Response(
                {"error": "二维码已失效"}, status=status.HTTP_400_BAD_REQUEST
            )

        # We need the KC user_id (sub) of the App user. The OIDCAuthentication
        # backend stores it on the Django User row.
        user_sub = getattr(request.user, "sub", None)
        if not user_sub:
            return Response(
                {"error": "认证信息缺失"}, status=status.HTTP_400_BAD_REQUEST
            )

        sa_token = _get_service_account_token()
        user_info = _user_display(user_sub, sa_token) if sa_token else {}

        entry.update(
            {
                "status": STATUS_SCANNED,
                "scanned_user_id": user_sub,
                "user": user_info,
            }
        )
        cache.set(_key(token), entry, timeout=_TTL_SECONDS)
        return Response({"user": user_info})


class QrConfirmView(APIView):
    """App user taps "confirm" — mint a fresh token pair for the web side.

    POST /api/qr-login/confirm/
    Body: {"token": "..."}
    Response: {"success": true}
    """

    permission_classes = [IsAuthenticated]
    throttle_classes = [QrUserThrottle]

    def post(self, request):
        token = (request.data.get("token") or "").strip()
        if not token:
            return Response(
                {"error": "token is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        entry = cache.get(_key(token))
        if not entry:
            return Response(
                {"error": "二维码已过期"}, status=status.HTTP_404_NOT_FOUND
            )
        if entry.get("status") != STATUS_SCANNED:
            return Response(
                {"error": "请先扫码"}, status=status.HTTP_400_BAD_REQUEST
            )

        user_sub = getattr(request.user, "sub", None)
        if not user_sub:
            return Response(
                {"error": "认证信息缺失"}, status=status.HTTP_400_BAD_REQUEST
            )

        if entry.get("scanned_user_id") != user_sub:
            # Defensive: the confirming caller must be the same user that
            # scanned. Otherwise an attacker who saw the token in transit
            # could call confirm with their own bearer.
            return Response(
                {"error": "扫码与确认用户不一致"},
                status=status.HTTP_403_FORBIDDEN,
            )

        sa_token = _get_service_account_token()
        if not sa_token:
            return Response(
                {"error": "服务暂时不可用，请稍后重试"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        tokens = _token_exchange(user_sub, sa_token)
        if not tokens:
            return Response(
                {"error": "令牌获取失败，请稍后重试"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        entry.update({"status": STATUS_CONFIRMED, **tokens})
        cache.set(_key(token), entry, timeout=_TTL_SECONDS)
        return Response({"success": True})


class QrCancelView(APIView):
    """App user declines the login.

    POST /api/qr-login/cancel/
    Body: {"token": "..."}
    Response: 204
    """

    permission_classes = [IsAuthenticated]
    throttle_classes = [QrUserThrottle]

    def post(self, request):
        token = (request.data.get("token") or "").strip()
        if not token:
            return Response(
                {"error": "token is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        entry = cache.get(_key(token))
        if entry and entry.get("status") in (STATUS_PENDING, STATUS_SCANNED):
            entry["status"] = STATUS_CANCELLED
            cache.set(_key(token), entry, timeout=_TTL_SECONDS)

        return Response(status=status.HTTP_204_NO_CONTENT)
