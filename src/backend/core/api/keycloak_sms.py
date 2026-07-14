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

from django.conf import settings

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from core.api.mobile_auth import _send_sms

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
