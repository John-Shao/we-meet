"""Authenticated WebRTC signalling and AOQ allocation for direct Omni calls."""

import json
import re

from django.conf import settings

import requests
from rest_framework import permissions, serializers, throttling
from rest_framework.response import Response
from rest_framework.views import APIView

from core.models import AIAgentProfile, AIPrompt, AIVoice

MODEL = "qwen3.8-omni-flash-realtime"
MAX_SDP_LENGTH = 131072


def parse_aoq_allocation(answer):
    """Validate and allowlist provider credentials before returning them to an app."""
    allocation = json.loads(answer)
    relays = allocation["clientRelayEndpoints"]
    if not isinstance(relays, list) or not relays:
        raise ValueError("Missing relays")
    for relay in relays:
        if (
            not isinstance(relay["endpoint"], str)
            or not relay["endpoint"]
            or not isinstance(relay["port"], int)
            or not 0 < relay["port"] < 65536
        ):
            raise ValueError("Invalid relay")
        if "route_index" in relay and (
            type(relay["route_index"]) is not int or relay["route_index"] < 0
        ):
            raise ValueError("Invalid relay route")
    credentials = {
        key: allocation[key]
        for key in (
            "sid",
            "aoqTokenForClient",
            "clientRelayCertFingerprint",
        )
    }
    if not all(isinstance(value, str) and value for value in credentials.values()):
        raise ValueError("Invalid credentials")
    credentials["clientRelayEndpoints"] = [
        {
            "endpoint": relay["endpoint"],
            "port": relay["port"],
            "route_index": relay.get("route_index", index),
        }
        for index, relay in enumerate(relays)
    ]
    credentials["workspaceIdHash"] = allocation["extraInfo"]["workspaceIdHash"]
    if (
        not isinstance(credentials["workspaceIdHash"], str)
        or not credentials["workspaceIdHash"]
    ):
        raise ValueError("Invalid workspace")
    return credentials


def parse_connection(answer, is_aoq):
    """Decode the selected transport's bounded allocation response."""
    if is_aoq:
        return {"aoq": parse_aoq_allocation(answer)}
    if not answer.startswith("v=0") or "\nm=audio " not in answer:
        raise ValueError("Invalid SDP answer")
    return {"sdp": re.sub(r"\r?\n", "\r\n", answer) + "\r\n"}


class CallThrottle(throttling.UserRateThrottle):
    """Bound provider session creation per authenticated user."""

    scope = "ai_call"
    rate = "6/min"


class CallOfferSerializer(serializers.Serializer):
    """Accept a fixed-model call offer and catalog selections only."""

    sdp = serializers.CharField(
        max_length=MAX_SDP_LENGTH,
        trim_whitespace=False,
        required=False,
        allow_blank=True,
    )
    transport = serializers.ChoiceField(choices=("webrtc", "aoq"), default="webrtc")
    profile_code = serializers.CharField(max_length=100)
    voice_id = serializers.UUIDField(required=False, allow_null=True)
    prompt_id = serializers.UUIDField(required=False, allow_null=True)

    def validate_sdp(self, value):
        """Reject non-SDP payloads before opening a provider session."""
        if value and (not value.startswith("v=0") or "\nm=audio " not in value):
            raise serializers.ValidationError("An audio SDP offer is required.")
        return value

    def validate(self, attrs):
        if attrs["transport"] == "webrtc" and not attrs.get("sdp"):
            raise serializers.ValidationError(
                {"sdp": "An audio SDP offer is required."}
            )
        return attrs


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
        is_aoq = data["transport"] == "aoq"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json" if is_aoq else "application/sdp",
        }
        if is_aoq:
            headers["x-dashscope-rtc-transport"] = "moq"
        try:
            with requests.post(
                url,
                params={"model": MODEL},
                headers=headers,
                data=b"{}" if is_aoq else data["sdp"].encode("utf-8"),
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
        try:
            connection = parse_connection(answer, is_aoq)
        except (ValueError, KeyError, TypeError):
            return Response({"detail": "Invalid AI call allocation."}, status=502)
        return Response(
            {
                **connection,
                "voice": voice.value if voice else "Tina",
                "instructions": prompt.content
                if prompt
                else "你是一个友好、简洁的 AI 助手。结合用户的语音与当前提供的画面回答问题。",
            },
            headers={"Cache-Control": "no-store"},
        )
