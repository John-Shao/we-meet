"""Exact-source record reads and opt-in user-authorized summary requests."""

from urllib.parse import parse_qs, urlsplit

from django.conf import settings
from django.core.exceptions import ValidationError as ModelValidationError
from django.db import IntegrityError
from django.http import Http404

from rest_framework import pagination, permissions, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from core import models
from core.services.asr_observations import observation_status, snapshot_asr_status
from core.services.meeting_records import (
    RecordConflict,
    filter_record_scope,
    record_capabilities,
    visible_records,
)
from core.services.meeting_summary_requests import (
    SummaryRequestDenied,
    request_summary,
    requests_enabled,
    serialize_summary_job,
)
from core.services.meeting_summary_versions import source_payload, summary_readiness


class SummaryRequestThrottle(UserRateThrottle):
    """Bound explicit, potentially billable user requests independently of reads."""

    scope = "meeting_summary_requests"
    rate = "6/min"


class SummaryRequestSerializer(serializers.Serializer):
    """An explicit operation against the revision/job state the user reviewed."""

    operation = serializers.ChoiceField(choices=["generate", "regenerate", "retry"])
    stage = serializers.ChoiceField(
        choices=["realtime", "quick", "final"], required=False
    )
    expected_revision = serializers.IntegerField(min_value=1)
    expected_job_id = serializers.UUIDField(allow_null=True)
    expected_attempt = serializers.IntegerField(min_value=1, allow_null=True)

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise ValidationError("Unsupported summary request field.")
        if (attrs["expected_job_id"] is None) != (attrs["expected_attempt"] is None):
            raise ValidationError("Job ID and attempt must be supplied together.")
        if attrs["expected_job_id"] is not None:
            attrs["expected_job_id"] = str(attrs["expected_job_id"])
        return attrs


