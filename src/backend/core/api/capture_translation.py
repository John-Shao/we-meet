"""Owner-only standalone translation control, separate from original ASR ingestion."""

from django.core.exceptions import ValidationError as ModelValidationError
from django.db import IntegrityError

from rest_framework import serializers
from rest_framework.response import Response

from core.api.capture_audio import AudioUploadThrottle, CaptureAudioView
from core.api.cloud_recording import CloudRecordingStartThrottle
from core.services import capture_translation as service
from core.services.meeting_records import RecordConflict


class ConfigurationSerializer(serializers.Serializer):
    source_language = serializers.ChoiceField(choices=service.LANGUAGES)
    target_language = serializers.ChoiceField(choices=service.LANGUAGES)
    mode = serializers.ChoiceField(choices=["simultaneous", "push_to_talk"])
    audio = serializers.BooleanField()
    save_translations = serializers.BooleanField()

    def validate(self, attrs):
        if set(self.initial_data if hasattr(self, "initial_data") else attrs) - set(
            self.fields
        ):
            raise serializers.ValidationError("Unknown translation configuration.")
        if attrs["source_language"] == attrs["target_language"]:
            raise serializers.ValidationError("Choose distinct languages.")
        return attrs


class ControlSerializer(serializers.Serializer):
    key = serializers.UUIDField()
    device_id = serializers.CharField(max_length=128)
    operation = serializers.ChoiceField(choices=["start", "stop"])
    expected_revision = serializers.IntegerField(min_value=1)
    expected_run_id = serializers.UUIDField(allow_null=True)
    configuration = ConfigurationSerializer(allow_null=True)

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unknown translation control field.")
        if isinstance(self.initial_data.get("configuration"), dict) and set(
            self.initial_data["configuration"]
        ) - set(ConfigurationSerializer().fields):
            raise serializers.ValidationError("Unknown translation configuration.")
        if (attrs["operation"] == "start") != (attrs["configuration"] is not None):
            raise serializers.ValidationError("Only start accepts configuration.")
        return attrs


class TranslationStartThrottle(CloudRecordingStartThrottle):
    scope = "capture_translation_starts"


class CaptureTranslationView(CaptureAudioView):
    throttle_classes = [AudioUploadThrottle]
    http_method_names = ["get", "post", "options"]

    def get_throttles(self):
        if self.request.method == "POST":
            return (
                [TranslationStartThrottle()]
                if self.request.data.get("operation") == "start"
                else []
            )
        return super().get_throttles()

    def get(self, request, capture_id):
        self.capture(request, capture_id)
        try:
            return Response(service.state(capture_id, request.user))
        except PermissionError:
            return Response(status=404)

    def post(self, request, capture_id):
        self.capture(request, capture_id)
        serializer = ControlSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        key = data.pop("key")
        data["expected_run_id"] = (
            str(data["expected_run_id"]) if data["expected_run_id"] else None
        )
        lease = serializers.UUIDField().run_validation(
            request.headers.get("X-Capture-Lease")
        )
        try:
            command, replayed, current = service.control(
                capture_id, request.user, lease, key, data
            )
        except PermissionError:
            return Response(status=404)
        except (RecordConflict, ModelValidationError, IntegrityError):
            return Response(
                {"detail": "Translation intent conflicts; refresh its state."},
                status=409,
            )
        return Response(
            {
                "command": service.serialize_command(command),
                "current": current,
                "replayed": replayed,
            },
            status=200 if replayed else 202,
        )
