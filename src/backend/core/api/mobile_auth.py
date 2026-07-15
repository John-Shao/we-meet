"""Mobile app SMS OTP authentication endpoints.

Provides two REST endpoints for native mobile app login:
    POST /api/mobile/auth/send-otp/   — generate OTP, store in Redis, send SMS
    POST /api/mobile/auth/verify-otp/ — verify OTP, return Keycloak tokens via Token Exchange

Token Exchange flow (after OTP verification):
    1. meet-service (service account) gets its own client_credentials token
    2. Keycloak Admin API: find or create user by phoneNumber attribute
    3. Token Exchange: exchange service account token for user token
    4. Return access_token + refresh_token to mobile app

Keycloak prerequisites (see deploy/aliyun/keycloak/bootstrap-mobile.sh):
    - KC_FEATURES=token-exchange in the Keycloak container
    - `meet-service` confidential client with service accounts enabled
    - service account granted realm-management roles
      view-users / query-users / manage-users / impersonation
"""

import json
import logging
import random
import re

import requests
from django.conf import settings
from django.core.cache import cache
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView
from volcengine.sms.SmsService import SmsService

logger = logging.getLogger(__name__)

PHONE_REGEX = re.compile(r"^1[3-9]\d{9}$")
_OTP_CACHE_PREFIX = "mobile_otp:"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _send_sms(phone: str, otp: str) -> bool:
    """Send OTP via Volcengine SMS template. Returns True on success."""
    sms = SmsService()
    sms.set_ak(settings.VOLC_SMS_AK)
    sms.set_sk(settings.VOLC_SMS_SK)
    params = {
        "SmsAccount": settings.VOLC_SMS_ACCOUNT,
        "Sign": settings.VOLC_SMS_SIGN,
        "TemplateID": settings.VOLC_SMS_TEMPLATE_ID,
        "TemplateParam": json.dumps({"code": otp}),
        "PhoneNumbers": phone,
    }
    try:
        resp = sms.send_sms(json.dumps(params))
    except Exception:
        logger.exception("SendSms failed for %s", phone)
        return False

    error = resp.get("ResponseMetadata", {}).get("Error")
    if error:
        logger.error("Volcengine SMS error for %s: %s", phone, error)
        return False
    return True


def _realm_url() -> str:
    """Extract realm base URL from OIDC_OP_TOKEN_ENDPOINT.

    e.g. https://id.we-meet.online/realms/meet/protocol/openid-connect/token
      → https://id.we-meet.online/realms/meet
    """
    endpoint = settings.OIDC_OP_TOKEN_ENDPOINT or ""
    marker = "/protocol/openid-connect/token"
    idx = endpoint.find(marker)
    return endpoint[:idx] if idx > 0 else endpoint


def _admin_realm_url() -> str:
    """Convert realm URL to admin REST API URL.

    e.g. https://id.we-meet.online/realms/meet
      → https://id.we-meet.online/admin/realms/meet
    """
    realm = _realm_url()
    return realm.replace("/realms/", "/admin/realms/", 1)


def _get_service_account_token() -> str | None:
    """Obtain a service account access_token for meet-service client."""
    try:
        resp = requests.post(
            settings.OIDC_OP_TOKEN_ENDPOINT,
            data={
                "grant_type": "client_credentials",
                "client_id": settings.MOBILE_AUTH_SERVICE_CLIENT_ID,
                "client_secret": settings.MOBILE_AUTH_SERVICE_CLIENT_SECRET,
                # Token Exchange can only pass `openid` through to the user
                # token if this subject token already carries it.
                "scope": "openid",
            },
            timeout=10,
            verify=settings.OIDC_VERIFY_SSL,
        )
        resp.raise_for_status()
        return resp.json().get("access_token")
    except Exception:
        logger.exception("Failed to get meet-service service account token")
        return None


def _find_or_create_keycloak_user(phone: str, sa_token: str) -> str | None:
    """Find Keycloak user by phoneNumber attribute; create if absent.

    Returns the Keycloak user UUID, or None on error.
    """
    admin_url = _admin_realm_url()
    headers = {
        "Authorization": f"Bearer {sa_token}",
        "Content-Type": "application/json",
    }

    # Search by custom attribute phoneNumber
    try:
        resp = requests.get(
            f"{admin_url}/users",
            params={"q": f"phoneNumber:{phone}"},
            headers=headers,
            timeout=10,
            verify=settings.OIDC_VERIFY_SSL,
        )
        resp.raise_for_status()
        users = resp.json()
        if users:
            return users[0]["id"]
    except Exception:
        logger.exception("Keycloak user search failed for phone %s", phone)
        return None

    # User not found — create with phoneNumber attribute
    try:
        resp = requests.post(
            f"{admin_url}/users",
            json={
                "username": phone,
                "firstName": f"WeMeet-{phone[-4:]}",
                "enabled": True,
                "attributes": {"phoneNumber": [phone]},
            },
            headers=headers,
            timeout=10,
            verify=settings.OIDC_VERIFY_SSL,
        )
        resp.raise_for_status()
        # Keycloak returns 201 with Location: .../users/{uuid}
        location = resp.headers.get("Location", "")
        user_id = location.rstrip("/").split("/")[-1]
        return user_id or None
    except Exception:
        logger.exception("Keycloak user creation failed for phone %s", phone)
        return None