class LegacyRecordSourceSerializer(serializers.Serializer):
    """Only explicit source IDs are accepted; no arbitrary URLs or slugs."""

    room_id = serializers.UUIDField(required=False)
    meeting_session_id = serializers.UUIDField(required=False)
    summary_id = serializers.UUIDField(required=False)

    def validate(self, attrs):
        """Allow room + session for old deep links, reject ambiguous selectors."""
        if not attrs or ("summary_id" in attrs and len(attrs) != 1):
            raise ValidationError(
                "Supply room_id, meeting_session_id, both, or summary_id alone."
            )
        if set(self.initial_data) - set(self.fields):
            raise ValidationError("Unsupported source selector.")
        return attrs


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

    def get_throttles(self):
        """Polling does not consume the generation request allowance."""
        return (
            [SummaryRequestThrottle()]
            if self.action == "summary_requests"
            else super().get_throttles()
        )

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
        scope = self.request.query_params.get("scope", "recent")
        if scope not in {"recent", "owned", "participated", "shared"}:
            raise ValidationError({"scope": "Unsupported record scope."})
        queryset = filter_record_scope(queryset, self.request.user, scope)
        source = self.request.query_params.get("source_type")
        if source:
            if source not in models.MeetingRecord.Source.values:
                raise ValidationError({"source_type": "Unsupported source type."})
            queryset = queryset.filter(source_type=source)
        session_id = self.request.query_params.get("meeting_session_id")
        room_id = self.request.query_params.get("room_id")
        if room_id:
            queryset = queryset.filter(
                meeting_session__room_id=serializers.UUIDField().run_validation(room_id)
            )
        if session_id:
            field = serializers.UUIDField()
            queryset = queryset.filter(
                meeting_session_id=field.run_validation(session_id)
            )
        query = self.request.query_params.get("q", "").strip()
        if len(query) > 200:
            raise ValidationError({"q": "Search text exceeds 200 characters."})
        return queryset.filter(title__icontains=query) if query else queryset

    @action(detail=False, methods=["get"])
    def resolve(self, request):
        """Resolve old links without creating records or choosing a latest session."""
        selector = LegacyRecordSourceSerializer(data=request.query_params)
        selector.is_valid(raise_exception=True)
        source = selector.validated_data
        rows = self.get_queryset()
        if "summary_id" in source:
            summary = (
                models.Summary.objects.filter(
                    pk=source["summary_id"],
                    session_id__in=visible_records(
                        request.user, ability="read_summary"
                    ).values("meeting_session_id"),
                )
                .select_related("session")
                .first()
            )
            if summary is None or summary.session.room_id != summary.room_id:
                raise Http404
            rows = rows.filter(meeting_session_id=summary.session_id)
        else:
            if "room_id" in source:
                rows = rows.filter(meeting_session__room_id=source["room_id"])
            if "meeting_session_id" in source:
                rows = rows.filter(meeting_session_id=source["meeting_session_id"])
        record = rows.first()
        if record is None:
            raise Http404
        # Keep this exact row after checking ambiguity; never re-query "latest".
        if (
            set(source) == {"room_id"}
            and models.MeetingSession.objects.filter(room_id=source["room_id"])
            .exclude(pk=record.meeting_session_id)
            .exists()
        ):
            return Response(
                {
                    "code": "ambiguous_source",
                    "message": "This room has multiple sessions; select an explicit meeting session.",
                    "retryable": False,
                },
                status=409,
            )
        return Response(self.get_serializer(record).data)

    def _content_record(self, ability):
        record = self.get_object()
        if (
            not visible_records(self.request.user, ability=ability)
            .filter(pk=record.pk)
            .exists()
        ):
            raise PermissionDenied("This material has not been shared with you.")
        return record

    @action(detail=True, methods=["get"], url_path="summary-job")
    def summary_job(self, request, pk=None):
        """Read the latest job state for this exact record, with summary permission."""
        record = self._content_record("read_summary")
        job = (
            record.processing_jobs.filter(kind="summary")
            .order_by("-generation")
            .first()
        )
        readiness = summary_readiness(record)
        return Response(
            {
                "revision": record.revision,
                "job": serialize_summary_job(job),
                "generation_ready": "final" in readiness["ready_stages"],
                "staged_summaries_enabled": settings.MEETING_STAGED_SUMMARY_ENABLED,
                **readiness,
            }
        )

    @action(detail=True, methods=["post"], url_path="summary-requests")
    def summary_requests(self, request, pk=None):
        """Accept a durable, idempotent user intent and dispatch only after commit."""
        if not requests_enabled():
            raise Http404
        record = self._content_record("read_summary")
        key = serializers.UUIDField().run_validation(
            request.headers.get("Idempotency-Key")
        )
        serializer = SummaryRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            intent, replay = request_summary(
                record.pk, request.user, key, serializer.validated_data
            )
        except SummaryRequestDenied as exc:
            raise PermissionDenied(
                "Only current meeting owners and administrators can generate summaries."
            ) from exc
        except (RecordConflict, IntegrityError, ModelValidationError):
            return Response(
                {
                    "code": "summary_request_conflict",
                    "message": "Refresh the record and job before submitting a new request.",
                },
                status=409,
            )
        intent.refresh_from_db()
        intent.job.refresh_from_db()
        return Response(
            {
                "request_id": str(intent.pk),
                "replayed": replay,
                "dispatch_state": intent.dispatch_state,
                "job": serialize_summary_job(intent.job),
            },
            status=202,
        )

    @action(detail=True, methods=["get"], url_path="summary-versions")
    def summary_versions(self, request, pk=None):
        """Expose immutable AI versions without disclosing the input transcript."""
        record = self._content_record("read_summary")
        try:
            fingerprint = source_payload(record, require_ended=False)[1]
        except RecordConflict:
            fingerprint = None
        latest = (
            record.processing_jobs.filter(kind="summary")
            .order_by("-generation")
            .first()
        )
        rows = record.summary_versions.select_related("job", "input_snapshot")
        pager = RecordPagination()
        pager.ordering = ("-created_at", "-id")
        page = pager.paginate_queryset(rows, request, view=self)
        return pager.get_paginated_response(
            [
                {
                    "id": str(version.pk),
                    "stage": version.stage,
                    "coverage_status": version.job.result.get(
                        "coverage_status", "unverified"
                    ),
                    "content": version.content,
                    "delivery_status": version.input_snapshot.delivery.get(
                        "status", "unverified"
                    ),
                    "asr_status": snapshot_asr_status(version.input_snapshot.delivery),
                    "model_used": version.model_used,
                    "created_at": version.created_at,
                    "input_revision": version.input_snapshot.revision,
                    "input_snapshot_id": str(version.input_snapshot_id),
                    "source_observed_at": version.input_snapshot.created_at,
                    "source_segment_count": len(version.input_snapshot.segments),
                    "source_through_ms": max(
                        row["end_ms"] if row["end_ms"] is not None else row["start_ms"]
                        for row in version.input_snapshot.segments
                    ),
                    "is_current": bool(
                        latest
                        and latest.pk == version.job_id
                        and record.revision == version.input_snapshot.revision
                        and fingerprint == version.input_snapshot.fingerprint
                    ),
                }
                for version in page
            ]
        )

    @action(
        detail=True,
        methods=["get"],
        url_path=r"transcript-versions/(?P<version_id>[0-9a-f-]{36})",
    )
    def transcript_version(self, request, pk=None, version_id=None):
        """Historical citations read their own immutable text, with original-text ACL."""
        record = self._content_record("read_transcript")
        version = record.transcript_versions.filter(
            pk=serializers.UUIDField().run_validation(version_id)
        ).first()
        if version is None:
            raise Http404
        return Response(
            {
                "id": str(version.pk),
                "revision": version.revision,
                "segments": version.segments,
                "delivery": version.delivery,
            }
        )

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

    @action(detail=True, methods=["get"], url_path="original-segments")
    def original_segments(self, request, pk=None):
        """Native standalone originals retain their own identity and source offsets."""
        if not settings.MEETING_CAPTURE_PROTOCOL_ENABLED:
            raise Http404
        record = self._content_record("read_transcript")
        rows = record.original_segments.select_related("speaker")
        speaker_id = request.query_params.get("speaker_id")
        if speaker_id:
            rows = rows.filter(
                speaker_id=serializers.UUIDField().run_validation(speaker_id)
            )
        pager = RecordPagination()
        pager.ordering = ("start_ms", "id")
        page = pager.paginate_queryset(rows, request, view=self)
        return pager.get_paginated_response(
            [
                {
                    "id": str(row.pk),
                    "revision": row.revision,
                    "capture_session_id": str(row.capture_session_id),
                    "source_track_id": row.source_track_id,
                    "source_sequence": row.source_sequence,
                    "start_ms": row.start_ms,
                    "end_ms": row.end_ms,
                    "speaker_id": str(row.speaker_id),
                    "speaker_label": row.speaker.label,
                    "text": row.text,
                    "language": row.language,
                }
                for row in page
            ]
        )

    @action(detail=True, methods=["get"], url_path="source-status")
    def source_status(self, request, pk=None):
        """Read bounded source observations without exposing transcript material."""
        record = self._content_record("read_summary")
        rows = (
            models.TranscriptDelivery.objects.filter(
                session_id=record.meeting_session_id
            )
            if record.meeting_session_id
            else models.TranscriptDelivery.objects.none()
        )
        pager = RecordPagination()
        pager.ordering = ("created_at", "id")
        page = pager.paginate_queryset(rows, request, view=self)
        return pager.get_paginated_response(
            [
                {
                    "id": str(row.pk),
                    "reported_delivery_status": row.state,
                    "asr_status": observation_status(row.source_report),
                    "source_report": row.source_report,
                    "coverage_status": "unverified",
                    "source_scope": "agent_observed_audio",
                }
                for row in page
            ]
        )

    @action(detail=True, methods=["get"])
    def speakers(self, request, pk=None):
        """Speaker labels are original-text material, not summary metadata."""
        if not settings.MEETING_CAPTURE_PROTOCOL_ENABLED:
            raise Http404
        record = self._content_record("read_transcript")
        pager = RecordPagination()
        pager.ordering = ("created_at", "id")
        page = pager.paginate_queryset(record.speakers.all(), request, view=self)
        return pager.get_paginated_response(
            [
                {
                    "id": str(row.pk),
                    "label": row.label,
                    "identity_type": row.identity_type,
                }
                for row in page
            ]
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
