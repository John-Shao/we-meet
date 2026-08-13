"""OAuth account lifecycle, calendar selection, sync, conflict retry and webhooks."""

from __future__ import annotations

import secrets

from django.conf import settings
from django.http import HttpResponse, HttpResponseRedirect
from django.utils import timezone

from rest_framework import decorators, exceptions, mixins, serializers, status, viewsets
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models
from core.api import permissions
from core.api.directory import get_caller_organization
from core.api.feature_flag import FeatureFlag
from core.services import external_calendars
from core.tasks.external_calendars import (
    deliver_calendar_outbox,
    sync_external_calendar,
)


class ExternalCalendarAccountSerializer(serializers.ModelSerializer):
    bindings = serializers.SerializerMethodField()

    class Meta:
        model = models.ExternalCalendarAccount
        fields = ["id", "provider", "email", "status", "error_code", "bindings", "created_at"]

    def get_bindings(self, obj):
        return [
            {
                "id": str(row.id),
                "calendar_id": str(row.calendar_id),
                "remote_calendar_id": row.remote_calendar_id,
                "name": row.remote_name,
                "is_primary": row.is_primary,
                "sync_status": row.sync_status,
                "error_code": row.error_code,
                "last_synced_at": row.last_synced_at,
            }
            for row in obj.bindings.select_related("calendar").all()
        ]


def _require_async_sync():
    if not getattr(settings, "CELERY_ENABLED", False):
        raise exceptions.APIException(
            "External calendar sync is unavailable until Celery is configured."
        )


class ExternalCalendarAccountViewSet(
    mixins.DestroyModelMixin, viewsets.ReadOnlyModelViewSet
):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = ExternalCalendarAccountSerializer
    pagination_class = None

    def get_queryset(self):
        return models.ExternalCalendarAccount.objects.filter(
            owner=self.request.user
        ).prefetch_related("bindings__calendar")

    @decorators.action(detail=False, methods=["post"])
    @FeatureFlag.require("external_calendar_sync")
    def authorize(self, request):
        _require_async_sync()
        provider_name = str(request.data.get("provider") or "")
        if provider_name not in ("google", "microsoft"):
            raise exceptions.ValidationError({"provider": "expected google | microsoft"})
        redirect_uri = request.build_absolute_uri(
            f"/api/{settings.API_VERSION}/external-calendars/oauth/{provider_name}/callback/"
        )
        url = external_calendars.provider(provider_name).authorization_url(
            str(request.user.id), redirect_uri
        )
        return Response({"authorization_url": url})

    @decorators.action(detail=True, methods=["get", "post"], url_path="calendars")
    @FeatureFlag.require("external_calendar_sync")
    def calendars(self, request, pk=None):
        account = self.get_object()
        adapter = external_calendars.provider(account.provider)
        if request.method == "GET":
            selected = set(account.bindings.values_list("remote_calendar_id", flat=True))
            return Response(
                [
                    {"id": item.id, "name": item.name, "primary": item.primary, "selected": item.id in selected}
                    for item in adapter.calendars(account)
                ]
            )
        _require_async_sync()
        raw = request.data.get("calendar_ids")
        if not isinstance(raw, list) or not raw:
            raise exceptions.ValidationError({"calendar_ids": "a non-empty list is required"})
        bindings = external_calendars.create_bindings(account, [str(value) for value in raw])
        for binding in bindings:
            sync_external_calendar.delay(str(binding.id))
        return Response(self.get_serializer(account).data, status=status.HTTP_201_CREATED)

    @decorators.action(detail=True, methods=["post"])
    @FeatureFlag.require("external_calendar_sync")
    def sync(self, request, pk=None):
        _require_async_sync()
        account = self.get_object()
        for binding_id in account.bindings.values_list("id", flat=True):
            sync_external_calendar.delay(str(binding_id))
        return Response(status=status.HTTP_202_ACCEPTED)

    def destroy(self, request, pk=None):
        if not FeatureFlag.flag_is_active("external_calendar_sync"):
            raise exceptions.NotFound()
        self.get_object().delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class CalendarSyncOutboxViewSet(viewsets.ReadOnlyModelViewSet):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = serializers.Serializer
    pagination_class = None

    def get_queryset(self):
        return models.CalendarSyncOutbox.objects.filter(
            binding__account__owner=self.request.user
        )

    def list(self, request):
        rows = self.get_queryset().filter(status__in=("conflict", "failed"))
        return Response(
            [
                {
                    "id": str(row.id),
                    "event_id": str(row.event_id) if row.event_id else None,
                    "operation": row.operation,
                    "status": row.status,
                    "attempts": row.attempts,
                    "last_error": row.last_error,
                }
                for row in rows
            ]
        )

    @decorators.action(detail=True, methods=["post"])
    def retry(self, request, pk=None):
        _require_async_sync()
        row = self.get_object()
        row.status = "pending"
        row.next_attempt_at = timezone.now()
        row.save(update_fields=["status", "next_attempt_at", "updated_at"])
        deliver_calendar_outbox.delay(str(row.id))
        return Response(status=status.HTTP_202_ACCEPTED)


