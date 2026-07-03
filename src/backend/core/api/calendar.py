"""Calendar / scheduling API (P2 — 日历/日程).

CalendarEvent CRUD + RSVP, scoped to the caller's organization. Creating an
event also provisions its join target — a Room owned by the organizer with the
invitees as members, with ``scheduled_at`` set — and records EventAttendee rows.
The room's IM group is left lazy (provisioned by ``/rooms/{id}/im/ensure-group``
on first need / by the reminder job in P2-c), so event creation never depends on
jusi-light-im being reachable.
"""

from django.db import transaction
from django.db.models import Q
from django.utils.dateparse import parse_datetime

from rest_framework import decorators, exceptions, serializers, viewsets
from rest_framework import status as drf_status
from rest_framework.response import Response

from core import models
from core.api import permissions
from core.api.directory import get_caller_organization
from core.api.serializers import UserLightSerializer
from core.api.viewsets import Pagination


class CalendarEventSerializer(serializers.ModelSerializer):
    """Read + write a calendar event.

    ``attendee_ids`` (write-only) is the list of we-meet user ids to invite;
    ``attendees`` / ``my_rsvp`` / ``room_slug`` are read-only enrichments.
    """

    organizer = UserLightSerializer(read_only=True)
    # TimeZoneField → declare explicitly so it round-trips as an IANA name string.
    timezone = serializers.CharField(required=False, allow_blank=True)
    attendee_ids = serializers.ListField(
        child=serializers.UUIDField(),
        write_only=True,
        required=False,
        default=list,
    )
    attendees = serializers.SerializerMethodField()
    room_slug = serializers.SerializerMethodField()
    my_rsvp = serializers.SerializerMethodField()

    class Meta:
        model = models.CalendarEvent
        fields = [
            "id",
            "title",
            "description",
            "start_at",
            "end_at",
            "timezone",
            "all_day",
            "status",
            "visibility",
            "reminders",
            "organizer",
            "room",
            "room_slug",
            "attendees",
            "attendee_ids",
            "my_rsvp",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "status",
            "organizer",
            "room",
            "room_slug",
            "attendees",
            "my_rsvp",
            "created_at",
        ]

    def get_attendees(self, obj):
        return [
            {
                "id": str(a.user_id) if a.user_id else None,
                "full_name": a.user.full_name if a.user_id else None,
                "email": a.email or (a.user.email if a.user_id else ""),
                "rsvp": a.rsvp,
                "role": a.role,
            }
            for a in obj.attendees.all()
        ]

    def get_room_slug(self, obj):
        return obj.room.slug if obj.room_id else None

    def get_my_rsvp(self, obj):
        request = self.context.get("request")
        if not request:
            return None
        mine = next(
            (a for a in obj.attendees.all() if a.user_id == request.user.id), None
        )
        return mine.rsvp if mine else None


