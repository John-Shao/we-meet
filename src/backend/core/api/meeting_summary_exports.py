"""Explicit document preview and durable intent; no external writes in HTTP views."""

from django.conf import settings
from django.core import signing
from django.core.exceptions import ValidationError as ModelValidationError
from django.db import IntegrityError
from django.db.models import Q
from django.http import Http404
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core.api.meeting_command_receipt import MeetingCommandReceiptMixin
from core.services import meeting_summary_exports as service
from core.services.meeting_records import RecordConflict, visible_records
from core.services.summary_export_delivery import retry_export


class ExportSelection(serializers.Serializer):
    """Choose an immutable version; never accept user supplied rendered content."""

    source_kind = serializers.ChoiceField(choices=["ai", "human"])
    source_id = serializers.UUIDField()
    language = serializers.ChoiceField(choices=["zh", "en"])

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unsupported export field.")
        attrs["source_id"] = str(attrs["source_id"])
        return attrs


class ExportThrottle(UserRateThrottle):
    scope = "meeting_summary_exports"
    rate = "6/min"


class ExportRequest(ExportSelection):
    """Confirm the exact preview bytes, including title and owner identity."""

    expected_hash = serializers.RegexField(r"^[a-f0-9]{64}$")


class SummaryExportView(MeetingCommandReceiptMixin, APIView):
    """Only the requesting owner/manager sees their own export receipts."""

    permission_classes = [permissions.IsAuthenticated]

    def get_throttles(self):
        return [ExportThrottle()] if self.request.method == "POST" else []

    def record(self, request, record_id):
        if not settings.MEETING_RECORDS_ENABLED:
            raise Http404
        return get_object_or_404(
            visible_records(request.user, ability="read_summary"), pk=record_id
        )

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response

    def get(self, request, record_id):
        record = self.record(request, record_id)
        rows = record.document_exports.filter(requested_by=request.user).order_by(
            "-created_at", "-id"
        )
        params = request.query_params.copy()
        cursor = params.pop("cursor", None)
        filters = {}
        if params:
            selection = ExportSelection(data=params)
            selection.is_valid(raise_exception=True)
            filters = selection.validated_data
            rows = rows.filter(**filters)
        scope = [str(request.user.pk), str(record.pk), filters]
        salt = "meeting-document-export-history-v1"
        if cursor is not None:
            try:
                if len(cursor) != 1 or not cursor[0] or len(cursor[0]) > 2048:
                    raise ValueError
                position = signing.loads(cursor[0], salt=salt)
                if position["scope"] != scope:
                    raise ValueError
                created = serializers.DateTimeField().run_validation(
                    position["created"]
                )
                row_id = serializers.UUIDField().run_validation(position["id"])
            except (signing.BadSignature, ValueError, KeyError, TypeError) as exc:
                raise serializers.ValidationError(
                    {"cursor": "Invalid history cursor."}
                ) from exc
            rows = rows.filter(
                Q(created_at__lt=created) | Q(created_at=created, id__lt=row_id)
            )
        page = list(rows[:11])
        next_cursor = None
        if len(page) > 10:
            last = page[9]
            next_cursor = signing.dumps(
                {
                    "scope": scope,
                    "created": last.created_at.isoformat(),
                    "id": str(last.pk),
                },
                salt=salt,
            )
        # A page read is still a fresh authorization boundary after revocation.
        self.record(request, record_id)
        return Response(
            {
                "available": service.available()
                and service.can_export(record, request.user),
                "results": [service.serialize(row) for row in page[:10]],
                "next_cursor": next_cursor,
            }
        )

    def post(self, request, record_id):
        self.record(request, record_id)
        selection = ExportRequest(data=request.data)
        selection.is_valid(raise_exception=True)
        expected_hash = selection.validated_data.pop("expected_hash")
        key = serializers.UUIDField().run_validation(
            request.headers.get("Idempotency-Key")
        )
        try:
            export, replayed = service.request_export(
                record_id, request.user, key, selection.validated_data, expected_hash
            )
        except PermissionError:
            return Response(status=403)
        except (RecordConflict, IntegrityError, ModelValidationError):
            return Response({"code": "export_conflict"}, status=409)
        except ValueError:
            return Response({"code": "export_source_unavailable"}, status=400)
        self.record(request, record_id)
        return Response(
            {"export": service.serialize(export), "replayed": replayed}, status=202
        )


class SummaryExportPreviewView(SummaryExportView):
    """A reviewable copy from the same renderer used when freezing an export."""

    http_method_names = ["get", "head", "options"]

    def get(self, request, record_id):
        record = self.record(request, record_id)
        if not service.can_export(record, request.user):
            return Response(status=403)
        selection = ExportSelection(data=request.query_params)
        selection.is_valid(raise_exception=True)
        try:
            _, _, payload = service.render_payload(
                record, request.user, selection.validated_data
            )
        except RecordConflict:
            return Response({"code": "export_conflict"}, status=409)
        except ValueError:
            return Response({"code": "export_source_unavailable"}, status=400)
        self.record(request, record_id)
        return Response(
            {
                "title": payload["title"],
                "markdown": payload["content"],
                "payload_hash": service.digest(payload),
                **selection.validated_data,
            }
        )


class RetrySelection(serializers.Serializer):
    expected_attempt = serializers.IntegerField(min_value=1, max_value=20)
    expected_hash = serializers.RegexField(r"^[a-f0-9]{64}$")

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unsupported retry field.")
        return attrs


class SummaryExportRetryView(SummaryExportView):
    """Preview the frozen copy, then explicitly recover the same remote request."""

    def get(self, request, record_id, export_id):
        record = self.record(request, record_id)
        if not service.can_export(record, request.user):
            return Response(status=403)
        export = get_object_or_404(
            record.document_exports, pk=export_id, requested_by=request.user
        )
        self.record(request, record_id)
        return Response(
            {
                "export": service.serialize(export),
                "title": export.payload["title"],
                "markdown": export.payload["content"],
                "payload_hash": export.payload_hash,
            }
        )

    def post(self, request, record_id, export_id):
        self.record(request, record_id)
        selection = RetrySelection(data=request.data)
        selection.is_valid(raise_exception=True)
        key = serializers.UUIDField().run_validation(
            request.headers.get("Idempotency-Key")
        )
        try:
            export, replayed = retry_export(
                record_id, export_id, request.user, key, **selection.validated_data
            )
        except PermissionError:
            return Response(status=403)
        except (RecordConflict, IntegrityError, ModelValidationError):
            return Response({"code": "export_conflict"}, status=409)
        except ValueError:
            return Response({"code": "export_configuration_changed"}, status=409)
        self.record(request, record_id)
        return Response(
            {"export": service.serialize(export), "replayed": replayed}, status=202
        )
