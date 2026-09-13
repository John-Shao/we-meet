"""Private retained recording translations without synthetic meeting participants."""

from django.http import Http404
from django.shortcuts import get_object_or_404

from rest_framework import serializers

from core import models
from core.api.capture_audio import CaptureAudioView
from core.api.translation_archives import ArchivePagination, SegmentPagination
from core.services import capture_translation


class CaptureTranslationArchivesView(CaptureAudioView):
    http_method_names = ["get", "options"]

    def owned_capture(self, request, capture_id):
        capture = self.capture(request, capture_id)
        try:
            capture_translation.state(capture_id, request.user)
        except PermissionError:
            raise Http404 from None
        return capture

    def get(self, request, capture_id):
        if set(request.query_params) - {"cursor"}:
            raise serializers.ValidationError("Unsupported translation query.")
        capture = self.owned_capture(request, capture_id)
        pager = ArchivePagination()
        rows = pager.paginate_queryset(
            models.MeetingTranslationArchive.objects.filter(
                record_id=capture.record_id,
                owner=request.user,
                source_kind="capture",
                configuration__capture_id=str(capture.pk),
            ),
            request,
            view=self,
        )
        result = [
            {
                "id": str(row.pk),
                "run_id": str(row.source_id),
                "capture_id": str(capture.pk),
                "generation": row.generation,
                "configuration": {
                    key: value
                    for key, value in row.configuration.items()
                    if key != "capture_id"
                },
                "status": row.status,
                "segment_count": row.segment_count,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ]
        self.owned_capture(request, capture_id)
        response = pager.get_paginated_response(result)
        response.data.update(
            capture_id=str(capture.pk), record_id=str(capture.record_id)
        )
        return response


class CaptureTranslationSegmentsView(CaptureTranslationArchivesView):
    def get(self, request, capture_id, archive_id):
        if set(request.query_params) - {"cursor"}:
            raise serializers.ValidationError("Unsupported translation query.")
        capture = self.owned_capture(request, capture_id)
        archive = get_object_or_404(
            models.MeetingTranslationArchive,
            pk=archive_id,
            source_kind="capture",
            record_id=capture.record_id,
            owner=request.user,
            configuration__capture_id=str(capture.pk),
        )
        pager = SegmentPagination()
        rows = pager.paginate_queryset(archive.segments.all(), request, view=self)
        result = [
            {
                "id": str(row.pk),
                "sequence": row.sequence,
                "source_capture_id": str(row.source_capture_id),
                "direction": row.direction,
                "target": row.target,
                "text": row.text,
                "received_at": row.created_at.isoformat(),
                "timing_basis": "delivery",
                "original_id": None,
            }
            for row in rows
        ]
        self.owned_capture(request, capture_id)
        response = pager.get_paginated_response(result)
        response.data.update(
            capture_id=str(capture.pk),
            record_id=str(capture.record_id),
            archive_id=str(archive.pk),
            archive_status=archive.status,
            run_id=str(archive.source_id),
            generation=archive.generation,
        )
        return response