class CalendarEventViewSet(viewsets.ModelViewSet):
    """CRUD + RSVP for calendar events the caller organizes or is invited to."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = CalendarEventSerializer
    pagination_class = Pagination

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.CalendarEvent.objects.none()
        user = self.request.user
        queryset = (
            models.CalendarEvent.objects.filter(organization=organization)
            .filter(Q(organizer=user) | Q(attendees__user=user))
            .distinct()
            .select_related("organizer", "room")
            .prefetch_related("attendees__user")
            .order_by("start_at")
        )
        # Date-range window (?start & ?end, ISO 8601) — only for the list view, so
        # retrieve/update by pk are never filtered out. Returns events overlapping
        # the window: start_at < end AND end_at > start. Unparseable params ignored.
        if self.action == "list":
            start = parse_datetime(self.request.query_params.get("start", "") or "")
            end = parse_datetime(self.request.query_params.get("end", "") or "")
            if start:
                queryset = queryset.filter(end_at__gt=start)
            if end:
                queryset = queryset.filter(start_at__lt=end)
        return queryset

    def _require_organizer(self, event):
        """Only the organizer may edit / delete an event (invitees can RSVP only)."""
        if event.organizer_id != self.request.user.id:
            raise exceptions.PermissionDenied(
                "Only the organizer can modify this event."
            )

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["request"] = self.request
        return context

    def perform_create(self, serializer):
        """Create the event + its Room (organizer owner, invitees members) + attendees."""
        user = self.request.user
        organization = get_caller_organization(user)
        if organization is None:
            raise serializers.ValidationError(
                {"detail": "No active organization membership."}
            )
        data = serializer.validated_data
        attendee_ids = data.pop("attendee_ids", [])
        timezone_name = data.pop("timezone", "") or str(user.timezone)

        with transaction.atomic():
            room = models.Room.objects.create(
                name=data["title"], scheduled_at=data["start_at"]
            )
            models.ResourceAccess.objects.create(
                resource=room, user=user, role=models.RoleChoices.OWNER
            )
            event = serializer.save(
                organizer=user,
                organization=organization,
                room=room,
                timezone=timezone_name,
            )
            # Organizer attends implicitly (accepted).
            models.EventAttendee.objects.create(
                event=event,
                user=user,
                role=models.EventAttendeeRoleChoices.ORGANIZER,
                rsvp=models.EventRSVPChoices.ACCEPTED,
            )
            # Invitees → attendees + room members (so the IM group includes them).
            invited = models.User.objects.filter(id__in=attendee_ids).exclude(
                id=user.id
            )
            for attendee in invited:
                models.EventAttendee.objects.get_or_create(
                    event=event,
                    user=attendee,
                    defaults={"role": models.EventAttendeeRoleChoices.REQUIRED},
                )
                models.ResourceAccess.objects.get_or_create(
                    resource=room,
                    user=attendee,
                    defaults={"role": models.RoleChoices.MEMBER},
                )

    def perform_update(self, serializer):
        """Organizer-only edit. Syncs the linked Room's name / scheduled_at so a
        reschedule (or rename) stays consistent; adds any newly-listed invitees
        (never removes — removal stays an explicit later action)."""
        self._require_organizer(serializer.instance)
        data = serializer.validated_data
        attendee_ids = data.pop("attendee_ids", None)
        with transaction.atomic():
            event = serializer.save()
            room = event.room
            if room is not None:
                update_fields = []
                if room.name != event.title:
                    room.name = event.title
                    update_fields.append("name")
                if room.scheduled_at != event.start_at:
                    room.scheduled_at = event.start_at
                    update_fields.append("scheduled_at")
                if update_fields:
                    update_fields.append("updated_at")
                    room.save(update_fields=update_fields)
            if attendee_ids:
                invited = models.User.objects.filter(id__in=attendee_ids).exclude(
                    id=event.organizer_id
                )
                for attendee in invited:
                    models.EventAttendee.objects.get_or_create(
                        event=event,
                        user=attendee,
                        defaults={"role": models.EventAttendeeRoleChoices.REQUIRED},
                    )
                    if room is not None:
                        models.ResourceAccess.objects.get_or_create(
                            resource=room,
                            user=attendee,
                            defaults={"role": models.RoleChoices.MEMBER},
                        )

    def perform_destroy(self, instance):
        """Organizer-only delete. The Room survives (FK is SET_NULL) so a
        recording / in-progress call isn't yanked out from under attendees."""
        self._require_organizer(instance)
        instance.delete()

    @decorators.action(detail=True, methods=["post"])
    def rsvp(self, request, pk=None):  # pylint: disable=unused-argument
        """Set the caller's RSVP on this event (must be an attendee)."""
        event = self.get_object()
        status_value = (request.data or {}).get("status")
        if status_value not in models.EventRSVPChoices.values:
            return Response(
                {"detail": "Invalid rsvp status."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        attendee = models.EventAttendee.objects.filter(
            event=event, user=request.user
        ).first()
        if attendee is None:
            return Response(
                {"detail": "Not an attendee of this event."},
                status=drf_status.HTTP_403_FORBIDDEN,
            )
        attendee.rsvp = status_value
        attendee.save(update_fields=["rsvp", "updated_at"])
        return Response({"status": status_value}, status=drf_status.HTTP_200_OK)
