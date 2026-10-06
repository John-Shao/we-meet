"""Short-lived, dedicated ASR credentials for Android direct validation."""

import json
import re
import time

from django.conf import settings

import requests
from rest_framework import permissions, throttling
from rest_framework.response import Response
from rest_framework.views import APIView

from core.services import provider_http

MODEL = "qwen-audio-3.1-asr-flash-streaming"


class TranscriptionThrottle(throttling.UserRateThrottle):
    """Bound credential issuance per signed-in user."""

    scope = "assistant-transcription"
    rate = "10/min"


class AssistantTranscriptionSessionView(APIView):
    """Never mint client tokens from the general-purpose DashScope API key."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [TranscriptionThrottle]

    def post(self, request):
        key = settings.DASHSCOPE_ASR_CLIENT_API_KEY
        workspace = settings.DASHSCOPE_WORKSPACE_ID
        region = settings.DASHSCOPE_REGION
        if not key or not re.fullmatch(r"[A-Za-z0-9-]+", workspace or ""):
            return Response({"detail": "Direct ASR is not configured."}, status=503)
        hosts = {
            "cn-beijing": "dashscope.aliyuncs.com",
            "ap-southeast-1": "dashscope-intl.aliyuncs.com",
        }
        if region not in hosts:
            return Response({"detail": "Direct ASR region is unavailable."}, status=503)
        try:
            with provider_http.request(
                "POST",
                f"https://{hosts[region]}/api/v1/tokens",
                params={"expire_in_seconds": 60},
                headers={"Authorization": f"Bearer {key}"},
                timeout=(5, 15),
                allow_redirects=False,
                stream=True,
            ) as upstream:
                if upstream.status_code != 200:
                    raise ValueError("Rejected")
                body = bytearray()
                for chunk in upstream.iter_content(8192):
                    body.extend(chunk)
                    if len(body) > 8192:
                        raise ValueError("Oversized")

                data = json.loads(body)
                token, expires = data["token"], data["expires_at"]
                if (
                    not isinstance(token, str)
                    or not token.startswith("st-")
                    or type(expires) is not int
                    or not time.time() < expires <= time.time() + 90
                ):
                    raise ValueError("Invalid token")
        except (requests.RequestException, ValueError, KeyError, TypeError):
            return Response({"detail": "Direct ASR allocation failed."}, status=502)
        return Response(
            {
                "model": MODEL,
                "token": token,
                "expires_at": expires,
                "url": f"wss://{workspace}.{region}.maas.aliyuncs.com/api-ws/v1/inference",
            },
            headers={"Cache-Control": "no-store"},
        )
