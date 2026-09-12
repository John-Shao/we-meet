"""Translation intent and worker APIs; ordinary join tokens grant no controls."""

from django.db import IntegrityError
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.api.agent_internal import AgentTokenAuthentication, HasAgentToken
from core.api.online_capture import CaptureSourceSerializer
from core.services import meeting_translation as service
from core.services.meeting_records import RecordConflict
from core.services.online_capture import can_control


class TranslationControlSerializer(CaptureSourceSerializer):
    """A changed language pair creates a new run after acknowledged stop."""

    operation = serializers.ChoiceField(choices=["start", "stop"])
    key = serializers.UUIDField()
    expected_run_id = serializers.UUIDField(allow_null=True)
    source_participation_id = serializers.UUIDField(required=False)
    source = serializers.ChoiceField(choices=service.LANGUAGES, required=False)
    target = serializers.ChoiceField(choices=service.LANGUAGES, required=False)
    mode = serializers.ChoiceField(
        choices=["simultaneous", "push_to_talk"], required=False
    )
    audio = serializers.BooleanField(required=False)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        options = {"source_participation_id", "source", "target", "mode", "audio"}
        if attrs["operation"] == "start" and not options <= set(attrs):
            raise serializers.ValidationError("Translation start requires all options.")
        if attrs["operation"] == "stop" and options & set(attrs):
            raise serializers.ValidationError("Stop cannot change translation options.")
        return attrs


class TranslationStartThrottle(UserRateThrottle):
    """Throttle new billable generations while leaving stops reachable."""

    scope = "meeting_translation_starts"
    rate = "6/min"


class MeetingTranslationViewSet(viewsets.GenericViewSet):
    """The initial rollout supports a manager's own private source connection."""

    permission_classes = [permissions.IsAuthenticated]

    def get_throttles(self):
        if (
            self.request.method == "POST"
            and self.request.data.get("operation") == "start"
        ):
            return [TranslationStartThrottle()]
        return []

    @action(detail=False, methods=["get", "post"])
    def control(self, request):
        serializer = (
            TranslationControlSerializer
            if request.method == "POST"
            else CaptureSourceSerializer
        )(data=request.data if request.method == "POST" else request.query_params)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        session = get_object_or_404(
            models.MeetingSession,
            room_id=data["room_id"],
            livekit_room_sid=data["livekit_room_sid"],
        )
        if not can_control(session, request.user):
            return Response(status=404)
        if request.method == "GET":
            sources = session.participations.filter(
                user=request.user, left_at__isnull=True, kind="standard"
            )
            return Response(
                {
                    "available": service.enabled() and session.status == "active",
                    "languages": service.LANGUAGES,
                    "current": service.serialize(service.latest(session, request.user)),
                    "sources": [
                        {
                            "id": str(source.pk),
                            "participant_sid": source.livekit_participant_sid,
                        }
                        for source in sources
                    ],
                }
            )
        payload = {
            k: str(v)
            if k in {"expected_run_id", "source_participation_id"} and v is not None
            else v
            for k, v in data.items()
            if k not in {"room_id", "livekit_room_sid", "key"}
        }
        try:
            result, run, replayed = service.control(
                session.pk, request.user, data["key"], payload
            )
        except PermissionError:
            return Response(status=403)
        except (RecordConflict, IntegrityError):
            return Response({"detail": "Translation control conflicts."}, status=409)
        return Response(
            {"result": result, "current": service.serialize(run), "replayed": replayed}
        )


class TranslationReceiptSerializer(serializers.Serializer):
    """Completion acknowledgements are bounded and contain no speech or audio."""

    provider_finished = serializers.BooleanField()
    consumer_finished = serializers.BooleanField()
    input_tokens = serializers.IntegerField(
        min_value=0, max_value=10**12, allow_null=True
    )
    output_tokens = serializers.IntegerField(
        min_value=0, max_value=10**12, allow_null=True
    )

    def to_internal_value(self, data):
        if isinstance(data, dict) and set(data) - set(self.fields):
            raise serializers.ValidationError("Unsupported translation receipt field.")
        return super().to_internal_value(data)


class TranslationAgentSerializer(CaptureSourceSerializer):
    """Bind every internal action to its exact worker, source and generation."""

    run_id = serializers.UUIDField()
    generation = serializers.IntegerField(min_value=1)
    worker_id = serializers.UUIDField()
    operation = serializers.ChoiceField(choices=["claim", "heartbeat", "finish"])
    receipt = TranslationReceiptSerializer(required=False)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if (attrs["operation"] == "finish") != ("receipt" in attrs):
            raise serializers.ValidationError("Only finish requires a receipt.")
        return attrs


class TranslationAgentView(APIView):
    """Worker claims happen before provider connection; duplicate dispatch cannot bill."""

    authentication_classes = [AgentTokenAuthentication]
    permission_classes = [HasAgentToken]

    def post(self, request):
        serializer = TranslationAgentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            result = service.agent_control(data["run_id"], data)
        except models.MeetingTranslationRun.DoesNotExist:
            return Response(status=404)
        except RecordConflict:
            return Response({"detail": "Translation worker conflicts."}, status=409)
        return Response(
            {"id": str(data["run_id"]), "generation": data["generation"], **result}
        )
