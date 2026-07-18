"""Calendar / scheduling API (P2 — 日历/日程).

CalendarEvent CRUD + RSVP, scoped to the caller's organization. Creating an
event also provisions its join target — a Room owned by the organizer with the
invitees as members, with ``scheduled_at`` set — and records EventAttendee rows.
The room's IM group is left lazy (provisioned by ``/rooms/{id}/im/ensure-group``
on first need / by the reminder job in P2-c), so event creation never depends on
jusi-light-im being reachable.
"""

from django.db import IntegrityError, transaction
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
from core.services import calendar_recurrence


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
            # P2-M1 重复日程:主事件携带 RRULE;子场次 recurrence 为空、
            # recurrence_parent 指回主事件(前端据此区分删除文案)。
            "recurrence",
            "recurrence_parent",
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
            "recurrence_parent",
        ]

    def validate_recurrence(self, value):
        """RRULE 合法性前置校验(dateutil 同款解析),坏串 400 而非物化时炸。"""
        value = (value or "").strip()
        if not value:
            return ""
        from datetime import datetime

        from dateutil.rrule import rrulestr

        try:
            rrulestr(value, dtstart=datetime(2026, 1, 1, 9, 0))
        except (ValueError, TypeError) as exc:
            raise serializers.ValidationError(f"invalid RRULE: {exc}") from exc
        return value

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
            # Org-scoped: only active members of the caller's organization can be
            # invited (no cross-org leakage into the event / Room / IM group);
            # out-of-org ids are silently dropped, matching directory resolve.
            invited = (
                models.User.objects.filter(
                    id__in=attendee_ids,
                    memberships__organization=organization,
                    memberships__status=models.MembershipStatusChoices.ACTIVE,
                )
                .exclude(id=user.id)
                .distinct()
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

    def _sync_room(self, event):
        """Keep the linked Room's name / scheduled_at consistent after an edit."""
        room = event.room
        if room is None:
            return
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

    def update(self, request, *args, **kwargs):
        """PATCH/PUT;P2-M2 重复日程三选语义(body 里的 ``edit_scope``):

        - 子场次 + ``one``(缺省):只改该行,并在主事件记原时刻 exdate——
          即使时刻被改,原槽位也不会被重新物化。
        - 子场次 + ``following``:系列在该场次分裂,新主事件带编辑值接管后续,
          返回体 = 新主事件。
        - 子场次 + ``all`` / 主事件(任意 scope):走「全部」——标量传播全系列,
          时间按该场次的新旧差平移,未来窗口重物化(RSVP 按平移保留)。
        - 单次事件不受影响(原路径)。M2 边界:主事件行即系列首场,首场不支持
          one/following(等价于 all);改 RRULE 本身不在三选语义内,忽略。
        """
        partial = kwargs.pop("partial", False)
        instance = self.get_object()
        self._require_organizer(instance)
        scope = str((request.data or {}).get("edit_scope") or "").strip()
        if scope not in ("", "one", "following", "all"):
            raise exceptions.ValidationError(
                {"edit_scope": "expected one | following | all"}
            )

        serializer = self.get_serializer(
            instance, data=request.data, partial=partial
        )
        serializer.is_valid(raise_exception=True)

        parent = instance.recurrence_parent
        is_recurring = parent is not None or bool(instance.recurrence)
        if not is_recurring:
            self.perform_update(serializer)
            return Response(serializer.data)

        data = dict(serializer.validated_data)
        for excluded in ("attendee_ids", "timezone", "recurrence"):
            data.pop(excluded, None)

        if parent is not None and scope == "following":
            new_parent = calendar_recurrence.split_series(instance, data)
            return Response(self.get_serializer(new_parent).data)

        if parent is not None and scope == "all":
            updated = calendar_recurrence.edit_series_all(
                parent, instance.start_at, data
            )
            self._sync_room(updated)
            return Response(self.get_serializer(updated).data)

        if parent is None:
            # 主事件 = 系列锚点:任何 scope 都按「全部」处理。
            updated = calendar_recurrence.edit_series_all(
                instance, instance.start_at, data
            )
            self._sync_room(updated)
            return Response(self.get_serializer(updated).data)

        # 子场次缺省 / one:改行 + 主事件记原时刻 exdate。
        original_start = instance.start_at
        try:
            with transaction.atomic():
                event = serializer.save()
                exdates = list(parent.recurrence_exdates or [])
                key = original_start.isoformat()
                if key not in exdates:
                    exdates.append(key)
                    parent.recurrence_exdates = exdates
                    parent.save(
                        update_fields=["recurrence_exdates", "updated_at"]
                    )
        except IntegrityError as exc:
            # 撞 (recurrence_parent, start_at) 唯一索引 = 移到了别的场次槽位。
            raise exceptions.ValidationError(
                {"start_at": "another occurrence already exists at this time"}
            ) from exc
        return Response(self.get_serializer(event).data)

    def perform_update(self, serializer):
        """Organizer-only edit. Syncs the linked Room's name / scheduled_at so a
        reschedule (or rename) stays consistent; adds any newly-listed invitees
        (never removes — removal stays an explicit later action)."""
        self._require_organizer(serializer.instance)
        data = serializer.validated_data
        attendee_ids = data.pop("attendee_ids", None)
        with transaction.atomic():
            event = serializer.save()
            self._sync_room(event)
            if attendee_ids:
                # Org-scoped like perform_create: only active members of the
                # event's organization can be added (no cross-org invite).
                invited = (
                    models.User.objects.filter(
                        id__in=attendee_ids,
                        memberships__organization=event.organization,
                        memberships__status=models.MembershipStatusChoices.ACTIVE,
                    )
                    .exclude(id=event.organizer_id)
                    .distinct()
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

    def destroy(self, request, *args, **kwargs):
        """DELETE;P2-M2 扩展 ``?scope=following``(仅子场次):系列在该场次
        截断,该场次及之后全部删除。缺省走 M1 语义(perform_destroy)。"""
        instance = self.get_object()
        if (
            str(request.query_params.get("scope") or "") == "following"
            and instance.recurrence_parent_id
        ):
            self._require_organizer(instance)
            calendar_recurrence.delete_following(instance)
            return Response(status=drf_status.HTTP_204_NO_CONTENT)
        return super().destroy(request, *args, **kwargs)

    def perform_destroy(self, instance):
        """Organizer-only delete. The Room survives (FK is SET_NULL) so a
        recording / in-progress call isn't yanked out from under attendees.

        P2-M1 重复日程语义:
        - 删**子场次**(recurrence_parent 非空)=「仅此次」:先在主事件
          ``recurrence_exdates`` 记下该场次时刻(ISO-8601 UTC),防止下轮
          物化重建,再删行。
        - 删**主事件**(带 RRULE)= 删除整个系列:未来子场次(start_at 在
          当前之后)一并删除;历史场次保留作记录。三选编辑语义是 M2 范畴。
        """
        self._require_organizer(instance)
        from django.utils import timezone as django_timezone

        with transaction.atomic():
            parent = instance.recurrence_parent
            if parent is not None:
                exdates = list(parent.recurrence_exdates or [])
                key = instance.start_at.isoformat()
                if key not in exdates:
                    exdates.append(key)
                    parent.recurrence_exdates = exdates
                    parent.save(
                        update_fields=["recurrence_exdates", "updated_at"]
                    )
            elif instance.recurrence:
                instance.occurrences.filter(
                    start_at__gte=django_timezone.now()
                ).delete()
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
