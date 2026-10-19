"""Short-lived, single-use admission for the standalone bilingual assistant."""

from urllib.parse import urlsplit

from django.conf import settings
from django.core import signing
from django.utils import timezone

from rest_framework import permissions, serializers, throttling
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView

from core.api.agent_internal import AgentTokenAuthentication, HasAgentToken
from core.models import AIModel, BilingualSession
from core.services import bilingual_sessions

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


TRANSLATION_MODEL = "qwen3.8-livetranslate-flash-realtime"
TRANSCRIPTION_LANGUAGES = tuple(
    "zh en ja de ko ru fr pt ar it es hi id th tr vi cs da fil fi is ms nb pl sv".split()
)


class TicketSerializer(PairSerializer):
    """Freeze all product choices before the gateway can open paid connections."""

    protocol_version = serializers.IntegerField(min_value=2, max_value=2)
    fixed_source = serializers.ChoiceField(
        choices=LANGUAGES, allow_null=True, default=None
    )
    voice = serializers.CharField(max_length=128, required=False)
    record_other_language = serializers.BooleanField(default=False)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if attrs["fixed_source"] not in (
            None,
            attrs["source_language"],
            attrs["target_language"],
        ):
            raise serializers.ValidationError("Invalid fixed direction.")
        if attrs["record_other_language"]:
            fixed = attrs["fixed_source"]
            other = next(
                (
                    code
                    for code in (attrs["source_language"], attrs["target_language"])
                    if code != fixed
                ),
                None,
            )
            if fixed is None or other not in TRANSCRIPTION_LANGUAGES:
                raise serializers.ValidationError(
                    "Record-only language is not supported."
                )
        return attrs


class AssistantTranslationConfigView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        model = AIModel.objects.filter(
            vendor__code="aliyun",
            vendor__is_active=True,
            code=f"aliyun/{TRANSLATION_MODEL}",
            capability="omni",
            is_active=True,
        ).first()
        voices = (
            []
            if model is None
            else list(
                model.voices.filter(is_active=True)
                .order_by("sort_order", "label", "value")
                .values("value", "label")
            )
        )
        config = (
            model.extra_config if model and isinstance(model.extra_config, dict) else {}
        )
        default = config.get("default_voice")
        values = {voice["value"] for voice in voices}
        if not isinstance(default, str) or default not in values:
            default = (
                "Tina" if "Tina" in values else (voices[0]["value"] if voices else None)
            )
        enabled = bilingual_sessions.account_enabled(request.user)
        return Response(
            {
                "model": TRANSLATION_MODEL,
                "default_voice": default,
                "voices": voices,
                "protocol_version": 2,
                "languages": list(LANGUAGES),
                "fixed_transcription_languages": list(TRANSCRIPTION_LANGUAGES),
                "enabled": bool(enabled and model and voices),
                "reason": (
                    "feature_disabled"
                    if not settings.ASSISTANT_TRANSLATION_ENABLED
                    else "account_not_enabled"
                    if not enabled
                    else "model_unavailable"
                    if model is None
                    else "voices_disabled"
                    if not voices
                    else None
                ),
            },
            headers={"Cache-Control": "no-store"},
        )


class AssistantTranslationTicketView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [TranslationThrottle]

    def post(self, request):
        if not isinstance(request.data, dict):
            raise serializers.ValidationError("Expected a JSON object.")
        if request.data.get("protocol_version") != 2:
            return Response({"code": "client_upgrade_required"}, status=426)
        serializer = TicketSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        bilingual_sessions.policy(request.user)
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
        model = AIModel.objects.filter(
            code=f"aliyun/{TRANSLATION_MODEL}",
            is_active=True,
            vendor__is_active=True,
            capability="omni",
        ).first()
        if model is None:
            return Response({"code": "model_unavailable"}, status=503)
        voices = list(
            model.voices.filter(is_active=True)
            .order_by("sort_order", "label", "value")
            .values_list("value", flat=True)
        )
        if not voices:
            return Response({"code": "voices_disabled"}, status=503)
        data = serializer.validated_data
        config = model.extra_config if isinstance(model.extra_config, dict) else {}
        default = config.get("default_voice")
        voice = data.get(
            "voice",
            default
            if default in voices
            else ("Tina" if "Tina" in voices else voices[0]),
        )
        if voice not in voices:
            return Response({"code": "voice_unavailable"}, status=400)
        session = bilingual_sessions.reserve(request.user)
        limits = bilingual_sessions.policy(request.user)
        ticket = signing.dumps(
            {
                "user": str(request.user.pk),
                "session_id": str(session.pk),
                **data,
                "voice": voice,
                "max_seconds": limits["max_seconds"],
                "idle_seconds": limits["idle_seconds"],
            },
            salt=SALT,
        )
        return Response(
            {
                "url": url,
                "ticket": ticket,
                "protocol_version": 2,
                **(
                    {"record_other_language": True}
                    if data["record_other_language"]
                    else {}
                ),
            },
            headers={"Cache-Control": "no-store"},
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
            serializer = TicketSerializer(data=grant)
            serializer.is_valid(raise_exception=True)
            session = bilingual_sessions.claim(grant["session_id"], grant["user"])
        except (
            signing.BadSignature,
            KeyError,
            ValueError,
            serializers.ValidationError,
            PermissionDenied,
            BilingualSession.DoesNotExist,
        ):
            return Response(status=403)
        return Response(
            {
                **serializer.validated_data,
                "session_id": str(session.pk),
                "max_seconds": grant["max_seconds"],
                "remaining_seconds": max(
                    1, int((session.deadline - timezone.now()).total_seconds())
                ),
                "idle_seconds": grant["idle_seconds"],
                "heartbeat_seconds": bilingual_sessions.HEARTBEAT_SECONDS,
            },
            headers={"Cache-Control": "no-store"},
        )


class AssistantTranslationLeaseView(APIView):
    """Gateway-only lifetime enforcement and cleanup, independent of client heartbeats."""

    authentication_classes = [AgentTokenAuthentication]
    permission_classes = [HasAgentToken]

    def post(self, request):
        session_id = serializers.UUIDField().run_validation(
            request.data.get("session_id")
        )
        operation = serializers.ChoiceField(
            choices=("heartbeat", "close")
        ).run_validation(request.data.get("operation"))
        try:
            state = bilingual_sessions.update(
                session_id, operation, request.data.get("usage")
            )
        except BilingualSession.DoesNotExist:
            return Response(status=404)
        return Response(
            {"status": state, "usage_recorded": request.data.get("usage") is not None},
            headers={"Cache-Control": "no-store"},
        )


class AssistantTranslationSessionView(APIView):
    """Retired direct endpoint: old clients must upgrade before starting a session."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [TranslationThrottle]

    def post(self, request):
        return Response(
            {
                "code": "client_upgrade_required",
                "detail": "Upgrade to use WebSocket translation.",
                "protocol_version": 2,
            },
            status=426,
            headers={"Cache-Control": "no-store"},
        )
