"""Short-lived, single-use admission for the standalone bilingual assistant."""

import secrets
from urllib.parse import urlsplit

from django.conf import settings
from django.core import signing
from django.core.cache import cache

from rest_framework import permissions, serializers, throttling
from rest_framework.response import Response
from rest_framework.views import APIView

from core.api.agent_internal import AgentTokenAuthentication, HasAgentToken
from core.models import User

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
