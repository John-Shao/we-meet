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

from .mobile_auth import _admin_realm_url, _get_service_account_token

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
    """Cap QR generation per IP — the only anonymous-creating endpoint.

    Explicit `scope` keeps this throttle's cache bucket separate from other
    AnonRateThrottle subclasses (mobile_auth, qr_poll); without it they all
    share `throttle_anon_<ip>` and starve each other.
    """

    scope = "qr_initiate"
    rate = "30/min"


class QrPollThrottle(AnonRateThrottle):
    """Web polls every 2s; allow ~1 req/s of headroom."""

    scope = "qr_poll"
    rate = "120/min"


class QrUserThrottle(UserRateThrottle):
    """App-side scan/confirm/cancel."""

    scope = "qr_user"
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

        # SSO 落点（2026-07 改造）：不再用 Token Exchange mint token —— 那样只把
        # token 发给 web、不在 Keycloak 域给浏览器建会话，扫码只登进 meet 单点、
        # 给不了跨系统 SSO。改为只标 confirmed；entry 已含 scanned_user_id(=KC user
        # sub) + user{phone,name}。由 Keycloak 扫码认证器轮询 authenticator-status
        # 拿到身份后自己 setUser + success 建浏览器 SSO 会话。
        # 详见 docs/features/qr_login_sso.md。
        entry.update({"status": STATUS_CONFIRMED})
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


class QrAuthenticatorStatusView(APIView):
    """Keycloak 扫码认证器专用：查 qrToken 状态 + 已确认用户身份（不发 token）。

    GET /api/qr-login/authenticator-status/?token=...
    Auth: Authorization: Bearer <QR_AUTHENTICATOR_GATEWAY_TOKEN>

    与 /poll/（web 用、AllowAny、confirmed 时发 token）刻意分离：这个端点是
    Keycloak 扫码认证器建会话的**身份来源**，只回 {sub, phone, name}、绝不回
    token；且 **fail-closed** —— gateway token 未配置直接拒绝（与 keycloak_sms
    的「未配即放行」相反，因为这里护的是建会话的身份）。
    详见 docs/features/qr_login_sso.md。

    Responses:
      - {"status": "pending"}
      - {"status": "scanned"|"confirmed", "user": {"sub", "phone", "name"}}
      - {"status": "cancelled"} / {"status": "expired"}
    """

    # Machine-to-machine (Keycloak → backend): bypass global OIDC auth/throttle,
    # guard with the shared bearer below.
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = []

    def get(self, request):
        expected = settings.QR_AUTHENTICATOR_GATEWAY_TOKEN
        # fail-closed：未配置即拒绝（绝不放行——这是建会话的身份来源）。
        if not expected:
            logger.error(
                "QR_AUTHENTICATOR_GATEWAY_TOKEN not configured — refusing "
                "authenticator-status (fail-closed)"
            )
            return Response(
                {"error": "gateway not configured"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        presented = (
            request.headers.get("Authorization", "")
            .removeprefix("Bearer ")
            .strip()
        )
        # bytes 版：避免 str 版对非 ASCII header 抛 TypeError（畸形请求→500）。
        if not secrets.compare_digest(presented.encode(), expected.encode()):
            return Response(
                {"error": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED
            )

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
        if st in (STATUS_SCANNED, STATUS_CONFIRMED):
            # 只暴露身份（sub=scanned_user_id 是 KC user UUID，供认证器 getUserById），
            # 绝不回 token。
            user = dict(entry.get("user") or {})
            user["sub"] = entry.get("scanned_user_id")
            return Response({"status": st, "user": user})
        if st == STATUS_CANCELLED:
            return Response({"status": STATUS_CANCELLED})
        return Response({"status": STATUS_PENDING})


class QrReadyView(APIView):
    """极简「确认了吗」信号，供 Keycloak 双栏登录页(阶段二)的扫码列 AJAX 轮询。

    GET /api/qr-login/ready/?token=...  →  {"status": "pending|scanned|confirmed|cancelled|expired"}

    与 /authenticator-status/ 分工：那个是 KC 服务端建会话的**身份来源**（受
    shared-bearer 保护、含 sub）；这个只回一个非敏感 status，让 KC 双栏页的浏览器
    JS 判断何时提交最终确认（KC 页在 id.we-meet.online、后端在 meet.we-meet.online，
    跨域，故显式 `Access-Control-Allow-Origin: *`——只回 status、无 token、无 PII、
    非删除，条目留给 authenticator-status 读、TTL 兜底）。详见
    docs/features/qr_login_sso.md。
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [QrPollThrottle]

    def get(self, request):
        token = request.query_params.get("token", "").strip()
        entry = cache.get(_key(token)) if token else None
        st = entry.get("status") if entry else None
        resp = Response({"status": st or "expired"})
        resp["Access-Control-Allow-Origin"] = "*"
        return resp
