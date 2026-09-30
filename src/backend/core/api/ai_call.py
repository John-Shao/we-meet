"""Authenticated SDP exchange for direct, one-to-one Omni calls."""

import re

from django.conf import settings

import requests
from rest_framework import permissions, serializers, throttling
from rest_framework.response import Response
from rest_framework.views import APIView

from core.models import AIAgentProfile, AIPrompt, AIVoice

MODEL = "qwen3.8-omni-flash-realtime"
MAX_SDP_LENGTH = 131072


class CallThrottle(throttling.UserRateThrottle):
    """Bound provider session creation per authenticated user."""

    scope = "ai_call"
    rate = "6/min"


class CallOfferSerializer(serializers.Serializer):
    """Accept a fixed-model call offer and catalog selections only."""

    sdp = serializers.CharField(max_length=MAX_SDP_LENGTH, trim_whitespace=False)
    profile_code = serializers.CharField(max_length=100)
    voice_id = serializers.UUIDField(required=False, allow_null=True)
    prompt_id = serializers.UUIDField(required=False, allow_null=True)

    def validate_sdp(self, value):
        """Reject non-SDP payloads before opening a provider session."""
        if not value.startswith("v=0") or "\nm=audio " not in value:
            raise serializers.ValidationError("An audio SDP offer is required.")
        return value


class AiCallSessionView(APIView):
    """Keep provider credentials server-side; media bypasses this service."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [CallThrottle]

    def post(self, request):
        """Exchange the client's offer and return the selected session settings."""
        serializer = CallOfferSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        profile = (
            AIAgentProfile.objects.filter(
                code=data["profile_code"],
                is_active=True,
                architecture="omni",
                omni_model__code=f"aliyun/{MODEL}",
                omni_model__vendor__code="aliyun",
                omni_model__is_active=True,
            )
            .select_related("default_voice")
            .first()
        )
        if profile is None:
            return Response(
                {"detail": "Qwen 3.8 call profile is unavailable."}, status=400
            )

        voices = AIVoice.objects.filter(model_id=profile.omni_model_id, is_active=True)
        voice = voices.filter(id=data.get("voice_id")).first()
        if voice is None:
            voice = voices.filter(id=profile.default_voice_id).first()
        if voice is None:
            voice = voices.filter(value="Tina").first()
        prompt = AIPrompt.objects.filter(
            id=data.get("prompt_id"), is_active=True
        ).first()

        workspace = settings.DASHSCOPE_WORKSPACE_ID
        region = settings.DASHSCOPE_REGION
        api_key = settings.DASHSCOPE_API_KEY
        if (
            not api_key
            or not re.fullmatch(r"[A-Za-z0-9-]+", workspace or "")
            or region
            not in {
                "cn-beijing",
                "ap-southeast-1",
            }
        ):
            return Response(
                {"detail": "AI call connection is not configured."}, status=503
            )
        # Never accept an upstream URL/model/header from the caller or follow redirects.
        url = f"https://{workspace}.{region}.maas.aliyuncs.com/api/v1/webrtc/realtime"
        try:
            with requests.post(
                url,
                params={"model": MODEL},
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/sdp",
                },
                data=data["sdp"].encode("utf-8"),
                timeout=(5, 20),
                allow_redirects=False,
                stream=True,
            ) as upstream:
                if upstream.status_code not in (200, 201):
                    return Response(
                        {"detail": "AI call connection was rejected."}, status=502
                    )
                chunks = bytearray()
                for chunk in upstream.iter_content(8192):
                    chunks.extend(chunk)
                    if len(chunks) > MAX_SDP_LENGTH:
                        raise requests.RequestException("SDP answer exceeds size limit")
                answer = chunks.decode("utf-8").strip()
        except (requests.RequestException, UnicodeDecodeError):
            return Response({"detail": "AI call connection failed."}, status=502)
        if not answer.startswith("v=0") or "\nm=audio " not in answer:
            return Response({"detail": "Invalid AI call answer."}, status=502)
        return Response(
            {
                "sdp": re.sub(r"\r?\n", "\r\n", answer) + "\r\n",
                "voice": voice.value if voice else "Tina",
                "instructions": prompt.content
                if prompt
                else "你是一个友好、简洁的 AI 助手。结合用户的语音与当前提供的画面回答问题。",
            },
            headers={"Cache-Control": "no-store"},
        )