class ExternalCalendarOAuthCallbackView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request, provider):
        if request.query_params.get("error"):
            raise exceptions.ValidationError({"provider": str(request.query_params.get("error"))})
        adapter = external_calendars.provider(provider)
        token_payload, state_data = adapter.exchange(
            str(request.query_params.get("code") or ""),
            str(request.query_params.get("state") or ""),
        )
        user = models.User.objects.filter(pk=state_data["user_id"], is_active=True).first()
        if user is None:
            raise exceptions.NotFound()
        organization = get_caller_organization(user)
        if organization is None:
            raise exceptions.ValidationError("No active organization membership.")
        account = external_calendars.store_account(
            user,
            organization,
            provider,
            token_payload,
            adapter.identity(token_payload["access_token"]),
        )
        calendars = adapter.calendars(account)
        if request.query_params.get("format") != "json":
            return HttpResponseRedirect(
                f"/calendar?external_account={account.id}&external=connected"
            )
        return Response(
            {
                "account": ExternalCalendarAccountSerializer(account).data,
                "calendars": [
                    {"id": row.id, "name": row.name, "primary": row.primary}
                    for row in calendars
                ],
            }
        )


class ExternalCalendarWebhookView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request, provider):
        if provider == "microsoft" and request.query_params.get("validationToken"):
            return HttpResponse(
                str(request.query_params["validationToken"]), content_type="text/plain"
            )
        return Response(status=status.HTTP_204_NO_CONTENT)

    def post(self, request, provider):
        if provider == "microsoft" and request.query_params.get("validationToken"):
            return HttpResponse(
                str(request.query_params["validationToken"]),
                content_type="text/plain",
            )
        binding_ids = set()
        if provider == "google":
            channel_id = str(request.headers.get("X-Goog-Channel-ID") or "")
            token = str(request.headers.get("X-Goog-Channel-Token") or "")
            binding = models.ExternalCalendarBinding.objects.filter(
                account__provider="google", webhook_id=channel_id
            ).first()
            if binding and secrets.compare_digest(binding.webhook_secret, token):
                binding_ids.add(binding.id)
        elif provider == "microsoft":
            notices = request.data.get("value", []) if isinstance(request.data, dict) else []
            for notice in notices:
                binding = models.ExternalCalendarBinding.objects.filter(
                    account__provider="microsoft",
                    webhook_id=str(notice.get("subscriptionId") or ""),
                ).first()
                if binding and secrets.compare_digest(
                    binding.webhook_secret, str(notice.get("clientState") or "")
                ):
                    binding_ids.add(binding.id)
        else:
            raise exceptions.NotFound()
        for binding_id in binding_ids:
            sync_external_calendar.delay(str(binding_id))
        return Response(status=status.HTTP_202_ACCEPTED)
