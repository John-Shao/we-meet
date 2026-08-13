"""Unified calendar resources, discovery, ACLs, subscriptions, and share links."""

from __future__ import annotations

import uuid

from django.core import signing
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from rest_framework import decorators, exceptions, serializers, status, viewsets
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models, utils
from core.api import permissions
from core.api.calendar import CalendarEventSerializer, filter_calendar_window
from core.api.calendar_exports import create_calendar_export
from core.api.directory import get_caller_organization
from core.api.feature_flag import FeatureFlag
from core.services import calendar_access

SHARE_SALT = "we-meet.calendar-share.v1"
DEFAULT_COLORS = ("#3370ff", "#34c724", "#f54a45", "#f5a623", "#8b5cf6")


def _user_card(user):
    if user is None:
        return None
    return {
        "id": str(user.id),
        "full_name": user.full_name,
        "short_name": user.short_name,
        "avatar_url": utils.generate_profile_image_get_url("avatar", user.avatar_key),
    }


def _share_token(calendar):
    return signing.Signer(salt=SHARE_SALT).sign(
        f"{calendar.id}:{calendar.share_link_version}"
    )


def resolve_share_token(token):
    try:
        raw = signing.Signer(salt=SHARE_SALT).unsign(token)
        raw_id, raw_version = raw.rsplit(":", 1)
        calendar_id = uuid.UUID(raw_id)
        version = int(raw_version)
    except (signing.BadSignature, ValueError, TypeError, AttributeError) as exc:
        raise exceptions.NotFound() from exc
    calendar = (
        models.Calendar.objects.select_related(
            "owner", "organization", "meeting_room"
        )
        .filter(pk=calendar_id, share_link_version=version, deleted_at__isnull=True)
        .first()
    )
    if calendar is None or calendar.kind not in (
        models.CalendarKindChoices.PRIMARY,
        models.CalendarKindChoices.SHARED,
    ):
        raise exceptions.NotFound()
    return calendar


class CalendarSerializer(serializers.ModelSerializer):
    display_name = serializers.CharField(read_only=True)
    owner = serializers.SerializerMethodField()
    organization = serializers.SerializerMethodField()
    meeting_room = serializers.SerializerMethodField()
    effective_role = serializers.SerializerMethodField()
    effective_permission = serializers.SerializerMethodField()
    subscribed = serializers.SerializerMethodField()
    enabled = serializers.SerializerMethodField()
    color = serializers.SerializerMethodField()
    subscriber_count = serializers.SerializerMethodField()
    capabilities = serializers.SerializerMethodField()
    external_default_access = serializers.SerializerMethodField()

    class Meta:
        model = models.Calendar
        fields = [
            "id",
            "kind",
            "name",
            "display_name",
            "description",
            "owner",
            "organization",
            "meeting_room",
            "organization_default_access",
            "external_default_access",
            "effective_role",
            "effective_permission",
            "subscribed",
            "enabled",
            "color",
            "subscriber_count",
            "capabilities",
            "deleted_at",
        ]
        read_only_fields = [
            "id",
            "kind",
            "display_name",
            "owner",
            "organization",
            "meeting_room",
            "external_default_access",
            "effective_role",
            "effective_permission",
            "subscribed",
            "enabled",
            "color",
            "subscriber_count",
            "capabilities",
            "deleted_at",
        ]

    def _request_user(self):
        request = self.context.get("request")
        return request.user if request is not None else None

    def _subscription(self, obj):
        user = self._request_user()
        if user is None:
            return None
        cached = getattr(obj, "viewer_subscription_cache", None)
        if cached is not None:
            return cached
        return models.CalendarSubscription.objects.filter(
            calendar=obj, subscriber=user
        ).first()

    def get_owner(self, obj):
        return _user_card(obj.owner)

    def get_organization(self, obj):
        return {"id": str(obj.organization_id), "name": obj.organization.name}

    def get_meeting_room(self, obj):
        room = obj.meeting_room
        if room is None:
            return None
        return {"id": str(room.id), "name": room.name, "code": room.code}

    def get_effective_role(self, obj):
        user = self._request_user()
        return (
            calendar_access.calendar_permission(obj, user)
            if user is not None
            else models.CalendarAccessChoices.NONE
        )

    def get_effective_permission(self, obj):
        return calendar_access.calendar_read_permission(self.get_effective_role(obj))

    def get_subscribed(self, obj):
        return self._subscription(obj) is not None

    def get_enabled(self, obj):
        row = self._subscription(obj)
        if row is not None:
            return row.enabled
        return bool(obj.owner_id == getattr(self._request_user(), "id", None))

    def get_color(self, obj):
        row = self._subscription(obj)
        return row.color if row and row.color else DEFAULT_COLORS[0]

    def get_subscriber_count(self, obj):
        return obj.subscriptions.filter(enabled=True).count()

    def get_capabilities(self, obj):
        user = self._request_user()
        role = (
            calendar_access.calendar_permission(obj, user)
            if user is not None
            else models.CalendarAccessChoices.NONE
        )
        manage = role == models.CalendarAccessChoices.ADMIN
        return {
            "can_write": role
            in (models.CalendarAccessChoices.WRITER, models.CalendarAccessChoices.ADMIN),
            "can_manage": manage,
            "can_share": manage
            and obj.kind
            in (models.CalendarKindChoices.PRIMARY, models.CalendarKindChoices.SHARED),
            "can_export": manage,
            "can_delete": manage and obj.kind == models.CalendarKindChoices.SHARED,
        }

    def get_external_default_access(self, _obj):
        return models.CalendarAccessChoices.NONE

    def validate_organization_default_access(self, value):
        if value not in (
            models.CalendarAccessChoices.NONE,
            models.CalendarAccessChoices.FREE_BUSY,
            models.CalendarAccessChoices.DETAILS,
        ):
            raise serializers.ValidationError("expected none | free_busy | details")
        return value

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if self.instance and self.instance.kind == models.CalendarKindChoices.PRIMARY:
            attrs.pop("name", None)
        return attrs


