"""Owner-only call controls and separately authenticated sampler permits."""

from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.utils.crypto import constant_time_compare

from rest_framework import exceptions, permissions, serializers
from rest_framework.authentication import BaseAuthentication
from rest_framework.response import Response
from rest_framework.views import APIView

from core.api.voiceprint import (
    PrivateVoiceprintView,
    SettingsThrottle,
    StrictBoolean,
    StrictSerializer,
    StrictVersion,
)
from core.services import voiceprint_sampling as service
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_crypto import VoiceprintCryptoError
from core.services.voiceprint_encoder import MAX_AUDIO_BYTES


class ConnectionSerializer(StrictSerializer):
    session_id = serializers.UUIDField()
    participant_sid = serializers.RegexField(
        r"^[A-Za-z0-9_-]{1,64}$", trim_whitespace=False
    )


class ControlSerializer(ConnectionSerializer):
    expected_revision = StrictVersion(min_value=0)
    paused = StrictBoolean()
    shared_microphone = StrictBoolean()
    device_group = serializers.ChoiceField(choices=("", *service.DEVICE_GROUPS))


class SamplingControlView(PrivateVoiceprintView):
    throttle_classes = [SettingsThrottle]
    http_method_names = ["get", "patch", "options"]

    def get(self, request):
        payload = ConnectionSerializer(data=request.query_params)
        payload.is_valid(raise_exception=True)
        return Response(service.read_control(request.user, **payload.validated_data))

    def patch(self, request):
        payload = ControlSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        return Response(service.update_control(request.user, **payload.validated_data))


class SamplingAgentAuthentication(BaseAuthentication):
    """A distinct credential grants no ordinary user or transcript privileges."""

    def authenticate(self, request):
        token = request.headers.get("X-Voiceprint-Agent-Token", "")
        expected = settings.MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN
        if (
            not isinstance(expected, str)
            or not 32 <= len(expected) <= 512
            or not isinstance(token, str)
            or not 1 <= len(token) <= 512
            or not constant_time_compare(token, expected)
        ):
            raise exceptions.AuthenticationFailed("Sampling credential unavailable")
        return AnonymousUser(), True


class HasSamplingCredential(permissions.BasePermission):
    def has_permission(self, request, view):
        return request.auth is True


class TrackSerializer(StrictSerializer):
    room_sid = serializers.RegexField(r"^[A-Za-z0-9_-]{1,64}$", trim_whitespace=False)
    participant_sid = serializers.RegexField(
        r"^[A-Za-z0-9_-]{1,64}$", trim_whitespace=False
    )
    track_sid = serializers.RegexField(r"^[A-Za-z0-9_-]{1,64}$", trim_whitespace=False)


class PermitSerializer(TrackSerializer):
    request_key = serializers.UUIDField()


class ValidateSerializer(TrackSerializer):
    token = serializers.RegexField(r"^[A-Za-z0-9_-]{43}$", trim_whitespace=False)


class PrivateSamplerView(APIView):
    authentication_classes = [SamplingAgentAuthentication]
    permission_classes = [HasSamplingCredential]
    http_method_names = ["post", "options"]

    def handle_exception(self, exc):
        if isinstance(exc, VoiceprintError):
            return Response({"code": str(exc)}, status=exc.status)
        if isinstance(exc, VoiceprintCryptoError):
            return Response({"code": "voiceprint_key_unavailable"}, status=503)
        return super().handle_exception(exc)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response


class SamplingPermitView(PrivateSamplerView):
    def post(self, request):
        payload = PermitSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        return Response(service.issue(**payload.validated_data))


class SamplingValidationView(PrivateSamplerView):
    def post(self, request, permit_id):
        payload = ValidateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        return Response(service.validate(permit_id, **payload.validated_data))


class SamplingClipView(PrivateSamplerView):
    """One authenticated binary clip; no URLs, metadata or inferred identities."""

    http_method_names = ["put", "options"]
    parser_classes = []

    def put(self, request, permit_id):
        payload = TrackSerializer(data=request.query_params)
        payload.is_valid(raise_exception=True)
        if request.content_type != "audio/wav":
            raise VoiceprintError("voiceprint_content_type_invalid", status=415)
        raw_length = request.headers.get("Content-Length", "")
        if not raw_length:
            raise VoiceprintError("voiceprint_length_required", status=411)
        if (
            not raw_length.isascii()
            or not raw_length.isdecimal()
            or len(raw_length) > 6
        ):
            raise VoiceprintError("voiceprint_audio_size_invalid", status=413)
        length = int(raw_length)
        if not 1 <= length <= MAX_AUDIO_BYTES:
            raise VoiceprintError("voiceprint_audio_size_invalid", status=413)
        body = request.stream.read(length + 1)
        if len(body) != length:
            raise VoiceprintError("voiceprint_audio_size_invalid", status=413)
        receipt = service.ingest(
            permit_id,
            **payload.validated_data,
            token=request.headers.get("X-Voiceprint-Permit-Token", ""),
            wav=body,
        )
        return Response(receipt, status=202)
