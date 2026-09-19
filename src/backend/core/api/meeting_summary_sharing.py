"""Preview and confirm scoped record sharing; no messages or media grants."""

from django.conf import settings
from django.http import Http404
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.api.meeting_command_receipt import MeetingCommandReceiptMixin
from core.api.meeting_records import RecordPagination
from core.services import meeting_summary_sharing as service
from core.services.meeting_records import RecordConflict, visible_records


class ShareThrottle(UserRateThrottle):
    scope = "summary_sharing"
    rate = "30/min"


class Selection(serializers.Serializer):
    user_ids = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=service.MAX_RECIPIENTS
    )
    operation = serializers.ChoiceField(choices=["grant", "revoke"])
    access_scope = serializers.ChoiceField(
        choices=["summary", "transcript"], default="summary"
    )

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields) or len(attrs["user_ids"]) != len(
            set(attrs["user_ids"])
        ):
            raise serializers.ValidationError(
                "Select distinct users and supported fields."
            )
        return attrs


class Confirmation(Selection):
    expected_hash = serializers.RegexField(r"^[a-f0-9]{64}$")


class Base(MeetingCommandReceiptMixin, APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ShareThrottle]

    def record(self, request, record_id, *, manager=True):
        if not settings.MEETING_RECORDS_ENABLED:
            raise Http404
        record = get_object_or_404(
            visible_records(request.user, ability="read_summary"), pk=record_id
        )
        if manager and not service.can_manage(record, request.user):
            raise PermissionDenied
        return record

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response


class SummarySharingView(Base):
    def get(self, request, record_id):
        record = self.record(request, record_id, manager=False)
        may_manage = service.can_manage(record, request.user)
        if not may_manage:
            return Response(
                {
                    "available": False,
                    "can_manage": False,
                    "results": [],
                    "next_cursor": None,
                }
            )
        if set(request.query_params) - {"cursor", "page_size"}:
            raise serializers.ValidationError("Unsupported sharing filter.")
        pager = RecordPagination()
        pager.ordering = ("created_at", "id")
        page = pager.paginate_queryset(record.accesses.select_related("user"), request)
        result = pager.get_paginated_response(
            [
                {
                    "id": str(row.user_id),
                    "name": row.user.full_name or "",
                    "active": row.user.is_active,
                    "read_summary": row.read_summary,
                    "read_transcript": row.read_transcript,
                }
                for row in page
            ]
        )
        self.record(request, record_id)
        result.data.update(
            available=service.enabled(),
            can_manage=True,
            supported_scopes=["summary", "transcript"],
        )
        return result

    def post(self, request, record_id):
        self.record(request, record_id)
        payload = Confirmation(data=request.data)
        payload.is_valid(raise_exception=True)
        key = serializers.UUIDField().run_validation(
            request.headers.get("Idempotency-Key")
        )
        try:
            receipt, replay = service.apply_share(
                record_id, request.user, key, **payload.validated_data
            )
        except PermissionError:
            return Response(status=403)
        except (RecordConflict, ValueError):
            return Response({"code": "sharing_preview_changed"}, status=409)
        self.record(request, record_id)
        return Response(
            {
                "request_id": str(receipt.pk),
                "replayed": replay,
                "applied_preview": receipt.preview,
            }
        )


class SummarySharingPreviewView(Base):
    def post(self, request, record_id):
        record = self.record(request, record_id)
        if not service.enabled():
            return Response(status=403)
        payload = Selection(data=request.data)
        payload.is_valid(raise_exception=True)
        try:
            result = service.preview(record, request.user, **payload.validated_data)
        except PermissionError:
            return Response(status=403)
        except (RecordConflict, ValueError):
            return Response({"code": "sharing_selection_changed"}, status=409)
        self.record(request, record_id)
        return Response(result)


class SummarySharingCandidatesView(Base):
    def get(self, request, record_id):
        record = self.record(request, record_id)
        if not service.enabled():
            return Response(status=403)
        if set(request.query_params) - {"q", "scope", "cursor", "page_size"}:
            raise serializers.ValidationError("Unsupported candidate filter.")
        scope = serializers.ChoiceField(
            choices=["directory", "participants"]
        ).run_validation(request.query_params.get("scope", "directory"))
        query = serializers.CharField(max_length=80, allow_blank=True).run_validation(
            request.query_params.get("q", "")
        )
        users = service.eligible_users(record, request.user)
        if scope == "participants":
            users = (
                users.filter(
                    pk__in=models.MeetingParticipation.objects.filter(
                        session_id=record.meeting_session_id, user__isnull=False
                    ).values("user_id")
                )
                if record.meeting_session_id
                else users.none()
            )
        if query:
            users = users.filter(full_name__icontains=query)
        pager = RecordPagination()
        pager.ordering = ("full_name", "id")
        page = pager.paginate_queryset(users, request)
        self.record(request, record_id)
        return pager.get_paginated_response(
            [{"id": str(user.pk), "name": user.full_name or ""} for user in page]
        )
