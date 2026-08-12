"""Personal calendar sharing, grants, subscriptions, and subscribed feeds."""

import uuid

from django.db.models import Q
from django.utils.dateparse import parse_datetime

from rest_framework import decorators, exceptions, mixins, serializers, status, viewsets
from rest_framework.response import Response

from core import models, utils
from core.api import permissions
from core.api.calendar import CalendarEventSerializer
from core.api.directory import get_caller_organization
from core.services import calendar_access


def _user_card(user, organization=None):
    return {
        "id": str(user.id),
        "full_name": user.full_name,
        "short_name": user.short_name,
        "avatar_url": utils.generate_profile_image_get_url("avatar", user.avatar_key),
        "organization": (
            {"id": str(organization.id), "name": organization.name}
            if organization
            else None
        ),
    }


def _active_organization(user, *, exclude=None):
    memberships = models.Membership.objects.filter(
        user=user,
        status=models.MembershipStatusChoices.ACTIVE,
        organization__is_active=True,
    ).select_related("organization")
    if exclude is not None:
        memberships = memberships.exclude(organization=exclude)
    row = memberships.order_by("-is_primary", "created_at").first()
    return row.organization if row else None


class PersonalCalendarSerializer(serializers.ModelSerializer):
    owner = serializers.SerializerMethodField()
    organization = serializers.SerializerMethodField()
    effective_permission = serializers.SerializerMethodField()
    subscribed = serializers.SerializerMethodField()

    class Meta:
        model = models.PersonalCalendar
        fields = [
            "id",
            "owner",
            "organization",
            "organization_default_access",
            "effective_permission",
            "subscribed",
        ]
        read_only_fields = [
            "id",
            "owner",
            "organization",
            "effective_permission",
            "subscribed",
        ]

    def get_owner(self, obj):
        return _user_card(obj.owner, obj.organization)

    def get_organization(self, obj):
        return {"id": str(obj.organization_id), "name": obj.organization.name}

    def get_effective_permission(self, obj):
        request = self.context.get("request")
        if request is None:
            return models.CalendarAccessChoices.NONE
        return calendar_access.calendar_permission(obj, request.user)

    def get_subscribed(self, obj):
        request = self.context.get("request")
        if request is None or obj.owner_id == request.user.id:
            return False
        return models.CalendarSubscription.objects.filter(
            calendar=obj,
            subscriber=request.user,
            enabled=True,
        ).exists()


class PersonalCalendarViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = PersonalCalendarSerializer
    pagination_class = None

    def get_queryset(self):
        return (
            models.PersonalCalendar.objects.filter(
                Q(owner=self.request.user)
                | Q(subscriptions__subscriber=self.request.user)
            )
            .select_related("owner", "organization")
            .distinct()
        )

    @decorators.action(detail=False, methods=["get"])
    def mine(self, request):
        organization = get_caller_organization(request.user)
        if organization is None:
            raise exceptions.NotFound()
        calendar = calendar_access.ensure_personal_calendar(
            request.user, organization
        )
        return Response(self.get_serializer(calendar).data)

    def update(self, request, *args, **kwargs):
        calendar = self.get_object()
        if calendar.owner_id != request.user.id:
            raise exceptions.PermissionDenied("Only the owner can change sharing.")
        return super().update(request, *args, **kwargs)

    @decorators.action(detail=True, methods=["get"])
    def events(self, request, pk=None):
        calendar = self.get_object()
        own = calendar.owner_id == request.user.id
        permission = models.CalendarAccessChoices.DETAILS
        if not own:
            subscription = models.CalendarSubscription.objects.filter(
                calendar=calendar,
                subscriber=request.user,
                enabled=True,
            ).first()
            permission = calendar_access.calendar_permission(calendar, request.user)
            if (
                subscription is None
                or permission == models.CalendarAccessChoices.NONE
            ):
                raise exceptions.NotFound()

        queryset = (
            calendar_access.events_for_calendar(calendar)
            .select_related("organizer", "room")
            .prefetch_related("attendees__user", "room_bookings__room__node")
            .order_by("start_at")
        )
        start = parse_datetime(request.query_params.get("start", "") or "")
        end = parse_datetime(request.query_params.get("end", "") or "")
        if start:
            queryset = queryset.filter(end_at__gt=start)
        if end:
            queryset = queryset.filter(start_at__lt=end)

        events = list(queryset)
        access_levels = {
            event.id: (
                calendar_access.EventAccess.DETAILS
                if own
                else calendar_access.event_access_for_calendar_permission(
                    event,
                    request.user,
                    permission,
                )
            )
            for event in events
        }
        # The feed queryset is already date-bounded and the Web/App clients use
        # the whole visible window, so keep this endpoint deliberately unpaged.
        serializer = CalendarEventSerializer(
            events,
            many=True,
            context={
                "request": request,
                "event_access_levels": access_levels,
            },
        )
        return Response(serializer.data)


