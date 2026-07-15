"""SMS gateway for the Keycloak phone-auth authenticator plugin.

The custom Keycloak browser authenticator (Meeting/keycloak-phone-auth) generates
the OTP itself and POSTs the ready-made message here for delivery; we extract the
numeric code and send it through the same Volcengine template used by mobile
login. This is intentionally separate from ``/api/mobile/auth/*`` (native app),
which mints its own OTP — here Keycloak owns the OTP and we are just the SMS pipe.

    POST /keycloak-sms/send/   {"msisdn": "138...", "message": "...code 123456..."}
    Auth: ``Authorization: Bearer <KEYCLOAK_SMS_GATEWAY_TOKEN>`` (skipped if unset)
    200 {} on success; 4xx/5xx {"error": "..."} otherwise.
"""

import logging
import re
import secrets

from django.conf import settings

from rest_framework import status
from rest_framework.parsers import FormParser, JSONParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from core.api.mobile_auth import (
    PHONE_REGEX,
    MobileAuthThrottle,
    _issue_otp,
    _send_sms,
    _validate_otp,
)

logger = logging.getLogger(__name__)

# Keycloak plugin message embeds the code, e.g. "您的验证码是：123456，5分钟内有效".
_CODE_RE = re.compile(r"\b(\d{4,8})\b")


class KeycloakSmsGatewayView(APIView):
    """Deliver a Keycloak-plugin-generated OTP via Volcengine SMS."""

    # Machine-to-machine: bypass the global OIDC auth/throttle; guard with a
    # shared bearer token instead (checked below).
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = []

    def post(self, request):
        expected = settings.KEYCLOAK_SMS_GATEWAY_TOKEN
        if expected:
            token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            if token != expected:
                return Response({"error": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)

        phone = request.data.get("msisdn") or request.data.get("phone")
        if not phone:
            return Response({"error": "msisdn is required"}, status=status.HTTP_400_BAD_REQUEST)

        match = _CODE_RE.search(request.data.get("message", ""))
        if not match:
            logger.error("keycloak_sms: no OTP code found in message for %s", phone)
            return Response(
                {"error": "No OTP code found in message"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not _send_sms(phone, match.group(1)):
            return Response({"error": "SMS delivery failed"}, status=status.HTTP_502_BAD_GATEWAY)

        return Response({}, status=status.HTTP_200_OK)


class KeycloakOtpSendView(APIView):
    """Keycloak 双栏登录页手机侧「获取验证码」（浏览器 AJAX 直发，不刷新页面）。

    POST /api/keycloak-sms/otp/send/   {"phone": "138..."}（form-urlencoded 或 json）
    Response: {"success": true, "expires_in": 600} / {"error": ...}

    与 /api/mobile/auth/send-otp/ 同逻辑（复用 _issue_otp：生成/存 cache/发短信/demo），
    区别是给 Keycloak 登录页（id.we-meet.online）跨域 AJAX 用，故显式
    `Access-Control-Allow-Origin: *`（只回非敏感 {success}、无 token/PII；
    前端用 form-urlencoded 简单请求，免 CORS 预检）。详见
    docs/features/single_page_otp_login.md。
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [MobileAuthThrottle]
    # 收 form-urlencoded：让浏览器跨域用「简单请求」发码，免 CORS 预检
    # （项目 DRF 默认仅 JSON，会对 form 回 415）。也兼容 JSON。
    parser_classes = [FormParser, JSONParser]

    def post(self, request):
        phone = (request.data.get("phone") or "").strip()
        if not PHONE_REGEX.match(phone):
            resp = Response(
                {"error": "手机号格式不正确"}, status=status.HTTP_400_BAD_REQUEST
            )
        elif not _issue_otp(phone):
            resp = Response(
                {"error": "短信发送失败，请稍后重试"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        else:
            resp = Response(
                {"success": True, "expires_in": settings.MOBILE_AUTH_OTP_EXPIRY}
            )
        resp["Access-Control-Allow-Origin"] = "*"
        return resp


class KeycloakOtpVerifyView(APIView):
    """Keycloak 统一认证器手机侧校验验证码（KC 服务端→后端，shared-bearer）。

    POST /api/keycloak-sms/otp/verify/   {"phone": "...", "otp": "..."}
    Auth: Authorization: Bearer <KEYCLOAK_SMS_GATEWAY_TOKEN>
    Response: {"valid": true} / {"valid": false, "error": "..."}（均 HTTP 200）

    只校验 OTP（attempts/expiry/比对，复用 _validate_otp）、**不发 token、不做
    Token Exchange** —— 会话由 Keycloak 认证器 setUser+success 建。**fail-closed**：
    token 未配即拒绝（防暴力猜码；_validate_otp 本身也有 attempts 上限）。
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = []

    def post(self, request):
        expected = settings.KEYCLOAK_SMS_GATEWAY_TOKEN
        if not expected:
            logger.error(
                "KEYCLOAK_SMS_GATEWAY_TOKEN not configured — refusing otp/verify "
                "(fail-closed)"
            )
            return Response(
                {"error": "gateway not configured"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        presented = (
            request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        )
        if not secrets.compare_digest(presented.encode(), expected.encode()):
            return Response(
                {"error": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED
            )

        phone = (request.data.get("phone") or "").strip()
        otp = (request.data.get("otp") or "").strip()
        if not PHONE_REGEX.match(phone):
            return Response({"valid": False, "error": "手机号格式不正确"})

        ok, err = _validate_otp(phone, otp)
        return Response({"valid": ok, "error": err})
