"""Read-only record APIs; old room endpoints remain compatible during migration."""

from urllib.parse import parse_qs, urlsplit

from django.conf import settings
from django.http import Http404

from rest_framework import pagination, permissions, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from core import models
from core.services.meeting_records import record_capabilities, visible_records


class RecordPagination(pagination.CursorPagination):
    """Stable pagination after access filtering, with a bounded page size."""

    page_size = 30
    ordering = ("-origin_at", "-id")

    def get_paginated_response(self, data):
        """Return the cursor token rather than an origin-dependent URL."""
        url = self.get_next_link()
        cursor = parse_qs(urlsplit(url).query).get("cursor", [None])[0] if url else None
        return Response({"results": data, "next_cursor": cursor})


class MeetingRecordSerializer(serializers.ModelSerializer):
    """Metadata only; never embed privileged media URLs or transcript snippets."""

    capabilities = serializers.SerializerMethodField()
    source_available = serializers.SerializerMethodField()

    class Meta:
        model = models.MeetingRecord
        fields = [
            "id",
            "source_type",
            "meeting_session_id",
            "source_session_id",
            "title",
            "origin_at",
            "retention_mode",
            "revision",
            "source_available",
            "capabilities",
        ]
        read_only_fields = fields

    def get_capabilities(self, obj):
        """Resolve current access, not the role at record creation time."""
        return record_capabilities(obj, self.context["request"].user)

    def get_source_available(self, obj):
        """An orphaned meeting record must not link to another session."""
        return (
            obj.source_type != models.MeetingRecord.Source.MEETING
            or obj.meeting_session_id is not None
        )


class RecordTranscriptSerializer(serializers.ModelSerializer):
    """Expose only material authorized through the record and exact session."""

    class Meta:
        model = models.Transcript
        fields = [
            "id",
            "session_id",
            "speaker_identity",
            "speaker_name",
            "text",
            "language",
            "started_at",
            "ended_at",
        ]


class TranscriptPagination(RecordPagination):
    """Paginate transcript rows in chronological order."""

    ordering = ("started_at", "id")


class MeetingRecordViewSet(viewsets.ReadOnlyModelViewSet):
    """Opt-in metadata and exact-source content reads for the new workspaces."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = MeetingRecordSerializer
    pagination_class = RecordPagination

    def finalize_response(self, request, response, *args, **kwargs):
        """Meeting content must not survive revocation in an HTTP cache."""
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response

    def initial(self, request, *args, **kwargs):
        """Keep the new interface disabled until its schema/backfill is ready."""
        if not getattr(settings, "MEETING_RECORDS_ENABLED", False):
            raise Http404
        return super().initial(request, *args, **kwargs)

    def get_queryset(self):
        """Scope every detail and list query before applying user filters."""
        queryset = visible_records(self.request.user).select_related(
            "meeting_session__room"
        )
        if self.action != "list":
            return queryset
        source = self.request.query_params.get("source_type")
        if source:
            if source not in models.MeetingRecord.Source.values:
                raise ValidationError({"source_type": "Unsupported source type."})
            queryset = queryset.filter(source_type=source)
        session_id = self.request.query_params.get("meeting_session_id")
        if session_id:
            field = serializers.UUIDField()
            queryset = queryset.filter(
                meeting_session_id=field.run_validation(session_id)
            )
        query = self.request.query_params.get("q", "").strip()
        if len(query) > 200:
            raise ValidationError({"q": "Search text exceeds 200 characters."})
        return queryset.filter(title__icontains=query) if query else queryset

    def _content_record(self, ability):
        record = self.get_object()
        if (
            not visible_records(self.request.user, ability=ability)
            .filter(pk=record.pk)
            .exists()
        ):
            raise PermissionDenied("This material has not been shared with you.")
        return record

    @action(detail=True, methods=["get"])
    def transcripts(self, request, pk=None):
        """Never fall back to another session when the requested one is empty."""
        record = self._content_record("read_transcript")
        rows = models.Transcript.objects.none()
        if record.meeting_session_id:
            rows = models.Transcript.objects.filter(
                session_id=record.meeting_session_id,
                room_id=record.meeting_session.room_id,
            )
        pager = TranscriptPagination()
        page = pager.paginate_queryset(rows, request, view=self)
        return pager.get_paginated_response(
            RecordTranscriptSerializer(page, many=True).data
        )

    @action(detail=True, methods=["get"])
    def summaries(self, request, pk=None):
        """Read the legacy summary as a source-scoped compatibility artifact."""
        record = self._content_record("read_summary")
        summary = None
        if record.meeting_session_id:
            summary = models.Summary.objects.filter(
                session_id=record.meeting_session_id,
                room_id=record.meeting_session.room_id,
            ).first()
        if summary is None:
            return Response({"results": []})
        return Response(
            {
                "results": [
                    {
                        "id": str(summary.id),
                        "session_id": str(summary.session_id),
                        "status": summary.status,
                        "content": summary.effective_content,
                        "is_edited": summary.is_edited,
                        "model_used": summary.model_used,
                        "updated_at": summary.updated_at,
                        "legacy": True,
                    }
                ]
            }
        )
