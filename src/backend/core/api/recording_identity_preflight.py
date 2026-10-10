"""Owner's explicit response to a failed pre-paid import identity check."""

from django.shortcuts import get_object_or_404

from rest_framework import serializers
from rest_framework.response import Response

from core import models
from core.api.uploaded_recordings import UploadThrottle
from core.api.voiceprint import PrivateVoiceprintView, StrictSerializer, StrictVersion
from core.services import recording_identity_preflight as service
from core.services import uploaded_recordings as uploads
from core.services.meeting_records import RecordConflict


class DecisionSerializer(StrictSerializer):
    expected_attempt = StrictVersion(min_value=1)
    action = serializers.ChoiceField(
        choices=["retry_identity", "continue_without_identity"]
    )


class RecordingIdentityPreflightView(PrivateVoiceprintView):
    throttle_classes = [UploadThrottle]
    http_method_names = ["post", "options"]

    def post(self, request, record_id):
        service.expected_owner(
            request.user, request.headers.get("X-Voiceprint-Owner"), {}
        )
        get_object_or_404(
            models.UploadedRecording,
            record_id=record_id,
            record__owner=request.user,
            record__deleted_at__isnull=True,
        )
        payload = DecisionSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        try:
            job = service.decide(
                record_id,
                request.user,
                attempt=payload.validated_data["expected_attempt"],
                action=payload.validated_data["action"],
            )
        except RecordConflict:
            return Response({"code": "transcription_conflict"}, status=409)
        return Response(uploads.serialize(job), status=202)