class CalendarAccessGrantViewSet(viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = serializers.Serializer
    pagination_class = None

    def get_queryset(self):
        return models.CalendarAccessGrant.objects.filter(
            calendar__owner=self.request.user
        ).select_related(
            "calendar",
            "calendar__organization",
            "grantee",
        )

    @staticmethod
    def _card(grant):
        target_org = _active_organization(
            grant.grantee, exclude=grant.calendar.organization
        ) or _active_organization(grant.grantee)
        return {
            "id": str(grant.id),
            "calendar_id": str(grant.calendar_id),
            "grantee": _user_card(grant.grantee, target_org),
            "permission": grant.permission,
            "external": not models.Membership.objects.filter(
                organization=grant.calendar.organization,
                user=grant.grantee,
                status=models.MembershipStatusChoices.ACTIVE,
            ).exists(),
        }

    def list(self, request):
        return Response([self._card(row) for row in self.get_queryset()])

    def create(self, request):
        organization = get_caller_organization(request.user)
        calendar = calendar_access.ensure_personal_calendar(
            request.user, organization
        ) if organization else None
        if calendar is None:
            raise exceptions.NotFound()
        try:
            target_id = uuid.UUID(str(request.data.get("grantee_user_id") or ""))
        except (TypeError, ValueError, AttributeError) as exc:
            raise exceptions.ValidationError(
                {"grantee_user_id": "a valid user id is required"}
            ) from exc
        permission = str(request.data.get("permission") or "")
        if permission not in (
            models.CalendarAccessChoices.FREE_BUSY,
            models.CalendarAccessChoices.DETAILS,
        ):
            raise exceptions.ValidationError(
                {"permission": "expected free_busy | details"}
            )
        target = models.User.objects.filter(
            id=target_id,
            is_active=True,
            is_device=False,
        ).first()
        if target is None or not calendar_access.may_share_calendar_with(
            request.user, target, organization
        ):
            raise exceptions.PermissionDenied("Calendar cannot be shared with this user.")
        grant, created = models.CalendarAccessGrant.objects.update_or_create(
            calendar=calendar,
            grantee=target,
            defaults={"permission": permission},
        )
        return Response(
            self._card(grant),
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    def partial_update(self, request, pk=None):
        grant = self.get_object()
        permission = str(request.data.get("permission") or "")
        if permission not in (
            models.CalendarAccessChoices.FREE_BUSY,
            models.CalendarAccessChoices.DETAILS,
        ):
            raise exceptions.ValidationError(
                {"permission": "expected free_busy | details"}
            )
        grant.permission = permission
        grant.save(update_fields=["permission", "updated_at"])
        return Response(self._card(grant))

    def destroy(self, request, pk=None):
        grant = self.get_object()
        # Revoke the authorization and hide the now-unreadable subscription.
        models.CalendarSubscription.objects.filter(
            calendar=grant.calendar,
            subscriber=grant.grantee,
        ).delete()
        grant.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class CalendarSubscriptionViewSet(viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = serializers.Serializer
    pagination_class = None

    def get_queryset(self):
        return models.CalendarSubscription.objects.filter(
            subscriber=self.request.user
        ).select_related(
            "calendar",
            "calendar__owner",
            "calendar__organization",
        )

    @staticmethod
    def _card(subscription):
        calendar = subscription.calendar
        return {
            "id": str(subscription.id),
            "calendar_id": str(calendar.id),
            "owner": _user_card(calendar.owner, calendar.organization),
            "permission": calendar_access.calendar_permission(
                calendar, subscription.subscriber
            ),
            "enabled": subscription.enabled,
            "color": subscription.color,
        }

    def list(self, request):
        readable = []
        for row in self.get_queryset():
            if calendar_access.calendar_permission(
                row.calendar, request.user
            ) != models.CalendarAccessChoices.NONE:
                readable.append(self._card(row))
        return Response(readable)

    def create(self, request):
        try:
            owner_id = uuid.UUID(str(request.data.get("owner_user_id") or ""))
        except (TypeError, ValueError, AttributeError) as exc:
            raise exceptions.ValidationError(
                {"owner_user_id": "a valid user id is required"}
            ) from exc
        if owner_id == request.user.id:
            raise exceptions.ValidationError(
                {"owner_user_id": "your personal calendar is always visible"}
            )
        owner = models.User.objects.filter(
            id=owner_id,
            is_active=True,
            is_device=False,
        ).first()
        caller_org = get_caller_organization(request.user)
        if owner is None or caller_org is None:
            raise exceptions.NotFound()
        same_org = models.Membership.objects.filter(
            organization=caller_org,
            user=owner,
            status=models.MembershipStatusChoices.ACTIVE,
        ).exists()
        if same_org:
            owner_org = caller_org
        elif calendar_access.accepted_external_contacts(request.user, owner):
            owner_org = _active_organization(owner, exclude=caller_org)
        else:
            owner_org = None
        if owner_org is None:
            raise exceptions.PermissionDenied("This calendar is not available.")
        calendar = calendar_access.ensure_personal_calendar(owner, owner_org)
        if calendar_access.calendar_permission(
            calendar, request.user
        ) == models.CalendarAccessChoices.NONE:
            raise exceptions.PermissionDenied("This calendar has not been shared.")
        defaults = {
            "enabled": serializers.BooleanField().run_validation(
                request.data.get("enabled", True)
            ),
            "color": str(request.data.get("color") or "")[:16],
        }
        subscription, created = models.CalendarSubscription.objects.update_or_create(
            calendar=calendar,
            subscriber=request.user,
            defaults=defaults,
        )
        return Response(
            self._card(subscription),
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    def partial_update(self, request, pk=None):
        subscription = self.get_object()
        fields = []
        if "enabled" in request.data:
            subscription.enabled = serializers.BooleanField().run_validation(
                request.data.get("enabled")
            )
            fields.append("enabled")
        if "color" in request.data:
            subscription.color = str(request.data.get("color") or "")[:16]
            fields.append("color")
        if fields:
            subscription.save(update_fields=[*fields, "updated_at"])
        return Response(self._card(subscription))

    def destroy(self, request, pk=None):
        self.get_object().delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
