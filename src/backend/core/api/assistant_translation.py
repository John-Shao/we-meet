"""Short-lived, single-use admission for the standalone bilingual assistant."""

import re
import secrets
from urllib.parse import urlsplit

from django.conf import settings
from django.core import signing
from django.core.cache import cache

import requests
from rest_framework import permissions, serializers, throttling
from rest_framework.response import Response
from rest_framework.views import APIView

from core.api.agent_internal import AgentTokenAuthentication, HasAgentToken
from core.api.ai_call import MAX_SDP_LENGTH, parse_connection
from core.models import User
from core.services import provider_http
from core.services.direct_ai_allocations import allocating

SALT = "assistant-translation-v1"
# LiveTranslate 3.8 languages supporting both audio and text output.
# Keep aligned with agents.plugins.qwen.live_translate.AUDIO_LANGUAGES.
LANGUAGES = tuple(
    "zh en ar de fr es pt id it ko ru th vi ja tr hi ms nl ur nb sv da he fi "
    "pl is cs fil fa".split()
)


class TranslationThrottle(throttling.UserRateThrottle):
    scope = "assistant_translation"
    rate = "20/min"


class PairSerializer(serializers.Serializer):
    source_language = serializers.ChoiceField(choices=LANGUAGES)
    target_language = serializers.ChoiceField(choices=LANGUAGES)

    def validate(self, attrs):
        if attrs["source_language"] == attrs["target_language"]:
            raise serializers.ValidationError("Choose distinct languages.")
        return attrs


class AssistantTranslationTicketView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [TranslationThrottle]

    def post(self, request):
        serializer = PairSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        url = settings.MEETING_CAPTURE_TRANSLATION_URL
        try:
            parsed = urlsplit(url)
            valid = (
                parsed.scheme == "wss"
                and parsed.hostname
                and parsed.path == "/capture-translation"
                and not (
                    parsed.username
                    or parsed.password
                    or parsed.query
                    or parsed.fragment
                )
            )
            _ = parsed.port
        except ValueError:
            valid = False
        if not valid or not settings.AGENT_INTERNAL_API_TOKEN:
            return Response({"detail": "Translation is not configured."}, status=503)
        ticket = signing.dumps(
            {
                "user": str(request.user.pk),
                "nonce": secrets.token_hex(16),
                **serializer.validated_data,
            },
            salt=SALT,
        )
        return Response(
            {"url": url, "ticket": ticket}, headers={"Cache-Control": "no-store"}
        )


class AssistantTranslationClaimView(APIView):
    authentication_classes = [AgentTokenAuthentication]
    permission_classes = [HasAgentToken]

    def post(self, request):
        ticket = serializers.CharField(max_length=2048).run_validation(
            request.data.get("ticket")
        )
        try:
            grant = signing.loads(ticket, salt=SALT, max_age=30)
            serializer = PairSerializer(data=grant)
            serializer.is_valid(raise_exception=True)
            if not User.objects.filter(pk=grant["user"], is_active=True).exists():
                raise ValueError
            # Atomic add also prevents concurrent claims across gateway replicas.
            if not cache.add(
                f"assistant-translation-used:{grant['nonce']}", True, timeout=60
            ):
                raise ValueError
        except (
            signing.BadSignature,
            KeyError,
            ValueError,
            serializers.ValidationError,
        ):
            return Response(status=403)
        return Response(
            serializer.validated_data, headers={"Cache-Control": "no-store"}
        )


class DirectTranslationSerializer(PairSerializer):
    """Only permit the two models required by automatic bilingual translation."""

    purpose = serializers.ChoiceField(
        choices=("translation", "language_detection"), default="translation"
    )
    transport = serializers.ChoiceField(choices=("aoq", "webrtc"), default="aoq")
    sdp = serializers.CharField(
        max_length=MAX_SDP_LENGTH, required=False, trim_whitespace=False
    )

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if attrs["transport"] == "webrtc":
            offer = attrs.get("sdp", "")
            if (
                not offer.startswith("v=0")
                or "\nm=audio " not in offer
                or "\nm=application " not in offer
            ):
                raise serializers.ValidationError(
                    {"sdp": "An audio and data SDP offer is required."}
                )
        elif attrs.get("sdp"):
            raise serializers.ValidationError({"sdp": "AOQ does not use SDP."})
        return attrs


class AssistantTranslationSessionView(APIView):
    """Allocate AOQ or exchange WebRTC SDP; never proxy speech or expose API keys."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [TranslationThrottle]

    def post(self, request):
        serializer = DirectTranslationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        workspace = settings.DASHSCOPE_WORKSPACE_ID
        region = settings.DASHSCOPE_REGION
        api_key = settings.DASHSCOPE_API_KEY
        if (
            not api_key
            or not re.fullmatch(r"[A-Za-z0-9-]+", workspace or "")
            or region not in {"cn-beijing", "ap-southeast-1"}
        ):
            return Response({"detail": "Translation is not configured."}, status=503)
        model = (
            "qwen3.8-livetranslate-flash-realtime"
            if data["purpose"] == "translation"
            else "qwen3.8-omni-flash-realtime"
        )
        url = f"https://{workspace}.{region}.maas.aliyuncs.com/api/v1/webrtc/realtime"
        is_aoq = data["transport"] == "aoq"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json" if is_aoq else "application/sdp",
        }
        if is_aoq:
            headers["x-dashscope-rtc-transport"] = "moq"
        with allocating(request.user, model, data["transport"]) as allocation:
            try:
                with provider_http.request(
                    "POST",
                    url,
                    params={"model": model},
                    headers=headers,
                    data=b"{}" if is_aoq else data["sdp"].encode("utf-8"),
                    timeout=(5, 20),
                    allow_redirects=False,
                    stream=True,
                ) as upstream:
                    if upstream.status_code not in (200, 201):
                        return Response(
                            {"detail": "Direct translation connection was rejected."},
                            status=502,
                        )
                    chunks = bytearray()
                    for chunk in upstream.iter_content(8192):
                        chunks.extend(chunk)
                        if len(chunks) > MAX_SDP_LENGTH:
                            raise ValueError("Allocation exceeds size limit")
                    # Provider answers may already end in CRLF. The shared parser
                    # appends the final terminator; avoid an empty SDP line.
                    connection = parse_connection(
                        chunks.decode("utf-8").rstrip(), is_aoq
                    )
                    if not is_aoq and "\nm=application " not in connection["sdp"]:
                        raise ValueError("Missing event channel")
            except (requests.RequestException, ValueError, KeyError, TypeError):
                return Response(
                    {"detail": "Direct translation connection failed."}, status=502
                )
            return Response(
                {
                    "model": model,
                    **connection,
                    "session_lease": allocation.issue(),
                    "transport": data["transport"],
                    "purpose": data["purpose"],
                    "source_language": data["source_language"],
                    "target_language": data["target_language"],
                },
                headers={"Cache-Control": "no-store"},
            )
