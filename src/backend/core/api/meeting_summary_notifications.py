"""Private completion status and visible defaults, independent from AI generation status."""

from django.conf import settings
from django.core.exceptions import ValidationError as ModelValidationError
from django.db import IntegrityError
from django.http import Http404
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core.api.meeting_command_receipt import MeetingCommandReceiptMixin
from core.services import meeting_summary_notifications as service
from core.services.meeting_records import RecordConflict, visible_records
from core.services.meeting_summary_exports import can_export
from core.services.summary_notification_delivery import retry_notification


class SummaryNotificationsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, record_id):
        if not settings.MEETING_RECORDS_ENABLED:
            raise Http404
        records = visible_records(request.user, ability="read_summary")
        record = get_object_or_404(records, pk=record_id)
        rows = record.summary_notifications.filter(recipient=request.user).order_by(
            "-created_at", "-id"
        )
        if set(request.query_params) - {"summary_id"}:
            raise serializers.ValidationError("Unsupported notification filter.")
        if "summary_id" in request.query_params:
            rows = rows.filter(
                summary_id=serializers.UUIDField().run_validation(
                    request.query_params["summary_id"]
                )
            )
        result = {
            "available": service.available(),
            "strategy": "owners_and_initiators"
            if record.meeting_session_id
            else "owner",
            "legacy_delivery_unchanged": True,
            "results": [service.serialize(row) for row in rows[:10]],
        }
        if can_export(record, request.user):
            try:
                candidates = service.recipient_candidates(record, request.user.pk)
            except RecordConflict:
                candidates = []
                result["policy_error"] = "recipient_selection_failed"
            result["future_recipients"] = [
                {"id": str(user.pk), "name": user.full_name or ""}
                for user in candidates
            ]
        get_object_or_404(records, pk=record_id)
        return Response(result, headers={"Cache-Control": "private, no-store"})


class NotificationRetryInput(serializers.Serializer):
    expected_attempt = serializers.IntegerField(min_value=1, max_value=20)

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unsupported retry field.")
        return attrs


class NotificationRetryThrottle(UserRateThrottle):
    scope = "summary_notification_retry"
    rate = "6/min"


class SummaryNotificationRetryView(MeetingCommandReceiptMixin, APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [NotificationRetryThrottle]

    def post(self, request, record_id, notice_id):
        if not settings.MEETING_RECORDS_ENABLED:
            raise Http404
        records = visible_records(request.user, ability="read_summary")
        get_object_or_404(records, pk=record_id)
        payload = NotificationRetryInput(data=request.data)
        payload.is_valid(raise_exception=True)
        key = serializers.UUIDField().run_validation(
            request.headers.get("Idempotency-Key")
        )
        try:
            row, replay = retry_notification(
                record_id, notice_id, request.user, key, **payload.validated_data
            )
        except PermissionError:
            return Response(status=403)
        except (RecordConflict, IntegrityError, ModelValidationError):
            return Response({"code": "notification_conflict"}, status=409)
        except ValueError:
            return Response({"code": "notification_configuration_changed"}, status=409)
        get_object_or_404(records, pk=record_id)
        return Response(
            {"notification": service.serialize(row), "replayed": replay},
            status=202,
            headers={"Cache-Control": "private, no-store"},
        )
