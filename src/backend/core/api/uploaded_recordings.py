"""Authenticated recording uploads and owner-only transcription controls."""

from django.conf import settings
from django.core.files.uploadhandler import StopUpload, TemporaryFileUploadHandler
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.parsers import JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.services import recording_upload_sessions
from core.services import uploaded_recordings as service
from core.services.meeting_records import RecordConflict, visible_records


class UploadSerializer(serializers.Serializer):
    """No arbitrary URLs or storage keys enter the provider pipeline."""

    key = serializers.UUIDField()
    audio = serializers.FileField()
    context = serializers.CharField(max_length=400, allow_blank=True, default="")
    hotwords = serializers.CharField(max_length=4000, allow_blank=True, default="")
    diarization = serializers.BooleanField(default=False)

    def validate_hotwords(self, value):
        """One temporary vocabulary per recording, with bounded word lengths."""
        try:
            return service.parse_hotwords(value)
        except ValueError as error:
            raise serializers.ValidationError(str(error)) from error


class DirectUploadPresignSerializer(serializers.Serializer):
    """Declare the exact object we are about to sign for.

    ``size`` is bound into the presigned PUT signature, so this is a ceiling the
    storage service enforces rather than a hint the server trusts.
    """

    key = serializers.UUIDField()
    name = serializers.CharField(max_length=255)
    size = serializers.IntegerField(min_value=1)
    content_type = serializers.CharField(max_length=128)
    context = serializers.CharField(max_length=400, allow_blank=True, default="")
    hotwords = serializers.CharField(max_length=4000, allow_blank=True, default="")
    diarization = serializers.BooleanField(default=False)

    def validate_hotwords(self, value):
        return UploadSerializer().validate_hotwords(value)


class DirectUploadCompleteSerializer(serializers.Serializer):
    """The same declaration, plus the storage key the server handed out.

    Written out rather than subclassed so the absence of an ``audio`` body is
    structural, not something a future edit can silently reintroduce.
    """

    key = serializers.UUIDField()
    name = serializers.CharField(max_length=255)
    size = serializers.IntegerField(min_value=1)
    content_type = serializers.CharField(max_length=128)
    storage_name = serializers.CharField(max_length=500)
    context = serializers.CharField(max_length=400, allow_blank=True, default="")
    hotwords = serializers.CharField(max_length=4000, allow_blank=True, default="")
    diarization = serializers.BooleanField(default=False)

    def validate_hotwords(self, value):
        return UploadSerializer().validate_hotwords(value)


class UploadThrottle(UserRateThrottle):
    scope = "recording_file_upload"
    rate = "6/min"


class UploadReadThrottle(UserRateThrottle):
    """Progress polling must not consume the paid-action limit."""

    scope = "recording_file_read"
    rate = "60/min"


class BoundedUploadHandler(TemporaryFileUploadHandler):
    """Bound disk usage even when a client omits or lies about Content-Length."""

    def receive_data_chunk(self, raw_data, start):
        if start + len(raw_data) > settings.MEETING_FILE_ASR_MAX_BYTES:
            self.request.upload_too_large = True
            raise StopUpload(connection_reset=True)
        return super().receive_data_chunk(raw_data, start)


class UploadedRecordingView(APIView):
    """Separate upload availability from reading already completed transcripts."""

    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, JSONParser]
    throttle_classes = [UploadThrottle]

    def initialize_request(self, request, *args, **kwargs):
        # Large multipart uploads always spool to disk, never a full in-memory body.
        request.upload_handlers = [BoundedUploadHandler(request)]
        return super().initialize_request(request, *args, **kwargs)

    def get_throttles(self):
        return [
            UploadReadThrottle() if self.request.method == "GET" else UploadThrottle()
        ]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response

    def get_job(self, request, record_id):
        return get_object_or_404(
            models.UploadedRecording.objects.filter(
                record__owner=request.user,
                record_id__in=visible_records(
                    request.user, ability="read_transcript"
                ).values("pk"),
            ),
            record_id=record_id,
        )

    def get(self, request, record_id=None):
        if record_id:
            return Response(service.serialize(self.get_job(request, record_id)))
        get_object_or_404(models.User, pk=request.user.pk, is_active=True)
        direct = service.direct_upload_available()
        return Response(
            {
                "available": service.available(),
                "max_bytes": settings.MEETING_FILE_ASR_MAX_BYTES,
                # When direct uploads are on, callers should use the larger
                # presigned path; the multipart ceiling still applies to the
                # legacy body-upload branch.
                "direct_upload_available": direct,
                "direct_max_bytes": (
                    service.direct_upload_max_bytes() if direct else 0
                ),
                # Above the chunked threshold a client should use the resumable
                # multipart endpoints rather than one all-or-nothing PUT.
                "multipart_upload_available": direct,
                "multipart_part_size": (
                    recording_upload_sessions.PART_SIZE if direct else 0
                ),
                "extensions": sorted(service.EXTENSIONS),
            }
        )

    def post(self, request, record_id=None):  # noqa: PLR0911 -- explicit upload/retry error statuses
        if not service.available() or not request.user.is_active:
            return Response({"code": "file_transcription_unavailable"}, status=503)
        try:
            if record_id:
                self.get_job(request, record_id)
                attempt = serializers.IntegerField(min_value=1).run_validation(
                    request.data.get("attempt")
                )
                job = service.retry(record_id, request.user, attempt)
            else:
                length = request.META.get("CONTENT_LENGTH")
                if length and int(length) > settings.MEETING_FILE_ASR_MAX_BYTES + 65536:
                    return Response(status=413)
                data = request.data
                if getattr(request, "upload_too_large", False):
                    return Response(status=413)
                serializer = UploadSerializer(data=data)
                serializer.is_valid(raise_exception=True)
                data = dict(serializer.validated_data)
                upload = data.pop("audio")
                if upload.size > settings.MEETING_FILE_ASR_MAX_BYTES:
                    return Response(status=413)
                job = service.create(request.user, data.pop("key"), upload, data)
        except RecordConflict:
            return Response({"code": "transcription_conflict"}, status=409)
        except ValueError:
            return Response({"code": "invalid_audio_file"}, status=400)
        # Beat is the durable dispatcher: a broker outage cannot lose this request.
        return Response(service.serialize(job), status=202)


class DirectUploadBase(APIView):
    """Shared gating and error mapping for the two-step presigned flow."""

    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [JSONParser]
    throttle_classes = [UploadThrottle]
    serializer_class = DirectUploadPresignSerializer

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response

    def post(self, request):
        if not service.direct_upload_available() or not request.user.is_active:
            return Response({"code": "direct_upload_unavailable"}, status=503)
        serializer = self.serializer_class(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        options = {
            "context": data.pop("context"),
            "hotwords": data.pop("hotwords"),
            "diarization": data.pop("diarization"),
        }
        try:
            return self.handle(request.user, data, options)
        except RecordConflict:
            return Response({"code": "transcription_conflict"}, status=409)
        except ValueError:
            return Response({"code": "invalid_audio_file"}, status=400)


class DirectUploadPresignView(DirectUploadBase):
    """Sign one PUT for an exact byte count, bound into the signature."""

    serializer_class = DirectUploadPresignSerializer

    def handle(self, user, data, options):
        return Response(service.presign_direct_upload(user, **data, options=options))


class DirectUploadCompleteView(DirectUploadBase):
    """Adopt the uploaded object after verifying it against that declaration."""

    serializer_class = DirectUploadCompleteSerializer

    def handle(self, user, data, options):
        job = service.complete_direct_upload(user, **data, options=options)
        return Response(service.serialize(job), status=202)