def _token_exchange(user_id: str, sa_token: str) -> dict | None:
    """Exchange service account token for a user token via Keycloak Token Exchange.

    Returns {"access_token", "refresh_token", "token_type", "expires_in"} or None.
    """
    try:
        resp = requests.post(
            settings.OIDC_OP_TOKEN_ENDPOINT,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "client_id": settings.MOBILE_AUTH_SERVICE_CLIENT_ID,
                "client_secret": settings.MOBILE_AUTH_SERVICE_CLIENT_SECRET,
                "subject_token": sa_token,
                "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "requested_subject": user_id,
                # `openid` scope is required: the meet-backend validates the
                # bearer token via the Keycloak userinfo endpoint, which
                # rejects tokens lacking it (403 insufficient_scope → 500).
                "scope": "openid",
            },
            timeout=10,
            verify=settings.OIDC_VERIFY_SSL,
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token"),
            "token_type": data.get("token_type", "Bearer"),
            "expires_in": data.get("expires_in", 3600),
        }
    except Exception:
        logger.exception("Token exchange failed for user %s", user_id)
        return None


def _issue_otp(phone: str) -> bool:
    """Generate (or demo-fixed) OTP, store in cache, send SMS. True on success.

    一套 OTP 生成/存储/发送/demo 逻辑，被 mobile SendOtpView 与 Keycloak 双栏登录页
    发码网关（keycloak_sms.KeycloakOtpSendView）共用。
    """
    expiry = settings.MOBILE_AUTH_OTP_EXPIRY
    cache_key = f"{_OTP_CACHE_PREFIX}{phone}"

    demo_otp = settings.MOBILE_AUTH_DEMO_OTP
    if demo_otp and phone in settings.MOBILE_AUTH_DEMO_PHONES:
        cache.set(cache_key, {"otp": demo_otp, "attempts": 0}, timeout=expiry)
        return True

    otp_len = settings.MOBILE_AUTH_OTP_LENGTH
    otp = "".join(str(random.SystemRandom().randint(0, 9)) for _ in range(otp_len))
    cache.set(cache_key, {"otp": otp, "attempts": 0}, timeout=expiry)
    if not _send_sms(phone, otp):
        cache.delete(cache_key)
        return False
    return True


def _validate_otp(phone: str, otp_input: str) -> tuple[bool, str | None]:
    """Validate OTP against cache (attempts/expiry/compare). Deletes on success.

    Returns (True, None) on success, else (False, error_msg). 不 mint token ——
    被 VerifyOtpView(mobile，校验后再 Token Exchange)与 Keycloak 统一认证器校验
    网关（keycloak_sms.KeycloakOtpVerifyView，只校验不发 token）共用。
    """
    cache_key = f"{_OTP_CACHE_PREFIX}{phone}"
    cached = cache.get(cache_key)
    if not cached:
        return False, "验证码已过期，请重新获取"

    attempts = cached.get("attempts", 0)
    max_attempts = settings.MOBILE_AUTH_OTP_MAX_ATTEMPTS
    if attempts >= max_attempts:
        cache.delete(cache_key)
        return False, "错误次数过多，请重新获取验证码"

    if cached["otp"] != otp_input:
        cached["attempts"] = attempts + 1
        cache.set(cache_key, cached, timeout=settings.MOBILE_AUTH_OTP_EXPIRY)
        remaining = max_attempts - cached["attempts"]
        return False, f"验证码错误，还有 {remaining} 次机会"

    cache.delete(cache_key)
    return True, None


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


class MobileAuthThrottle(AnonRateThrottle):
    """30 requests/min per IP for mobile auth endpoints.

    `scope` is explicit so this throttle's cache bucket doesn't collide with
    other AnonRateThrottle subclasses (qr-login/*), which would otherwise
    share `throttle_anon_<ip>` and starve each other — the web QR panel
    polls every 2s = 30 req/min on its own.

    Rate ceiling is the SMS gateway anyway (per-phone Volcengine quota);
    this throttle is just a coarse anti-abuse cap by IP.
    """

    scope = "mobile_auth"
    rate = "30/min"


