"""Exact-session shared channels; personal subscription changes never stop other listeners."""

from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.api.agent_internal import AgentTokenAuthentication, HasAgentToken
from core.api.meeting_command_receipt import MeetingCommandReceiptMixin
from core.api.meeting_translation import TranslationReceiptSerializer
from core.api.online_capture import CaptureSourceSerializer
from core.services import meeting_interpretation as service
from core.services.interpretation_workers import agent_control
from core.services.meeting_records import RecordConflict
from core.services.online_capture import can_control
from core.services.translation_archives import enabled as archive_enabled


class ChannelInput(CaptureSourceSerializer):
    operation = serializers.ChoiceField(choices=["start", "stop"])
    key = serializers.UUIDField()
    target = serializers.ChoiceField(choices=service.LANGUAGES)
    expected_channel_id = serializers.UUIDField(allow_null=True)
    save_translations = serializers.BooleanField(required=False)


class ListenerInput(CaptureSourceSerializer):
    operation = serializers.ChoiceField(choices=["join", "leave"])
    key = serializers.UUIDField()
    participation_id = serializers.UUIDField()
    channel_id = serializers.UUIDField()
    expected_revision = serializers.IntegerField(min_value=0)


class RenewalInput(CaptureSourceSerializer):
    participation_id = serializers.UUIDField()
    channel_id = serializers.UUIDField()
    revision = serializers.IntegerField(min_value=1)


class StartThrottle(UserRateThrottle):
    scope = "interpretation_start"
    rate = "6/min"


class Base(MeetingCommandReceiptMixin, APIView):
    permission_classes = [permissions.IsAuthenticated]

    def parse(self, request, serializer):
        payload = serializer(
            data=request.data if request.method == "POST" else request.query_params
        )
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        session = get_object_or_404(
            models.MeetingSession.objects.select_related("room"),
            room_id=data.pop("room_id"),
            livekit_room_sid=data.pop("livekit_room_sid"),
        )
        return session, data

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response


class InterpretationChannelsView(Base):
    def get_throttles(self):
        return (
            [StartThrottle()]
            if self.request.method == "POST"
            and self.request.data.get("operation") == "start"
            else []
        )

    def get(self, request):
        session, _ = self.parse(request, CaptureSourceSerializer)
        connections = service.present(session, request.user)
        manager = can_control(session, request.user)
        if not manager and not connections.exists():
            return Response(status=404)
        channels = [
            session.interpretation_channels.filter(target=target)
            .order_by("-generation")
            .first()
            for target in service.LANGUAGES
        ]
        return Response(
            {
                "available": service.enabled() and session.status == "active",
                "can_control": manager,
                "archive_available": archive_enabled(),
                "languages": service.LANGUAGES,
                "channels": [
                    service.serialize(channel) for channel in channels if channel
                ],
                "connections": [
                    {"id": str(row.pk), "participant_sid": row.livekit_participant_sid}
                    for row in connections
                ],
                "subscriptions": [
                    service.serialize_subscription(row)
                    for row in models.MeetingInterpretationSubscription.objects.filter(
                        user=request.user, participation__in=connections
                    )
                ],
                "listener_lease_seconds": service.LISTENER_LEASE_SECONDS,
            }
        )

    def post(self, request):
        session, data = self.parse(request, ChannelInput)
        key = data.pop("key")
        data["expected_channel_id"] = (
            str(data["expected_channel_id"]) if data["expected_channel_id"] else None
        )
        try:
            result, replayed = service.control(session.pk, request.user, key, data)
        except PermissionError:
            return Response(status=403)
        except RecordConflict:
            return Response({"code": "interpretation_conflict"}, status=409)
        return Response({"result": result, "replayed": replayed})


class InterpretationSubscriptionView(Base):
    def post(self, request):
        session, data = self.parse(request, ListenerInput)
        key = data.pop("key")
        for field in ["participation_id", "channel_id"]:
            data[field] = str(data[field])
        try:
            result, replayed = service.subscribe(session.pk, request.user, key, data)
        except PermissionError:
            return Response(status=403)
        except RecordConflict:
            return Response(
                {"code": "interpretation_subscription_conflict"}, status=409
            )
        return Response({"result": result, "replayed": replayed})


class InterpretationRenewalView(Base):
    def post(self, request):
        session, data = self.parse(request, RenewalInput)
        try:
            result = service.renew(session.pk, request.user, **data)
        except PermissionError:
            return Response(status=403)
        except RecordConflict:
            return Response({"code": "interpretation_subscription_expired"}, status=409)
        return Response(result)


class InterpretationReceipt(TranslationReceiptSerializer):
    archive_finished = serializers.BooleanField(required=False)


class WorkerInput(CaptureSourceSerializer):
    channel_id = serializers.UUIDField()
    generation = serializers.IntegerField(min_value=1)
    worker_id = serializers.UUIDField()
    operation = serializers.ChoiceField(choices=["claim", "heartbeat", "finish"])
    receipt = InterpretationReceipt(required=False)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if (attrs["operation"] == "finish") != ("receipt" in attrs):
            raise serializers.ValidationError("Only finish requires a receipt.")
        return attrs


class InterpretationWorkerView(Base):
    authentication_classes = [AgentTokenAuthentication]
    permission_classes = [HasAgentToken]

    def post(self, request):
        payload = WorkerInput(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        try:
            result = agent_control(data["channel_id"], data)
        except models.MeetingInterpretationChannel.DoesNotExist:
            return Response(status=404)
        except RecordConflict:
            return Response({"code": "interpretation_worker_conflict"}, status=409)
        return Response(
            {"id": str(data["channel_id"]), "generation": data["generation"], **result}
        )