class CalendarMemberInputSerializer(serializers.Serializer):
    user_id = serializers.UUIDField()
    role = serializers.ChoiceField(
        choices=(
            models.CalendarAccessChoices.FREE_BUSY,
            models.CalendarAccessChoices.DETAILS,
            models.CalendarAccessChoices.WRITER,
            models.CalendarAccessChoices.ADMIN,
        )
    )


class CalendarCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    description = serializers.CharField(required=False, allow_blank=True, default="")
    color = serializers.CharField(required=False, allow_blank=True, max_length=16)
    organization_default_access = serializers.ChoiceField(
        choices=(
            models.CalendarAccessChoices.NONE,
            models.CalendarAccessChoices.FREE_BUSY,
            models.CalendarAccessChoices.DETAILS,
        ),
        default=models.CalendarAccessChoices.DETAILS,
    )
    members = CalendarMemberInputSerializer(many=True, required=False)

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("name is required")
        return value


class CalendarViewSet(viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = CalendarSerializer
    pagination_class = None

    def initial(self, request, *args, **kwargs):
        if not FeatureFlag.flag_is_active("unified_calendar"):
            raise exceptions.NotFound()
        return super().initial(request, *args, **kwargs)

    def get_queryset(self):
        user = self.request.user
        return (
            models.Calendar.objects.filter(
                Q(owner=user)
                | Q(access_grants__grantee=user)
                | Q(subscriptions__subscriber=user),
                deleted_at__isnull=True,
            )
            .select_related("owner", "organization", "meeting_room")
            .distinct()
        )

    def get_object(self):
        calendar = (
            models.Calendar.objects.select_related(
                "owner", "organization", "meeting_room"
            )
            .filter(pk=self.kwargs.get(self.lookup_field), deleted_at__isnull=True)
            .first()
        )
        if calendar is None or (
            calendar_access.calendar_permission(calendar, self.request.user)
            == models.CalendarAccessChoices.NONE
        ):
            raise exceptions.NotFound()
        self.check_object_permissions(self.request, calendar)
        return calendar

    def list(self, request):
        calendars = list(self.get_queryset())
        subscriptions = {
            row.calendar_id: row
            for row in models.CalendarSubscription.objects.filter(
                subscriber=request.user,
                calendar_id__in=[row.id for row in calendars],
            )
        }
        for calendar in calendars:
            calendar.viewer_subscription_cache = subscriptions.get(calendar.id)
        return Response(self.get_serializer(calendars, many=True).data)

    def create(self, request):
        serializer = CalendarCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        organization = get_caller_organization(request.user)
        if organization is None:
            raise exceptions.NotFound()
        data = serializer.validated_data
        with transaction.atomic():
            calendar = models.Calendar.objects.create(
                organization=organization,
                owner=request.user,
                kind=models.CalendarKindChoices.SHARED,
                name=data["name"],
                description=data["description"],
                organization_default_access=data["organization_default_access"],
            )
            models.CalendarSubscription.objects.create(
                calendar=calendar,
                subscriber=request.user,
                enabled=True,
                color=data.get("color") or DEFAULT_COLORS[0],
            )
            for member in data.get("members", []):
                self._upsert_member(calendar, member["user_id"], member["role"])
        return Response(
            self.get_serializer(calendar).data, status=status.HTTP_201_CREATED
        )

    def retrieve(self, request, pk=None):
        return Response(self.get_serializer(self.get_object()).data)

    def partial_update(self, request, pk=None):
        calendar = self.get_object()
        if not calendar_access.calendar_can_manage(calendar, request.user):
            raise exceptions.PermissionDenied()
        if calendar.kind in (
            models.CalendarKindChoices.RESOURCE,
            models.CalendarKindChoices.EXTERNAL,
        ):
            raise exceptions.PermissionDenied("This calendar has no editable settings.")
        serializer = self.get_serializer(calendar, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    def destroy(self, request, pk=None):
        calendar = self.get_object()
        if not calendar_access.calendar_can_manage(calendar, request.user):
            raise exceptions.PermissionDenied()
        if calendar.kind != models.CalendarKindChoices.SHARED:
            raise exceptions.ValidationError("Only shared calendars can be deleted.")
        calendar.deleted_at = timezone.now()
        calendar.save(update_fields=["deleted_at", "updated_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    @decorators.action(detail=True, methods=["post"])
    def restore(self, request, pk=None):
        calendar = (
            models.Calendar.objects.select_related("owner", "organization")
            .filter(pk=pk, deleted_at__isnull=False)
            .first()
        )
        if calendar is None:
            raise exceptions.NotFound()
        if not calendar_access.calendar_can_manage_for_deleted(calendar, request.user):
            raise exceptions.PermissionDenied()
        if calendar.deleted_at < timezone.now() - timezone.timedelta(days=30):
            raise exceptions.ValidationError("The restore window has expired.")
        calendar.deleted_at = None
        calendar.save(update_fields=["deleted_at", "updated_at"])
        return Response(self.get_serializer(calendar).data)

    @decorators.action(detail=False, methods=["get"])
    def discover(self, request):
        kind = str(request.query_params.get("type") or "")
        query = str(request.query_params.get("q") or "").strip()
        organization = get_caller_organization(request.user)
        if organization is None:
            return Response([])
        if kind == "contact":
            memberships = (
                models.Membership.objects.filter(
                    organization=organization,
                    status=models.MembershipStatusChoices.ACTIVE,
                    user__is_active=True,
                    user__is_device=False,
                )
                .exclude(user=request.user)
                .select_related("user")
            )
            if query:
                memberships = memberships.filter(
                    Q(user__full_name__icontains=query)
                    | Q(user__email__icontains=query)
                )
            calendars = [
                calendar_access.ensure_personal_calendar(row.user, organization)
                for row in memberships[:50]
            ]
        elif kind == "room":
            rooms = models.MeetingRoom.objects.filter(
                organization=organization, is_active=True
            ).select_related("node")
            if query:
                rooms = rooms.filter(
                    Q(name__icontains=query) | Q(code__icontains=query)
                )
            calendars = []
            for room in rooms[:100]:
                calendar, _ = models.Calendar.objects.get_or_create(
                    organization=organization,
                    kind=models.CalendarKindChoices.RESOURCE,
                    meeting_room=room,
                    defaults={"name": room.name or room.code},
                )
                calendars.append(calendar)
        elif kind == "public":
            calendars = list(
                models.Calendar.objects.filter(
                    Q(organization_default_access__in=("free_busy", "details"))
                    | Q(access_grants__grantee=request.user),
                    organization=organization,
                    kind=models.CalendarKindChoices.SHARED,
                    deleted_at__isnull=True,
                    name__icontains=query,
                )
                .select_related("owner", "organization")
                .distinct()[:100]
            )
        else:
            raise exceptions.ValidationError({"type": "expected contact | room | public"})
        return Response(self.get_serializer(calendars, many=True).data)

    @decorators.action(detail=True, methods=["put", "delete"])
    def subscription(self, request, pk=None):
        calendar = self.get_object()
        if request.method == "DELETE":
            if calendar.owner_id == request.user.id:
                raise exceptions.ValidationError("The owner calendar cannot be removed.")
            models.CalendarSubscription.objects.filter(
                calendar=calendar, subscriber=request.user
            ).delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        if (
            calendar_access.calendar_permission(calendar, request.user)
            == models.CalendarAccessChoices.NONE
        ):
            raise exceptions.PermissionDenied()
        row, _ = models.CalendarSubscription.objects.update_or_create(
            calendar=calendar,
            subscriber=request.user,
            defaults={
                "enabled": serializers.BooleanField().run_validation(
                    request.data.get("enabled", True)
                ),
                "color": str(request.data.get("color") or DEFAULT_COLORS[0])[:16],
            },
        )
        calendar.viewer_subscription_cache = row
        return Response(self.get_serializer(calendar).data)

    @decorators.action(detail=True, methods=["get", "post"])
    def members(self, request, pk=None):
        calendar = self.get_object()
        if not calendar_access.calendar_can_manage(calendar, request.user):
            raise exceptions.PermissionDenied()
        if request.method == "GET":
            rows = calendar.access_grants.select_related("grantee").all()
            return Response([self._member_card(row) for row in rows])
        serializer = CalendarMemberInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        row = self._upsert_member(
            calendar,
            serializer.validated_data["user_id"],
            serializer.validated_data["role"],
        )
        return Response(self._member_card(row), status=status.HTTP_201_CREATED)

    @decorators.action(
        detail=True,
        methods=["patch", "delete"],
        url_path=r"members/(?P<member_id>[0-9a-f-]+)",
    )
    def member_detail(self, request, pk=None, member_id=None):
        calendar = self.get_object()
        if not calendar_access.calendar_can_manage(calendar, request.user):
            raise exceptions.PermissionDenied()
        row = calendar.access_grants.filter(pk=member_id).select_related("grantee").first()
        if row is None:
            raise exceptions.NotFound()
        if request.method == "DELETE":
            models.CalendarSubscription.objects.filter(
                calendar=calendar, subscriber=row.grantee
            ).delete()
            row.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        role = str(request.data.get("role") or "")
        self._validate_member_role(calendar, row.grantee, role)
        row.permission = role
        row.save(update_fields=["permission", "updated_at"])
        return Response(self._member_card(row))

    @decorators.action(detail=True, methods=["get", "post"], url_path="share-link")
    @FeatureFlag.require("calendar_sharing")
    def share_link(self, request, pk=None):
        calendar = self.get_object()
        if not calendar_access.calendar_can_manage(calendar, request.user):
            raise exceptions.PermissionDenied()
        if calendar.kind not in (
            models.CalendarKindChoices.PRIMARY,
            models.CalendarKindChoices.SHARED,
        ):
            raise exceptions.ValidationError("This calendar cannot be shared.")
        if request.method == "POST":
            calendar.share_link_version += 1
            calendar.save(update_fields=["share_link_version", "updated_at"])
        token = _share_token(calendar)
        path = f"/calendar/subscribe/{token}"
        return Response({"token": token, "url": request.build_absolute_uri(path)})

    @decorators.action(detail=True, methods=["get"])
    def events(self, request, pk=None):
        calendar = self.get_object()
        role = calendar_access.calendar_permission(calendar, request.user)
        if role == models.CalendarAccessChoices.NONE:
            raise exceptions.NotFound()
        queryset = (
            calendar_access.events_for_calendar(calendar)
            .select_related("organizer", "room", "source_calendar")
            .prefetch_related("attendees__user", "room_bookings__room__node")
            .order_by("start_at")
        )
        events = list(filter_calendar_window(queryset, request.query_params))
        levels = {
            event.id: calendar_access.event_access_for_calendar_permission(
                event, request.user, role, projection_calendar=calendar
            )
            for event in events
        }
        return Response(
            CalendarEventSerializer(
                events,
                many=True,
                context={"request": request, "event_access_levels": levels},
            ).data
        )

    @decorators.action(detail=True, methods=["post"])
    @FeatureFlag.require("calendar_export")
    def exports(self, request, pk=None):
        return create_calendar_export(request, self.get_object())

    @staticmethod
    def _member_card(row):
        return {
            "id": str(row.id),
            "user": _user_card(row.grantee),
            "role": row.permission,
            "external": not models.Membership.objects.filter(
                organization=row.calendar.organization,
                user=row.grantee,
                status=models.MembershipStatusChoices.ACTIVE,
            ).exists(),
        }

    @staticmethod
    def _validate_member_role(calendar, user, role):
        allowed = {
            models.CalendarAccessChoices.FREE_BUSY,
            models.CalendarAccessChoices.DETAILS,
            models.CalendarAccessChoices.WRITER,
            models.CalendarAccessChoices.ADMIN,
        }
        if role not in allowed:
            raise exceptions.ValidationError({"role": "unsupported role"})
        if calendar.kind == models.CalendarKindChoices.PRIMARY and role in (
            models.CalendarAccessChoices.WRITER,
            models.CalendarAccessChoices.ADMIN,
        ):
            raise exceptions.ValidationError(
                {"role": "primary calendars cannot delegate editing"}
            )
        same_org = models.Membership.objects.filter(
            organization=calendar.organization,
            user=user,
            status=models.MembershipStatusChoices.ACTIVE,
        ).exists()
        if not same_org:
            if not calendar.owner_id or not calendar_access.accepted_external_contacts(
                calendar.owner, user
            ):
                raise exceptions.PermissionDenied("An accepted external contact is required.")
            if role not in (
                models.CalendarAccessChoices.FREE_BUSY,
                models.CalendarAccessChoices.DETAILS,
            ):
                raise exceptions.ValidationError(
                    {"role": "external contacts are read-only"}
                )

    def _upsert_member(self, calendar, user_id, role):
        if calendar.kind in (
            models.CalendarKindChoices.RESOURCE,
            models.CalendarKindChoices.EXTERNAL,
        ):
            raise exceptions.ValidationError("This calendar cannot have members.")
        user = models.User.objects.filter(
            id=user_id, is_active=True, is_device=False
        ).first()
        if user is None or user.id == calendar.owner_id:
            raise exceptions.ValidationError({"user_id": "invalid calendar member"})
        self._validate_member_role(calendar, user, role)
        row, _ = models.CalendarMembership.objects.update_or_create(
            calendar=calendar, grantee=user, defaults={"permission": role}
        )
        models.CalendarSubscription.objects.get_or_create(
            calendar=calendar,
            subscriber=user,
            defaults={"enabled": True, "color": DEFAULT_COLORS[0]},
        )
        return row


class CalendarShareView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    @FeatureFlag.require("unified_calendar")
    @FeatureFlag.require("calendar_sharing")
    def get(self, request, token):
        calendar = resolve_share_token(token)
        role = calendar_access.calendar_permission(calendar, request.user)
        if role == models.CalendarAccessChoices.NONE:
            raise exceptions.PermissionDenied("This calendar has not been shared with you.")
        return Response(CalendarSerializer(calendar, context={"request": request}).data)

    @FeatureFlag.require("unified_calendar")
    @FeatureFlag.require("calendar_sharing")
    def post(self, request, token):
        calendar = resolve_share_token(token)
        if (
            calendar_access.calendar_permission(calendar, request.user)
            == models.CalendarAccessChoices.NONE
        ):
            raise exceptions.PermissionDenied("This calendar has not been shared with you.")
        row, _ = models.CalendarSubscription.objects.update_or_create(
            calendar=calendar,
            subscriber=request.user,
            defaults={"enabled": True, "color": DEFAULT_COLORS[0]},
        )
        calendar.viewer_subscription_cache = row
        return Response(CalendarSerializer(calendar, context={"request": request}).data)
