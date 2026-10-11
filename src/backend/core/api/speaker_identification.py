"""Authenticated editor/media and library-scoped record identification."""

from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from core.api.voiceprint import PrivateVoiceprintView, StrictSerializer, StrictVersion
from core.services import speaker_identification as service
from core.services import speaker_identification_directory as directory
from core.services.meeting_records import RecordConflict


class Submission(StrictSerializer):
    request_key = serializers.UUIDField()
    expected_revision = StrictVersion(min_value=1)
    organization_id = serializers.UUIDField(allow_null=True)
    user_ids = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=50
    )
    speaker_ids = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=50, required=False
    )


class ReadRequest(StrictSerializer):
    request_key = serializers.UUIDField(required=False)


class Cancellation(StrictSerializer):
    request_key = serializers.UUIDField()
    expected_revision = StrictVersion(min_value=1)


class SubmissionThrottle(UserRateThrottle):
    scope = "speaker_identification_requests"
    rate = "6/min"


class SpeakerIdentificationView(PrivateVoiceprintView):
    http_method_names = ["get", "post", "delete", "options"]

    def get_throttles(self):
        return [SubmissionThrottle()] if self.request.method == "POST" else []

    def handle_exception(self, exc):
        if isinstance(exc, RecordConflict):
            return Response({"code": str(exc)}, status=409)
        return super().handle_exception(exc)

    def get(self, request, record_id):
        serializer = ReadRequest(data=request.query_params)
        serializer.is_valid(raise_exception=True)
        return Response(
            service.read(record_id, request.user, **serializer.validated_data)
        )

    def post(self, request, record_id):
        serializer = Submission(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(
            service.submit(record_id, request.user, **serializer.validated_data),
            status=202,
        )

    def delete(self, request, record_id):
        serializer = Cancellation(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(
            service.cancel(record_id, request.user, **serializer.validated_data)
        )


class OptionsQuery(StrictSerializer):
    expected_revision = serializers.IntegerField(min_value=1)
    offset = serializers.IntegerField(
        min_value=0, max_value=directory.MAX_OFFSET, default=0
    )


class CandidateQuery(OptionsQuery):
    organization_id = serializers.CharField()
    q = serializers.CharField(max_length=80, allow_blank=True, default="")

    def validate_organization_id(self, value):
        return (
            None
            if value == "personal"
            else serializers.UUIDField().run_validation(value)
        )


class DirectoryThrottle(UserRateThrottle):
    scope = "speaker_identification_directory"
    rate = "60/min"


class SpeakerIdentificationOptionsView(SpeakerIdentificationView):
    http_method_names = ["get", "options"]

    def get_throttles(self):
        return [DirectoryThrottle()]

    def get(self, request, record_id):
        serializer = OptionsQuery(data=request.query_params)
        serializer.is_valid(raise_exception=True)
        return Response(
            directory.options(record_id, request.user, **serializer.validated_data)
        )


class SpeakerIdentificationCandidatesView(SpeakerIdentificationOptionsView):
    def get(self, request, record_id):
        serializer = CandidateQuery(data=request.query_params)
        serializer.is_valid(raise_exception=True)
        parameters = dict(serializer.validated_data)
        parameters["query"] = parameters.pop("q")
        return Response(directory.lookup(record_id, request.user, **parameters))
