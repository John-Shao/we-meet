"""Calendar export jobs and expiring CSV downloads."""

from __future__ import annotations

import secrets
from datetime import timedelta

from django.conf import settings
from django.http import FileResponse
from django.utils import timezone

from rest_framework import decorators, exceptions, serializers, status, viewsets
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from core import models
from core.api import permissions
from core.api.feature_flag import FeatureFlag
from core.services import calendar_access, calendar_time
from core.tasks.calendar_exports import generate_calendar_export


class CalendarExportJobSerializer(serializers.ModelSerializer):
    calendar_id = serializers.UUIDField(source="calendar.id", read_only=True)
    # django-timezone-field exposes a ZoneInfo instance on model objects. DRF's
    # inferred ModelField leaves it untouched, which makes the JSON renderer
    # fail after the export job has already been queued.
    timezone = serializers.CharField(read_only=True)
    download_url = serializers.SerializerMethodField()
    document_url = serializers.SerializerMethodField()

    class Meta:
        model = models.CalendarExportJob
        fields = [
            "id",
            "calendar_id",
            "range_start",
            "range_end",
            "timezone",
            "status",
            "row_count",
            "document_id",
            "document_url",
            "download_url",
            "error_code",
            "error_detail",
            "created_at",
            "started_at",
            "completed_at",
        ]

    def get_download_url(self, obj):
        request = self.context.get("request")
        if (
            not obj.csv_file
            or request is None
            or obj.csv_expires_at is None
            or obj.csv_expires_at <= timezone.now()
        ):
            return None
        return request.build_absolute_uri(
            f"/api/{settings.API_VERSION}/calendar-exports/{obj.id}/download/"
            f"?token={obj.csv_token}"
        )

    def get_document_url(self, obj):
        if not obj.document_id:
            return None
        cfg = getattr(settings, "DOCS_CONFIGURATION", None) or {}
        base = str(cfg.get("api_url") or "").rstrip("/")
        return f"{base}/docs/{obj.document_id}/" if base else None


class CalendarExportCreateSerializer(serializers.Serializer):
    range = serializers.ChoiceField(choices=("today", "week", "month", "custom"))
    start = serializers.DateField(required=False)
    end = serializers.DateField(required=False)
    timezone = serializers.CharField(required=False, allow_blank=False)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if attrs["range"] == "custom" and ("start" not in attrs or "end" not in attrs):
            raise serializers.ValidationError("custom range requires start and end")
        if "start" in attrs and "end" in attrs:
            if attrs["end"] < attrs["start"]:
                raise serializers.ValidationError({"end": "end must be on or after start"})
            if attrs["end"] - attrs["start"] > timedelta(days=365):
                raise serializers.ValidationError("custom range is limited to 366 days")
        if attrs.get("timezone"):
            try:
                calendar_time.parse_zone(attrs["timezone"])
            except Exception as exc:
                raise serializers.ValidationError({"timezone": "invalid IANA timezone"}) from exc
        return attrs


def _resolve_range(user, data):
    zone_name = data.get("timezone") or str(
        calendar_time.effective_calendar_timezone(user)
    )
    zone = calendar_time.parse_zone(zone_name)
    today = timezone.now().astimezone(zone).date()
    choice = data["range"]
    if choice == "today":
        return today, today, zone_name
    if choice == "month":
        first = today.replace(day=1)
        next_month = (
            first.replace(year=first.year + 1, month=1)
            if first.month == 12
            else first.replace(month=first.month + 1)
        )
        return first, next_month - timedelta(days=1), zone_name
    if choice == "week":
        preference, _ = models.CalendarPreference.objects.get_or_create(user=user)
        sunday = preference.week_start == models.CalendarWeekStartChoices.SUNDAY
        weekday = (today.weekday() + 1) % 7 if sunday else today.weekday()
        start = today - timedelta(days=weekday)
        return start, start + timedelta(days=6), zone_name
    return data["start"], data["end"], zone_name


def create_calendar_export(request, calendar):
    if not getattr(settings, "CELERY_ENABLED", False):
        raise exceptions.ValidationError(
            {"detail": "Calendar export requires an enabled background worker."}
        )
    cfg = getattr(settings, "DOCS_CONFIGURATION", None) or {}
    if not cfg.get("api_url") or not cfg.get("server_to_server_token"):
        raise exceptions.ValidationError(
            {"detail": "Calendar export requires the Docs integration."}
        )
    if not calendar_access.calendar_can_manage(calendar, request.user):
        raise exceptions.PermissionDenied()
    serializer = CalendarExportCreateSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    start, end, zone_name = _resolve_range(request.user, serializer.validated_data)
    job = models.CalendarExportJob.objects.create(
        calendar=calendar,
        requester=request.user,
        range_start=start,
        range_end=end,
        timezone=zone_name,
        csv_token=secrets.token_urlsafe(48),
        csv_expires_at=timezone.now() + timedelta(days=90),
    )
    generate_calendar_export.delay(str(job.id))
    return Response(
        CalendarExportJobSerializer(job, context={"request": request}).data,
        status=status.HTTP_202_ACCEPTED,
    )


class CalendarExportJobViewSet(viewsets.ReadOnlyModelViewSet):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = CalendarExportJobSerializer
    pagination_class = None

    def get_queryset(self):
        return models.CalendarExportJob.objects.filter(
            requester=self.request.user
        ).select_related("calendar")

    def get_permissions(self):
        if self.action == "download":
            return [AllowAny()]
        return super().get_permissions()

    @decorators.action(detail=True, methods=["get"])
    @FeatureFlag.require("calendar_export")
    def download(self, request, pk=None):
        job = models.CalendarExportJob.objects.filter(pk=pk).first()
        if (
            job is None
            or not job.csv_file
            or job.csv_expires_at is None
            or job.csv_expires_at <= timezone.now()
        ):
            raise exceptions.NotFound()
        authenticated_owner = (
            getattr(request.user, "is_authenticated", False)
            and request.user.id == job.requester_id
        )
        token = str(request.query_params.get("token") or "")
        valid_token = (
            bool(token)
            and bool(job.csv_token)
            and secrets.compare_digest(token, job.csv_token)
        )
        if not authenticated_owner and not valid_token:
            raise exceptions.PermissionDenied()
        return FileResponse(
            job.csv_file.open("rb"),
            as_attachment=True,
            filename=f"calendar-{job.range_start}-{job.range_end}.csv",
            content_type="text/csv; charset=utf-8",
        )