class SendOtpView(APIView):
    """Generate and send an OTP to the given phone number.

    POST /api/mobile/auth/send-otp/
    Request:  {"phone": "13800000000"}
    Response: {"success": true, "expires_in": 600}
    """

    permission_classes = [AllowAny]
    throttle_classes = [MobileAuthThrottle]

    def post(self, request):
        phone = (request.data.get("phone") or "").strip()
        if not PHONE_REGEX.match(phone):
            return Response(
                {"error": "手机号格式不正确"}, status=status.HTTP_400_BAD_REQUEST
            )
        if not _issue_otp(phone):
            return Response(
                {"error": "短信发送失败，请稍后重试"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response(
            {"success": True, "expires_in": settings.MOBILE_AUTH_OTP_EXPIRY}
        )


class VerifyOtpView(APIView):
    """Verify an OTP and return Keycloak tokens.

    POST /api/mobile/auth/verify-otp/
    Request:  {"phone": "13800000000", "otp": "123456"}
    Response: {"access_token": "...", "refresh_token": "...",
               "token_type": "Bearer", "expires_in": 300}
    """

    permission_classes = [AllowAny]
    throttle_classes = [MobileAuthThrottle]

    def post(self, request):
        phone = (request.data.get("phone") or "").strip()
        otp_input = (request.data.get("otp") or "").strip()

        if not PHONE_REGEX.match(phone):
            return Response(
                {"error": "手机号格式不正确"}, status=status.HTTP_400_BAD_REQUEST
            )

        ok, err = _validate_otp(phone, otp_input)
        if not ok:
            return Response({"error": err}, status=status.HTTP_400_BAD_REQUEST)

        # Get Keycloak tokens via Token Exchange
        sa_token = _get_service_account_token()
        if not sa_token:
            return Response(
                {"error": "服务暂时不可用，请稍后重试"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        user_id = _find_or_create_keycloak_user(phone, sa_token)
        if not user_id:
            return Response(
                {"error": "用户认证失败，请稍后重试"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        tokens = _token_exchange(user_id, sa_token)
        if not tokens:
            return Response(
                {"error": "令牌获取失败，请稍后重试"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response(tokens)


class RefreshTokenView(APIView):
    """Trade an unexpired refresh_token for a fresh access/refresh pair.

    POST /api/mobile/auth/refresh/
    Request:  {"refresh_token": "..."}
    Response: {"access_token": "...", "refresh_token": "...",
               "token_type": "Bearer", "expires_in": 1800}

    Backend handles the client_secret so neither the web app nor the native
    app needs to ship it. Refresh-token rotation is on by default in
    Keycloak — the new refresh_token replaces the old one and the caller
    MUST overwrite its stored copy.

    On `invalid_grant` (refresh expired / revoked / replayed) returns 401 so
    the caller can clear local state and bounce to the login screen.
    """

    permission_classes = [AllowAny]
    throttle_classes = [MobileAuthThrottle]

    def post(self, request):
        refresh_token = (request.data.get("refresh_token") or "").strip()
        if not refresh_token:
            return Response(
                {"error": "refresh_token is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            resp = requests.post(
                settings.OIDC_OP_TOKEN_ENDPOINT,
                data={
                    "grant_type": "refresh_token",
                    "client_id": settings.MOBILE_AUTH_SERVICE_CLIENT_ID,
                    "client_secret": settings.MOBILE_AUTH_SERVICE_CLIENT_SECRET,
                    "refresh_token": refresh_token,
                    # Keep the scope chain consistent with verify-otp so the
                    # new access_token also passes the userinfo check.
                    "scope": "openid",
                },
                timeout=10,
                verify=settings.OIDC_VERIFY_SSL,
            )
        except Exception:
            logger.exception("refresh_token grant request failed")
            return Response(
                {"error": "服务暂时不可用，请稍后重试"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        if resp.status_code in (400, 401):
            # `invalid_grant` is the common case — refresh expired or
            # already-rotated. Force the client to re-login.
            return Response(
                {"error": "登录已过期，请重新登录"},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        if not resp.ok:
            logger.error(
                "refresh_token grant unexpected status %s: %s",
                resp.status_code,
                resp.text[:200],
            )
            return Response(
                {"error": "令牌刷新失败，请稍后重试"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        data = resp.json()
        return Response(
            {
                "access_token": data["access_token"],
                "refresh_token": data.get("refresh_token", refresh_token),
                "token_type": data.get("token_type", "Bearer"),
                "expires_in": data.get("expires_in", 1800),
            }
        )
