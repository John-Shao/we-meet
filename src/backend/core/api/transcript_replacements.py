"""Editor-only replacement previews, durable receipts and guarded undo."""

from django.conf import settings
from django.http import Http404
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core.services import transcript_replacements as service
from core.services.meeting_records import (
    RecordConflict,
    can_edit_transcript,
    visible_records,
)


class Selection(serializers.Serializer):
    """Preserve whitespace: replacement is literal, not a normalized search."""

    find = serializers.CharField(max_length=200, trim_whitespace=False)
    replacement = serializers.CharField(
        max_length=200, allow_blank=True, trim_whitespace=False
    )


class Confirmation(Selection):
    """The key survives response loss; the hash binds the reviewed source."""

    key = serializers.UUIDField()
    expected_hash = serializers.RegexField(r"^[a-f0-9]{64}$")


class ReplacementThrottle(UserRateThrottle):
    scope = "transcript_replacement"
    rate = "30/min"


class TranscriptReplacementView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ReplacementThrottle]

    def record(self, request, record_id):
        if not settings.MEETING_RECORDS_ENABLED:
            raise Http404
        record = get_object_or_404(
            visible_records(request.user, ability="read_transcript"), pk=record_id
        )
        if not can_edit_transcript(record, request.user):
            raise PermissionDenied
        return record

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response

    def get(self, request, record_id):
        record = self.record(request, record_id)
        rows = list(record.transcript_replacements.order_by("-created_at", "-id")[:10])
        self.record(request, record_id)
        return Response({"results": [service.serialize(row) for row in rows]})

    def post(self, request, record_id, batch_id=None):
        record = self.record(request, record_id)
        try:
            if batch_id:
                result = service.serialize(service.undo(record, request.user, batch_id))
            else:
                is_preview = isinstance(self, TranscriptReplacementPreviewView)
                payload = (Selection if is_preview else Confirmation)(data=request.data)
                payload.is_valid(raise_exception=True)
                result = (
                    service.preview(record, request.user, **payload.validated_data)
                    if is_preview
                    else service.serialize(
                        service.apply(record, request.user, **payload.validated_data)
                    )
                )
        except PermissionError as error:
            raise PermissionDenied from error
        except LookupError as error:
            raise Http404 from error
        except RecordConflict as error:
            return Response({"code": str(error)}, status=409)
        except ValueError as error:
            raise ValidationError({"code": str(error)}) from error
        self.record(request, record_id)
        return Response(result)


class TranscriptReplacementPreviewView(TranscriptReplacementView):
    http_method_names = ["post", "options"]


class TranscriptReplacementUndoView(TranscriptReplacementView):
    http_method_names = ["post", "options"]
