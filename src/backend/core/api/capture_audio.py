"""Authenticated binary WAV uploads, bounded receipts and explicit storage sealing."""

from django.http import HttpResponse
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.services import capture_audio as service
from core.services.meeting_captures import CaptureDenied
from core.services.meeting_records import RecordConflict, visible_records


class ChunkSerializer(serializers.Serializer):
    """No user-controlled paths, encodings, sample rates or ownership fields."""

    device_id = serializers.CharField(max_length=128)
    sequence = serializers.IntegerField(min_value=1, max_value=service.MAX_CHUNKS)
    start_ms = serializers.IntegerField(min_value=0, max_value=43200000)
    checksum = serializers.RegexField(r"^[a-f0-9]{64}$")
    audio = serializers.FileField()


class SealSerializer(serializers.Serializer):
    """Declare the last locally numbered chunk, including any upload gaps."""

    device_id = serializers.CharField(max_length=128)
    final_sequence = serializers.IntegerField(min_value=0, max_value=service.MAX_CHUNKS)
    client_interrupted = serializers.BooleanField(default=False)


class CaptureAudioView(APIView):
    """Reading source audio requires both current original-text access and ownership."""

    permission_classes = [permissions.IsAuthenticated]

    def capture(self, request, capture_id):
        user = get_object_or_404(models.User, pk=request.user.pk, is_active=True)
        return get_object_or_404(
            models.CaptureSession.objects.filter(
                created_by=user,
                record_id__in=visible_records(user, ability="read_transcript").values(
                    "pk"
                ),
            ),
            pk=capture_id,
        )

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response

    def get(self, request, capture_id):
        capture = self.capture(request, capture_id)
        after = serializers.IntegerField(
            min_value=0, max_value=service.MAX_CHUNKS
        ).run_validation(request.query_params.get("after_sequence", 0))
        rows = list(
            capture.audio_chunks.filter(sequence__gt=after).order_by("sequence")[:101]
        )
        manifest = getattr(capture, "audio_manifest", None)
        return Response(
            {
                "results": [service.serialize_chunk(row) for row in rows[:100]],
                "next_after_sequence": rows[99].sequence if len(rows) > 100 else None,
                "manifest": service.serialize_manifest(manifest) if manifest else None,
            }
        )


class AudioUploadThrottle(UserRateThrottle):
    """Five-second chunks leave room for retry while bounding upload request churn."""

    scope = "capture_audio_upload"
    rate = "120/min"


class CaptureAudioUploadView(CaptureAudioView):
    """Uploads are multipart and strictly bounded before reading into memory."""

    parser_classes = [MultiPartParser, FormParser]
    throttle_classes = [AudioUploadThrottle]
    http_method_names = ["post", "options"]

    def post(self, request, capture_id):  # noqa: PLR0911 -- distinct safe wire error categories
        capture = self.capture(request, capture_id)
        serializer = ChunkSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        if set(request.data) - set(serializer.fields):
            return Response(status=400)
        data = serializer.validated_data
        upload = data.pop("audio")
        if upload.size > service.MAX_BYTES:
            return Response(status=413)
        audio = upload.read(service.MAX_BYTES + 1)
        lease = serializers.UUIDField().run_validation(
            request.headers.get("X-Capture-Lease")
        )
        try:
            chunk = service.prepare(capture.pk, request.user, lease, data, audio)
            chunk = service.store(
                chunk.pk, request.user, lease, data["device_id"], audio
            )
        except CaptureDenied:
            return Response(status=403)
        except RecordConflict:
            return Response(status=409)
        except ValueError:
            return Response({"detail": "Invalid audio or checksum."}, status=400)
        except Exception:  # noqa: BLE001 -- a storage failure is retryable with the same numbered body
            return Response(
                {"detail": "Audio storage is unavailable; retry the same chunk."},
                status=503,
            )
        return Response(service.serialize_chunk(chunk))


class CaptureAudioSealView(CaptureAudioView):
    """Store a manifest separately from the capture's control finalization."""

    http_method_names = ["post", "options"]

    def post(self, request, capture_id):
        capture = self.capture(request, capture_id)
        serializer = SealSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        if set(request.data) - set(serializer.fields):
            return Response(status=400)
        lease = serializers.UUIDField().run_validation(
            request.headers.get("X-Capture-Lease")
        )
        try:
            manifest = service.seal(
                capture.pk, request.user, lease, serializer.validated_data
            )
        except CaptureDenied:
            return Response(status=403)
        except RecordConflict:
            return Response(status=409)
        return Response(service.serialize_manifest(manifest))


class CaptureAudioDownloadView(CaptureAudioView):
    """Serve one verified small chunk, never a public or long-lived presigned URL."""

    http_method_names = ["get", "head", "options"]

    def get(self, request, capture_id, chunk_id):
        capture = self.capture(request, capture_id)
        chunk = get_object_or_404(capture.audio_chunks, pk=chunk_id, stored=True)
        try:
            audio = service.read_verified(chunk)
        except Exception:  # noqa: BLE001 -- storage errors never expose object keys or credentials
            return Response({"detail": "Audio is unavailable."}, status=503)
        self.capture(request, capture_id)
        response = HttpResponse(audio, content_type="audio/wav")
        response["Content-Disposition"] = 'attachment; filename="recording-chunk.wav"'
        response["X-Content-Type-Options"] = "nosniff"
        return response
