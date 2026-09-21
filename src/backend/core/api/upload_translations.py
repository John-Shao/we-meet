"""Upload translation products follow current original-material permissions."""

from django.db import IntegrityError
from django.http import Http404, HttpResponse
from django.shortcuts import get_object_or_404

from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from core import models
from core.api.meeting_command_receipt import MeetingCommandReceiptMixin
from core.api.translation_archives import NoStore
from core.services import transcript_export
from core.services import upload_translations as service
from core.services.meeting_records import RecordConflict, visible_records


class TranslationInput(serializers.Serializer):
    key = serializers.UUIDField()
    target = serializers.ChoiceField(choices=list(service.LANGUAGES))
    expected_revision = serializers.IntegerField(min_value=1)

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unsupported translation field.")
        return attrs


class TranslationThrottle(UserRateThrottle):
    scope = "upload_translations"
    rate = "6/min"


class UploadTranslationView(MeetingCommandReceiptMixin, NoStore):
    def get_throttles(self):
        return [TranslationThrottle()] if self.request.method == "POST" else []

    def record(self, request, record_id):
        if not service.readable(request.user, record_id):
            raise Http404
        return get_object_or_404(
            visible_records(request.user, ability="read_transcript"), pk=record_id
        )

    def get(self, request, record_id, translation_id=None):
        record = self.record(request, record_id)
        service.expire()
        if translation_id is None:
            result = {
                "can_generate": record.owner_id == request.user.pk
                and service.available()
                and models.UploadedRecording.objects.filter(
                    record=record, status="succeeded"
                ).exists(),
                "revision": record.revision,
                "results": [
                    service.serialize(job, record)
                    for job in record.upload_translations.defer(
                        "source", "content", "configuration"
                    ).order_by("-created_at", "-id")[:30]
                ],
            }
        else:
            job = get_object_or_404(record.upload_translations, pk=translation_id)
            try:
                page = int(request.query_params.get("page", "0"))
                if not 0 <= page <= 40:
                    raise ValueError
            except ValueError:
                return Response({"code": "invalid_page"}, status=400)
            rows = []
            if job.status == "succeeded":
                rows = [
                    {**row, "translated_text": translated}
                    for row, translated in zip(job.source, job.content, strict=True)
                ]
            result = {
                **service.serialize(job, record),
                "results": rows[page * 50 : (page + 1) * 50],
                "next_page": page + 1 if (page + 1) * 50 < len(rows) else None,
            }
        self.record(request, record_id)
        return Response(result)

    def post(self, request, record_id, translation_id=None):
        if translation_id is not None:
            return Response(status=405)
        self.record(request, record_id)
        serializer = TranslationInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            job = service.prepare(
                record_id,
                request.user,
                data["key"],
                data["target"],
                data["expected_revision"],
            )
        except PermissionError:
            return Response(status=403)
        except (RecordConflict, IntegrityError):
            return Response({"code": "translation_conflict"}, status=409)
        except ValueError as exc:
            return Response({"code": str(exc)}, status=400)
        record = self.record(request, record_id)
        return Response(service.serialize(job, record), status=202)


class UploadTranslationExportView(UploadTranslationView):
    def post(self, request, record_id, translation_id=None):
        return Response(status=405)

    def get(self, request, record_id, translation_id):
        record = self.record(request, record_id)
        job = get_object_or_404(record.upload_translations, pk=translation_id)
        if job.status != "succeeded" or job.input_revision != record.revision:
            return Response({"code": "translation_not_current"}, status=409)
        fmt = request.query_params.get("as", "txt")
        if fmt not in transcript_export.FORMATS:
            return Response({"code": "unsupported_format"}, status=400)
        rows = [
            transcript_export.TranscriptRow(
                row["start_ms"], row["end_ms"], row["speaker_name"], text
            )
            for row, text in zip(job.source, job.content, strict=True)
        ]
        body = transcript_export.render(fmt, rows)
        current = self.record(request, record_id)
        if current.revision != job.input_revision:
            return Response({"code": "translation_not_current"}, status=409)
        response = HttpResponse(
            body, content_type=transcript_export.CONTENT_TYPES[fmt][1]
        )
        response["Content-Disposition"] = (
            f'attachment; filename="translation-{job.target}-{job.pk}.{fmt}"'
        )
        return response
