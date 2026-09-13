"""Retained translations require original-material access, never attendance alone."""

from django.conf import settings
from django.db.models import Q
from django.http import Http404
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models
from core.api.agent_internal import AgentTokenAuthentication, HasAgentToken
from core.api.meeting_records import RecordPagination
from core.api.online_capture import CaptureSourceSerializer
from core.services.meeting_records import RecordConflict, visible_records
from core.services.translation_archives import append_segment


class SegmentInput(CaptureSourceSerializer):
    channel_id = serializers.UUIDField()
    generation = serializers.IntegerField(min_value=1)
    worker_id = serializers.UUIDField()
    source_participation_id = serializers.UUIDField()
    source_participant_sid = serializers.RegexField(r"^PA_[A-Za-z0-9_-]{1,61}$")
    direction = serializers.ChoiceField(choices=["forward"])
    response_id = serializers.CharField(max_length=128, trim_whitespace=False)
    item_id = serializers.CharField(max_length=128, trim_whitespace=False)
    text = serializers.CharField(max_length=20000, trim_whitespace=False)


class NoStore(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response


class TranslationSegmentIngestView(NoStore):
    authentication_classes = [AgentTokenAuthentication]
    permission_classes = [HasAgentToken]

    def post(self, request):
        serializer = SegmentInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            result = append_segment(data["channel_id"], data)
        except models.MeetingInterpretationChannel.DoesNotExist:
            raise Http404 from None
        except RecordConflict:
            return Response({"code": "translation_archive_conflict"}, status=409)
        return Response(result)


class ArchivePagination(RecordPagination):
    ordering = ("-created_at", "-id")


class SegmentPagination(RecordPagination):
    page_size = 50
    ordering = ("sequence", "id")


def _record(user, record_id):
    if (
        not settings.MEETING_RECORDS_ENABLED
        or not models.User.objects.filter(pk=user.pk, is_active=True).exists()
    ):
        raise Http404
    return get_object_or_404(
        visible_records(user, ability="read_transcript"), pk=record_id
    )


def _archives(user, record):
    return record.translation_archives.filter(
        Q(source_kind="channel") | Q(source_kind="private", owner=user)
    )


def _query(request, allowed):
    if set(request.query_params) - allowed or any(
        len(request.query_params.getlist(key)) != 1 for key in request.query_params
    ):
        raise serializers.ValidationError("Unsupported translation query.")


class RecordTranslationArchivesView(NoStore):
    def get(self, request, record_id):
        _query(request, {"cursor"})
        record = _record(request.user, record_id)
        pager = ArchivePagination()
        rows = pager.paginate_queryset(
            _archives(request.user, record), request, view=self
        )
        result = [
            {
                "id": str(row.pk),
                "source_kind": row.source_kind,
                "generation": row.generation,
                "target": row.configuration["target"],
                "status": row.status,
                "segment_count": row.segment_count,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ]
        _record(request.user, record_id)
        return pager.get_paginated_response(result)


class RecordTranslationSegmentsView(NoStore):
    def get(self, request, record_id):
        _query(request, {"archive_id", "cursor"})
        selector = serializers.UUIDField().run_validation(
            request.query_params.get("archive_id")
        )
        record = _record(request.user, record_id)
        archive = get_object_or_404(_archives(request.user, record), pk=selector)
        pager = SegmentPagination()
        rows = pager.paginate_queryset(archive.segments.all(), request, view=self)
        result = [
            {
                "id": str(row.pk),
                "sequence": row.sequence,
                "source_participation_id": str(row.source_participation_id),
                "source_participant_sid": row.source_participant_sid,
                "direction": row.direction,
                "target": row.target,
                "text": row.text,
                "received_at": row.created_at.isoformat(),
                "timing_basis": "delivery",
                "original_id": None,
            }
            for row in rows
        ]
        _record(request.user, record_id)
        return pager.get_paginated_response(result)
