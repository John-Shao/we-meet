"""Calendar / scheduling API (P2 — 日历/日程).

CalendarEvent CRUD + RSVP, scoped to the caller's organization. Creating an
event can provision its join target — a Room owned by the organizer with the
invitees as members, with ``scheduled_at`` set — and records EventAttendee rows.
An optional source conversation is verified at create time, remains immutable,
and is the only IM destination for reminders and change cards.
"""

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfoNotFoundError

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone as django_timezone
from django.utils.dateparse import parse_date, parse_datetime

from dateutil.rrule import rrulestr
from rest_framework import decorators, exceptions, serializers, viewsets
from rest_framework import status as drf_status
from rest_framework.response import Response

from core import models, utils
from core.api import permissions
from core.api.directory import get_caller_organization
from core.api.meeting_rooms import bookable_scope_filter, room_path_label
from core.api.viewsets import Pagination
from core.services import (
    calendar_access,
    calendar_im_notify,
    calendar_recurrence,
    calendar_reminders,
    calendar_time,
    im_cards,
    meeting_room_booking,
)

#: "the client did not mention this field at all" — distinct from an explicit
#: ``false``. Only meaningful for fields whose absence and whose ``false`` must
#: do different things (see ``with_video_meeting``).
ABSENT = object()


def filter_calendar_window(queryset, query_params):
    """Filter timed instants and all-day civil dates without mixing semantics."""
    start = parse_datetime(query_params.get("start", "") or "")
    end = parse_datetime(query_params.get("end", "") or "")
    date_start = parse_date(query_params.get("date_start", "") or "")
    date_end = parse_date(query_params.get("date_end", "") or "")
    if date_start is None and date_end is None:
        if start:
            queryset = queryset.filter(end_at__gt=start)
        if end:
            queryset = queryset.filter(start_at__lt=end)
        return queryset

    # Civil-date bounds have no timezone with which to interpret timed rows.
    # New clients therefore send both windows; a date-only query intentionally
    # returns only all-day rows instead of accidentally returning every timed
    # event in the account.
    timed = Q(all_day=False) if start or end else Q(pk__isnull=True)
    all_day = Q(all_day=True)
    if start:
        timed &= Q(end_at__gt=start)
    if end:
        timed &= Q(start_at__lt=end)
    if date_start:
        all_day &= Q(end_date__gt=date_start)
    if date_end:
        all_day &= Q(start_date__lt=date_end)
    return queryset.filter(timed | all_day)


class MeetingRoomUnavailableError(exceptions.APIException):
    """409 — the requested meeting room is already booked for that range."""

    status_code = drf_status.HTTP_409_CONFLICT
    default_code = "meeting_room_unavailable"
    default_detail = "The meeting room is already booked for this time."


class SourceConversationVerificationError(exceptions.APIException):
    """503 - IM could not verify source-conversation membership."""

    status_code = drf_status.HTTP_503_SERVICE_UNAVAILABLE
    default_code = "source_conversation_verification_unavailable"
    default_detail = "Unable to verify source conversation membership."


class CalendarAttendeeInputSerializer(serializers.Serializer):
    """One account-backed attendee in a calendar write payload."""

    user_id = serializers.UUIDField(required=True)
    # Keep the removed field declared so DRF cannot silently discard stale
    # clients that send both an account id and an email address.
    email = serializers.CharField(required=False, write_only=True)
    role = serializers.ChoiceField(
        choices=[
            models.EventAttendeeRoleChoices.REQUIRED,
            models.EventAttendeeRoleChoices.OPTIONAL,
        ],
        default=models.EventAttendeeRoleChoices.REQUIRED,
    )

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if "email" in attrs:
            raise serializers.ValidationError(
                {"email": "Add this account as an external contact first."}
            )
        return attrs


class CalendarEventTransferSerializer(serializers.Serializer):
    """Immediate organizer transfer for one event or an entire series."""

    new_organizer_id = serializers.UUIDField(required=True)
    keep_original_organizer = serializers.BooleanField(default=True)


class CalendarEventSerializer(serializers.ModelSerializer):
    """Read + write a calendar event.

    ``attendee_entries`` is the structured account invitee input;
    legacy ``attendee_ids`` remains accepted. ``attendees`` / ``my_rsvp`` /
    ``room_slug`` are read-only enrichments.
    """

    # 组织者带头像(短时效预签名 URL,同 directory/im resolve 口径),供日程
    # 视图详情面板等处渲染「头像+名称」。
    organizer = serializers.SerializerMethodField()
    # Explicit declarations make all-day writes possible without manufacturing
    # UTC instants in the client.  The serializer derives compatibility anchors.
    start_at = serializers.DateTimeField(required=False)
    end_at = serializers.DateTimeField(required=False)
    start_date = serializers.DateField(required=False, allow_null=True)
    end_date = serializers.DateField(required=False, allow_null=True)
    # TimeZoneField → declare explicitly so it round-trips as an IANA name string.
    timezone = serializers.CharField(required=False, allow_blank=False)
    attendee_ids = serializers.ListField(
        child=serializers.UUIDField(),
        write_only=True,
        required=False,
    )
    attendee_entries = CalendarAttendeeInputSerializer(
        many=True,
        write_only=True,
        required=False,
    )
    attendees = serializers.SerializerMethodField()
    room_slug = serializers.SerializerMethodField()
    my_rsvp = serializers.SerializerMethodField()
    details_redacted = serializers.SerializerMethodField()
    # P9 实体会议室 —— 与上面的 ``room`` (LiveKit 视频房间) 毫无关系。
    # 写:``meeting_room_id``;absent = 不动,null/"" = 释放,uuid = 预订/换房。
    meeting_room = serializers.SerializerMethodField()
    meeting_room_id = serializers.CharField(
        write_only=True, required=False, allow_null=True, allow_blank=True
    )
    booking_conflict_policy = serializers.ChoiceField(
        choices=["strict", "skip"], write_only=True, required=False, default="strict"
    )
    # 视频会议是否随日程开(对标飞书「移除视频会议」)。刻意**不给 default**:
    # 创建时缺省 = True(老客户端行为不变),编辑时缺省 = 不动。给了 default
    # 之后两者就再也分不开,任何一次 PATCH 都会给「本来没有会议」的日程凭空
    # 补一个房间。读侧看 ``room`` / ``room_slug`` 是否为空即可。
    with_video_meeting = serializers.BooleanField(write_only=True, required=False)
    # Transitional write marker: old clients always submit ``default`` while
    # editing and would otherwise silently downgrade a new ``public`` event.
    visibility_explicit = serializers.BooleanField(write_only=True, required=False)
    calendar_id = serializers.UUIDField(write_only=True, required=False)
    calendar_ids = serializers.SerializerMethodField()
    display_calendar_id = serializers.SerializerMethodField()
    can_edit = serializers.SerializerMethodField()
    can_delete = serializers.SerializerMethodField()

    class Meta:
        model = models.CalendarEvent
        # ``recurrence_parent`` is read-only and only populated internally. DRF's
        # generated conditional UniqueTogetherValidator nevertheless marks
        # ``start_at`` as required before ``validate()`` gets a chance to derive
        # compatibility anchors from canonical all-day dates. The database
        # constraint remains the source of truth for materialized occurrences.
        validators = []
        fields = [
            "id",
            "title",
            "description",
            "location",
            "attachment_names",
            "start_at",
            "end_at",
            "start_date",
            "end_date",
            "timezone",
            "all_day",
            "status",
            "visibility",
            "visibility_explicit",
            "reminders",
            "organizer",
            "room",
            "room_slug",
            "attendees",
            "attendee_ids",
            "attendee_entries",
            "my_rsvp",
            "details_redacted",
            "calendar_id",
            "calendar_ids",
            "display_calendar_id",
            "can_edit",
            "can_delete",
            "created_at",
            "meeting_room",
            "meeting_room_id",
            "booking_conflict_policy",
            "with_video_meeting",
            # P2-M1 重复日程:主事件携带 RRULE;子场次 recurrence 为空、
            # recurrence_parent 指回主事件(前端据此区分删除文案)。
            "recurrence",
            "recurrence_parent",
            # P8:IM 会话来源(写入即可,不回读——防 cid 泄露给后来补拉详情的人)。
            "source_conversation_id",
        ]
        read_only_fields = [
            "id",
            "status",
            "organizer",
            "room",
            "room_slug",
            "attendees",
            "my_rsvp",
            "details_redacted",
            "calendar_ids",
            "display_calendar_id",
            "can_edit",
            "can_delete",
            "created_at",
            "recurrence_parent",
        ]
        extra_kwargs = {
            "source_conversation_id": {"write_only": True},
        }

    def validate_recurrence(self, value):
        """RRULE 合法性前置校验(dateutil 同款解析),坏串 400 而非物化时炸。"""
        value = (value or "").strip()
        if not value:
            return ""
        try:
            rrulestr(value, dtstart=datetime(2026, 1, 1, 9, 0))
        except (ValueError, TypeError) as exc:
            raise serializers.ValidationError(f"invalid RRULE: {exc}") from exc
        return value

    def validate_timezone(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("timezone cannot be blank")
        try:
            calendar_time.parse_zone(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise serializers.ValidationError("expected a valid IANA timezone") from exc
        return value

    def validate_reminders(self, value):
        """Accept no reminder or one integer lead between 0 and 2880 minutes."""
        if not isinstance(value, list):
            raise serializers.ValidationError("expected an array")
        if len(value) > 1:
            raise serializers.ValidationError("at most one reminder is allowed")
        if value:
            lead = value[0]
            if type(lead) is not int:  # bool is an int subclass; reject it too.
                raise serializers.ValidationError("reminder must be an integer")
            if not 0 <= lead <= 2880:
                raise serializers.ValidationError(
                    "reminder must be between 0 and 2880 minutes"
                )
        return value

    def validate_source_conversation_id(self, value):
        """A source conversation is create-only and cannot be rebound later."""
        if self.instance is not None:
            raise serializers.ValidationError(
                "source conversation cannot be changed after creation"
            )
        return value.strip()

    def validate_calendar_id(self, value):
        if self.instance is not None:
            raise serializers.ValidationError("calendar cannot be changed after creation")
        return value

    def get_organizer(self, obj):
        if not obj.organizer_id:
            return None
        return {
            "id": str(obj.organizer_id),
            "full_name": obj.organizer.full_name,
            "short_name": obj.organizer.short_name,
            "avatar_url": utils.generate_profile_image_get_url(
                "avatar", obj.organizer.avatar_key
            ),
        }

    def get_attendees(self, obj):
        attendees = list(obj.attendees.all())
        user_ids = [attendee.user_id for attendee in attendees if attendee.user_id]
        internal_ids = set(
            models.Membership.objects.filter(
                organization=obj.organization,
                user_id__in=user_ids,
                status=models.MembershipStatusChoices.ACTIVE,
            ).values_list("user_id", flat=True)
        )
        return [
            {
                "id": str(a.user_id) if a.user_id else None,
                "full_name": a.user.full_name if a.user_id else None,
                "email": a.email or (a.user.email if a.user_id else ""),
                "avatar_url": utils.generate_profile_image_get_url(
                    "avatar", a.user.avatar_key
                )
                if a.user_id
                else "",
                "rsvp": a.rsvp,
                "role": a.role,
                "external": not a.user_id or a.user_id not in internal_ids,
            }
            for a in attendees
        ]

    def get_details_redacted(self, obj):
        access_levels = self.context.get("event_access_levels", {})
        access = access_levels.get(obj.id)
        if access is not None:
            return access != calendar_access.EventAccess.DETAILS
        if obj.visibility != models.EventVisibilityChoices.PRIVATE:
            return False
        request = self.context.get("request")
        if request is None or not request.user.is_authenticated:
            return True
        if obj.organizer_id == request.user.id:
            return False
        return not any(a.user_id == request.user.id for a in obj.attendees.all())

    def get_calendar_ids(self, obj):
        ids = []
        if obj.source_calendar_id:
            ids.append(str(obj.source_calendar_id))
        request = self.context.get("request")
        if request is not None and (
            obj.organizer_id == request.user.id
            or any(a.user_id == request.user.id for a in obj.attendees.all())
        ):
            primary = models.Calendar.objects.filter(
                organization=obj.organization,
                owner=request.user,
                kind=models.CalendarKindChoices.PRIMARY,
                deleted_at__isnull=True,
            ).values_list("id", flat=True).first()
            if primary and str(primary) not in ids:
                ids.append(str(primary))
        room_ids = [booking.room_id for booking in obj.room_bookings.all()]
        for calendar_id in models.Calendar.objects.filter(
            kind=models.CalendarKindChoices.RESOURCE,
            meeting_room_id__in=room_ids,
            deleted_at__isnull=True,
        ).values_list("id", flat=True):
            if str(calendar_id) not in ids:
                ids.append(str(calendar_id))
        return ids

    def get_display_calendar_id(self, obj):
        ids = self.get_calendar_ids(obj)
        request = self.context.get("request")
        if request is None or not ids:
            return ids[0] if ids else None
        enabled = {
            str(value)
            for value in models.CalendarSubscription.objects.filter(
                subscriber=request.user,
                enabled=True,
                calendar_id__in=ids,
            ).values_list("calendar_id", flat=True)
        }
        return next((value for value in ids if value in enabled), ids[0])

    def _can_mutate(self, obj):
        request = self.context.get("request")
        if request is None:
            return False
        if obj.organizer_id == request.user.id:
            return True
        calendar = obj.source_calendar
        if calendar is None or not calendar_access.calendar_can_write(
            calendar, request.user
        ):
            return False
        if obj.visibility == models.EventVisibilityChoices.PRIVATE:
            return any(a.user_id == request.user.id for a in obj.attendees.all())
        return True

    def get_can_edit(self, obj):
        return self._can_mutate(obj)

    def get_can_delete(self, obj):
        return self._can_mutate(obj)

    def to_representation(self, instance):
        """Expose only the busy window of a private event to outsiders."""
        data = super().to_representation(instance)
        if not data["details_redacted"]:
            return data
        data.update(
            {
                "title": "",
                "description": "",
                "location": "",
                "attachment_names": [],
                "reminders": [],
                "organizer": None,
                "room": None,
                "room_slug": None,
                "meeting_room": None,
                "attendees": [],
                "my_rsvp": None,
                "recurrence": "",
                "recurrence_parent": None,
                "can_edit": False,
                "can_delete": False,
            }
        )
        return data

    def get_room_slug(self, obj):
        return obj.room.slug if obj.room_id else None

    def validate_meeting_room_id(self, value):
        """Resolve the room id, org-scoped. Empty string / null = release.

        Unlike ``attendee_ids`` (where out-of-org ids are silently dropped), a
        bad room id is a 400: the user explicitly picked a room, and silently
        dropping it would leave them believing it was booked.
        """
        raw = (value or "").strip()
        if not raw:
            return None
        try:
            room_uuid = uuid.UUID(raw)
        except (ValueError, TypeError) as exc:
            raise serializers.ValidationError("invalid meeting room id") from exc
        request = self.context.get("request")
        organization = (
            get_caller_organization(request.user) if request is not None else None
        )
        base = models.MeetingRoom.objects.filter(
            id=room_uuid,
            organization=organization,
            is_active=True,
            deleted_at__isnull=True,
        )
        room = base.first()
        if room is None:
            raise serializers.ValidationError("unknown or unavailable meeting room")
        # 「预定范围限制」: a separate lookup rather than one filtered query, so
        # "restricted to another department" does not masquerade as "no such
        # room" — the two need different answers from support.
        if (
            request is not None
            and not base.filter(bookable_scope_filter(request.user)).exists()
        ):
            raise serializers.ValidationError(
                "this meeting room is limited to selected departments"
            )
        return room

    def validate(self, attrs):  # noqa: PLR0912, PLR0915 - date modes are explicit
        """Normalize timed instants and canonical all-day civil dates."""
        attrs = super().validate(attrs)
        if "attendee_ids" in attrs and "attendee_entries" in attrs:
            raise serializers.ValidationError(
                {"attendee_entries": ("use attendee_entries or attendee_ids, not both")}
            )
        entries = attrs.get("attendee_entries")
        if entries is not None:
            identities = [str(entry["user_id"]) for entry in entries]
            if len(identities) != len(set(identities)):
                raise serializers.ValidationError(
                    {"attendee_entries": "duplicate attendee"}
                )
        instance = self.instance
        all_day = attrs.get("all_day", getattr(instance, "all_day", False))
        room = attrs.get("meeting_room_id")
        if room is not None and all_day:
            # Keep the product-level error stable even when a legacy client
            # supplies same-day timed anchors for an all-day request.
            raise serializers.ValidationError(
                {"meeting_room_id": "all-day events cannot book a meeting room"}
            )
        raw = self.initial_data or {}
        timezone_value = attrs.get("timezone") or getattr(instance, "timezone", None)
        if not timezone_value:
            request = self.context.get("request")
            timezone_value = (
                calendar_time.effective_calendar_timezone(request.user)
                if request is not None
                else "UTC"
            )

        if all_day:
            dates_explicit = "start_date" in raw or "end_date" in raw
            rebuild_anchors = (
                instance is None
                or dates_explicit
                or not getattr(instance, "all_day", False)
                or "timezone" in raw
            )
            if dates_explicit:
                start_date = attrs.get(
                    "start_date", getattr(instance, "start_date", None)
                )
                end_date = attrs.get("end_date", getattr(instance, "end_date", None))
                if start_date is None or end_date is None:
                    raise serializers.ValidationError(
                        {
                            "start_date": (
                                "start_date and end_date are required for all-day events"
                            )
                        }
                    )
            elif instance is not None and instance.all_day and instance.start_date:
                # Legacy clients may still submit the old anchors during a title
                # edit.  Accept exact no-op values, but never let another device
                # reinterpret them and silently move the civil date.
                for field in ("start_at", "end_at"):
                    submitted = attrs.get(field)
                    current = getattr(instance, field)
                    if submitted is not None and submitted != current:
                        raise serializers.ValidationError(
                            {
                                "start_date": (
                                    "all_day_dates_required: move all-day events "
                                    "with start_date and end_date"
                                )
                            }
                        )
                # Exact legacy echoes are not scheduling edits.
                attrs.pop("start_at", None)
                attrs.pop("end_at", None)
                start_date, end_date = instance.start_date, instance.end_date
            else:
                # Compatibility for pre-P1-9 creates and historical rows.
                legacy_start = attrs.get(
                    "start_at", getattr(instance, "start_at", None)
                )
                legacy_end = attrs.get("end_at", getattr(instance, "end_at", None))
                if legacy_start is None or legacy_end is None:
                    raise serializers.ValidationError(
                        {
                            "start_date": (
                                "start_date and end_date are required for all-day events"
                            )
                        }
                    )
                start_date, end_date = calendar_time.dates_from_legacy_anchors(
                    legacy_start, legacy_end, timezone_value
                )
                rebuild_anchors = True
            if end_date <= start_date:
                raise serializers.ValidationError(
                    {"end_date": "end_date must be later than start_date"}
                )
            if rebuild_anchors:
                attrs["start_date"] = start_date
                attrs["end_date"] = end_date
                attrs["start_at"], attrs["end_at"] = calendar_time.all_day_anchors(
                    start_date, end_date, timezone_value
                )
        else:
            if (
                instance is not None
                and instance.all_day
                and attrs.get("all_day") is False
            ):
                if "start_at" not in raw or "end_at" not in raw:
                    raise serializers.ValidationError(
                        {
                            "start_at": "start_at and end_at are required for timed events"
                        }
                    )
            if instance is None or getattr(instance, "all_day", False):
                attrs["start_date"] = None
                attrs["end_date"] = None

        start = attrs.get("start_at", getattr(instance, "start_at", None))
        end = attrs.get("end_at", getattr(instance, "end_at", None))
        if start is None or end is None:
            raise serializers.ValidationError(
                {"start_at": "start_at and end_at are required"}
            )
        if start is not None and end is not None and end <= start:
            raise serializers.ValidationError(
                {"end_at": "end_at must be later than start_at"}
            )
        if room is not None:
            self._validate_room_limits(room, attrs)
        return attrs

    def _validate_room_limits(self, room, attrs):
        """飞书「会议室预定限制」的两条数值规则:单次时长上限、最早可提前天数.

        Enforced in the serializer rather than in ``meeting_room_booking``: the
        service also runs during recurrence materialization, where re-checking
        「最早可提前」 would fail every occurrence past the horizon and strand a
        weekly series its owner cannot fix. The limits belong to *what the user
        just asked for*, which is exactly what this serializer sees.
        """
        start = attrs.get("start_at", getattr(self.instance, "start_at", None))
        end = attrs.get("end_at", getattr(self.instance, "end_at", None))
        if start is None or end is None:
            return
        if room.max_booking_minutes:
            minutes = (end - start).total_seconds() / 60
            if minutes > room.max_booking_minutes:
                raise serializers.ValidationError(
                    {
                        "meeting_room_id": (
                            "this meeting room may be booked for at most "
                            f"{room.max_booking_minutes} minutes at a time"
                        )
                    }
                )
        if room.advance_booking_days:
            horizon = django_timezone.now() + timedelta(days=room.advance_booking_days)
            if start > horizon:
                raise serializers.ValidationError(
                    {
                        "meeting_room_id": (
                            "this meeting room may be booked at most "
                            f"{room.advance_booking_days} days in advance"
                        )
                    }
                )

    def get_meeting_room(self, obj):
        booking = meeting_room_booking.pick_live_booking(obj.room_bookings.all())
        if booking is None:
            return None
        room = booking.room
        # One label cache per serializer instance: a month of events sharing a
        # few rooms costs a few ancestor lookups, not one per row.
        if not hasattr(self, "_node_label_cache"):
            self._node_label_cache = {}
        return {
            "id": str(room.id),
            "name": room.name,
            "code": room.code,
            "floor": room.floor,
            "capacity": room.capacity,
            "node": {"id": str(room.node_id), "name": room.node.name},
            "path_label": room_path_label(room, self._node_label_cache),
            "timezone": str(room.node.resolve_timezone()),
            "booking_status": booking.status,
        }

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
        # Retrieve must load the candidate before the unified access policy can
        # resolve subscriptions and source-conversation membership. Knowing an
        # event UUID is never an access grant; unauthorized retrieval remains 404.
        if self.action == "retrieve":
            return (
                models.CalendarEvent.objects.all()
                .select_related("organizer", "room", "source_calendar")
                .prefetch_related("attendees__user", "room_bookings__room__node")
            )
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.CalendarEvent.objects.none()
        user = self.request.user
        queryset = (
            models.CalendarEvent.objects.filter(
                Q(organizer=user)
                | Q(attendees__user=user)
                | Q(source_calendar__owner=user)
                | Q(source_calendar__access_grants__grantee=user)
                | Q(source_calendar__subscriptions__subscriber=user)
            )
            .distinct()
            .select_related("organizer", "room", "source_calendar")
            .prefetch_related("attendees__user", "room_bookings__room__node")
            .order_by("start_at")
        )
        # Date-range window (?start & ?end, ISO 8601) — only for the list view, so
        # retrieve/update by pk are never filtered out. Returns events overlapping
        # the window: start_at < end AND end_at > start. Unparseable params ignored.
        if self.action == "list":
            queryset = filter_calendar_window(queryset, self.request.query_params)
        return queryset

    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())
        events = []
        access_levels = {}
        for event in queryset:
            try:
                access = calendar_access.resolve_event_access(
                    event, request.user, include_source=False
                )
            except calendar_access.SourceAccessUnavailable:
                access = calendar_access.EventAccess.NONE
            if access != calendar_access.EventAccess.NONE:
                events.append(event)
                access_levels[event.id] = access
        page = self.paginate_queryset(events)
        selected = page if page is not None else events
        serializer = self.get_serializer(
            selected,
            many=True,
            context={
                **self.get_serializer_context(),
                "event_access_levels": access_levels,
            },
        )
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data)

    def handle_exception(self, exc):
        """Turn a room clash into a 409 carrying the blocking ranges.

        Done here rather than at each call site so create / update / the three
        recurring-edit branches all report it identically.
        """
        if isinstance(exc, meeting_room_booking.MeetingRoomUnavailable):
            exc = MeetingRoomUnavailableError(
                {
                    "detail": "meeting room unavailable",
                    "code": "meeting_room_unavailable",
                    "conflicts": exc.conflicts,
                }
            )
        return super().handle_exception(exc)

    def retrieve(self, request, *args, **kwargs):
        """Read through an explicit relationship, subscription, or source chat.

        UUID knowledge alone is not authorization.  A valid busy-only path gets
        the existing redacted DTO; no valid path is deliberately indistinguish-
        able from a missing event.
        """
        instance = self.get_object()
        try:
            access = calendar_access.resolve_event_access(instance, request.user)
        except calendar_access.SourceAccessUnavailable as exc:
            raise SourceConversationVerificationError(detail=str(exc)) from exc
        if access == calendar_access.EventAccess.NONE:
            raise exceptions.NotFound()
        serializer = self.serializer_class(
            instance,
            context={
                **self.get_serializer_context(),
                "event_access_levels": {instance.id: access},
            },
        )
        return Response(serializer.data)

    @staticmethod
    def _pop_room_args(data):
        """Extract the room fields from validated_data (they are not model fields).

        Returns ``(room, policy)`` where room is ``UNSET`` when the client did
        not mention it at all, ``None`` to release, or a MeetingRoom to book.
        """
        room = data.pop("meeting_room_id", meeting_room_booking.UNSET)
        policy = data.pop("booking_conflict_policy", meeting_room_booking.STRICT)
        return room, policy

    def _require_organizer(self, event):
        """Allow organizer or an eligible writer of the owning shared calendar."""
        if event.organizer_id == self.request.user.id:
            return
        calendar = event.source_calendar
        attendee = any(
            row.user_id == self.request.user.id for row in event.attendees.all()
        )
        if (
            calendar is not None
            and calendar_access.calendar_can_write(calendar, self.request.user)
            and (
                event.visibility != models.EventVisibilityChoices.PRIVATE or attendee
            )
        ):
            return
        raise exceptions.PermissionDenied("You cannot modify this event.")

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["request"] = self.request
        return context

    @staticmethod
    def _pop_attendee_entries(data):
        """Normalize the new structured input and the legacy UUID list."""
        entries = data.pop("attendee_entries", None)
        attendee_ids = data.pop("attendee_ids", None)
        if entries is not None:
            return list(entries)
        if attendee_ids is not None:
            return [
                {
                    "user_id": user_id,
                    "role": models.EventAttendeeRoleChoices.REQUIRED,
                }
                for user_id in attendee_ids
            ]
        return None

    @staticmethod
    def _attendee_identities(event) -> set[tuple[str, object]]:
        """Stable internal/external identities for attendee change diffs."""
        identities = set()
        for user_id, email in event.attendees.values_list("user_id", "email"):
            if user_id is not None:
                identities.add(("user", user_id))
            elif email:
                identities.add(("email", email.casefold()))
        return identities

    @staticmethod
    def _attendee_roles(event) -> dict[tuple[str, object], str]:
        roles = {}
        for user_id, email, role in event.attendees.values_list(
            "user_id", "email", "role"
        ):
            identity = (
                ("user", user_id)
                if user_id is not None
                else ("email", email.casefold())
            )
            roles[identity] = role
        return roles

    @staticmethod
    def _sync_attendees(event, entries, room=None) -> None:
        """Full-sync internal members and accepted external contacts."""
        internal_specs = {
            entry["user_id"]: entry["role"]
            for entry in entries
            if entry["user_id"] != event.organizer_id
        }
        same_org_ids = set(
            models.Membership.objects.filter(
                user_id__in=internal_specs,
                organization=event.organization,
                status=models.MembershipStatusChoices.ACTIVE,
            ).values_list("user_id", flat=True)
        )
        relationships = models.ExternalContact.objects.filter(
            Q(user_a=event.organizer) | Q(user_b=event.organizer),
            status=models.ExternalContactStatusChoices.ACCEPTED,
        ).values_list("user_a_id", "user_b_id")
        external_ids = {
            user_b_id if user_a_id == event.organizer_id else user_a_id
            for user_a_id, user_b_id in relationships
        }
        allowed_ids = same_org_ids | external_ids
        internal_users = list(
            models.User.objects.filter(
                id__in=set(internal_specs) & allowed_ids,
                is_active=True,
                is_device=False,
            )
            .exclude(id=event.organizer_id)
            .distinct()
        )
        target_user_ids = {user.id for user in internal_users}

        for attendee in internal_users:
            attendance, _ = models.EventAttendee.objects.get_or_create(
                event=event,
                user=attendee,
                defaults={"role": internal_specs[attendee.id]},
            )
            wanted_role = internal_specs[attendee.id]
            if attendance.role != wanted_role:
                attendance.role = wanted_role
                attendance.save(update_fields=["role", "updated_at"])
            if room is not None:
                models.ResourceAccess.objects.get_or_create(
                    resource=room,
                    user=attendee,
                    defaults={"role": models.RoleChoices.MEMBER},
                )

        removed_user_ids = set(
            event.attendees.exclude(role=models.EventAttendeeRoleChoices.ORGANIZER)
            .filter(user__isnull=False)
            .exclude(user_id__in=target_user_ids)
            .values_list("user_id", flat=True)
        )
        event.attendees.exclude(role=models.EventAttendeeRoleChoices.ORGANIZER).filter(
            user__isnull=False
        ).exclude(user_id__in=target_user_ids).delete()
        # Legacy email-only attendees remain readable, but a submitted full
        # attendee list no longer contains that identity type.
        event.attendees.exclude(role=models.EventAttendeeRoleChoices.ORGANIZER).filter(
            user__isnull=True
        ).delete()

        if room is not None and removed_user_ids:
            models.ResourceAccess.objects.filter(
                resource=room,
                user_id__in=removed_user_ids,
            ).exclude(role=models.RoleChoices.OWNER).delete()

    @staticmethod
    def _transfer_video_room_access(
        room_ids, old_organizer, new_organizer, *, keep_original: bool
    ) -> None:
        """Promote the new organizer before revoking the old Room owner role."""
        for room_id in room_ids:
            access, _ = models.ResourceAccess.objects.get_or_create(
                resource_id=room_id,
                user=new_organizer,
                defaults={"role": models.RoleChoices.OWNER},
            )
            if access.role != models.RoleChoices.OWNER:
                models.ResourceAccess.objects.filter(pk=access.pk).update(
                    role=models.RoleChoices.OWNER
                )
            old_access = models.ResourceAccess.objects.filter(
                resource_id=room_id, user=old_organizer
            )
            if keep_original:
                models.ResourceAccess.objects.update_or_create(
                    resource_id=room_id,
                    user=old_organizer,
                    defaults={"role": models.RoleChoices.MEMBER},
                )
            else:
                old_access.delete()

    @decorators.action(detail=True, methods=["post"])
    def transfer(self, request, pk=None):  # pylint: disable=unused-argument
        """Transfer ownership immediately; recurring events always move as a series.

        Only the current organizer may transfer.  The target must be an active,
        non-device member of the same organization.  The event identity, source
        conversation, video room, physical-room booking, and reminder state stay
        unchanged; organizer-dependent calendar and Room permissions move with it.
        """
        requested_event = self.get_object()
        if requested_event.organizer_id != request.user.id:
            raise exceptions.PermissionDenied(
                "Only the current organizer can transfer this event."
            )

        payload = CalendarEventTransferSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        new_organizer_id = payload.validated_data["new_organizer_id"]
        keep_original = payload.validated_data["keep_original_organizer"]
        if new_organizer_id == request.user.id:
            raise exceptions.ValidationError(
                {"new_organizer_id": "select a different organizer"}
            )

        new_organizer = (
            models.User.objects.filter(
                id=new_organizer_id,
                is_active=True,
                is_device=False,
                memberships__organization=requested_event.organization,
                memberships__status=models.MembershipStatusChoices.ACTIVE,
            )
            .distinct()
            .first()
        )
        if new_organizer is None:
            raise exceptions.ValidationError(
                {
                    "new_organizer_id": (
                        "expected an active internal member of this organization"
                    )
                }
            )

        root_id = requested_event.recurrence_parent_id or requested_event.id
        with transaction.atomic():
            root = (
                models.CalendarEvent.objects.select_for_update()
                .select_related("organizer")
                .get(id=root_id)
            )
            # Re-check under the row lock so two organizer actions cannot race.
            if root.organizer_id != request.user.id:
                raise exceptions.PermissionDenied(
                    "Only the current organizer can transfer this event."
                )
            series = list(
                models.CalendarEvent.objects.select_for_update()
                .filter(Q(id=root.id) | Q(recurrence_parent=root))
                .select_related("organizer")
                .prefetch_related("attendees__user")
            )
            old_organizer = root.organizer
            new_calendar = calendar_access.ensure_personal_calendar(
                new_organizer, root.organization
            )
            room_ids = {event.room_id for event in series if event.room_id}

            for event in series:
                old_attendance = models.EventAttendee.objects.filter(
                    event=event, user=old_organizer
                )
                if keep_original:
                    models.EventAttendee.objects.update_or_create(
                        event=event,
                        user=old_organizer,
                        defaults={
                            "role": models.EventAttendeeRoleChoices.REQUIRED,
                            "rsvp": models.EventRSVPChoices.ACCEPTED,
                        },
                    )
                else:
                    old_attendance.delete()

                new_attendance, _ = models.EventAttendee.objects.get_or_create(
                    event=event,
                    user=new_organizer,
                    defaults={
                        "role": models.EventAttendeeRoleChoices.ORGANIZER,
                        "rsvp": models.EventRSVPChoices.ACCEPTED,
                    },
                )
                if (
                    new_attendance.role
                    != models.EventAttendeeRoleChoices.ORGANIZER
                    or new_attendance.rsvp != models.EventRSVPChoices.ACCEPTED
                ):
                    new_attendance.role = models.EventAttendeeRoleChoices.ORGANIZER
                    new_attendance.rsvp = models.EventRSVPChoices.ACCEPTED
                    new_attendance.save(update_fields=["role", "rsvp", "updated_at"])

                event.organizer = new_organizer
                event.source_calendar = new_calendar
                event.save(
                    update_fields=["organizer", "source_calendar", "updated_at"]
                )

            # Keep the physical-room reservation itself unchanged, but move its
            # audit owner so later exports/admin views do not attribute the hold
            # to someone who no longer organizes the event.
            models.MeetingRoomBooking.objects.filter(
                event__in=series,
                status__in=models.ACTIVE_BOOKING_STATUSES,
            ).update(booked_by=new_organizer)

            self._transfer_video_room_access(
                room_ids,
                old_organizer,
                new_organizer,
                keep_original=keep_original,
            )

            notification_event = next(
                event for event in series if event.id == requested_event.id
            )
            recurrence_scope = (
                "all"
                if root.recurrence or requested_event.recurrence_parent_id
                else ""
            )
            delivery = calendar_im_notify.prepare_event_change(
                notification_event,
                im_cards.EVENT_KIND_ORGANIZER_CHANGED,
                recurrence_scope=recurrence_scope,
                include_organizer=True,
            )
            transaction.on_commit(
                lambda: calendar_im_notify.deliver_event_change(delivery)
            )

        requested_event.refresh_from_db()
        return Response(self.get_serializer(requested_event).data)

    def perform_create(self, serializer):
        """Create the event + its Room (organizer owner, invitees members) + attendees."""
        user = self.request.user
        organization = get_caller_organization(user)
        if organization is None:
            raise serializers.ValidationError(
                {"detail": "No active organization membership."}
            )
        data = serializer.validated_data
        requested_calendar_id = data.pop("calendar_id", None)
        data.pop("visibility_explicit", None)
        attendee_entries = self._pop_attendee_entries(data) or []
        timezone_name = data.pop("timezone", "") or str(
            calendar_time.effective_calendar_timezone(user)
        )
        meeting_room, booking_policy = self._pop_room_args(data)
        # 缺省 = 开(老客户端不传该字段,行为保持不变)。
        with_video = bool(data.pop("with_video_meeting", True))

        source_cid = data.get("source_conversation_id", "")
        if source_cid:
            try:
                calendar_im_notify.verify_source_membership(user, source_cid)
            except calendar_im_notify.SourceConversationAccessDenied as exc:
                raise exceptions.PermissionDenied(
                    "Not a member of the source conversation."
                ) from exc
            except calendar_im_notify.SourceConversationVerificationUnavailable as exc:
                raise SourceConversationVerificationError(detail=str(exc)) from exc

        with transaction.atomic():
            if requested_calendar_id is None:
                source_calendar = calendar_access.ensure_personal_calendar(
                    user, organization
                )
            else:
                source_calendar = models.Calendar.objects.filter(
                    pk=requested_calendar_id,
                    organization=organization,
                    deleted_at__isnull=True,
                ).first()
                if source_calendar is None or not calendar_access.calendar_can_write(
                    source_calendar, user
                ):
                    raise exceptions.PermissionDenied(
                        "You cannot create events in this calendar."
                    )
                if source_calendar.kind == models.CalendarKindChoices.RESOURCE:
                    raise exceptions.ValidationError(
                        {"calendar_id": "resource calendars are read-only"}
                    )
            room = None
            if with_video:
                room = models.Room.objects.create(
                    name=data["title"], scheduled_at=data["start_at"]
                )
                models.ResourceAccess.objects.create(
                    resource=room, user=user, role=models.RoleChoices.OWNER
                )
            event = serializer.save(
                organizer=user,
                organization=organization,
                source_calendar=source_calendar,
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
            # External invitees are real accepted contacts, so they receive the
            # same Room access and RSVP identity as internal members.
            self._sync_attendees(event, attendee_entries, room)
            # P9 会议室:主事件行 = 系列首场,先抢它。冲突时 strict 抛出 →
            # 整个事务回滚 → 409,日程不落库(用户改时间或换房再来)。
            # 重复日程的后续场次此刻还没物化,它们的 booking 由物化任务补建
            # (policy=skip);占用只在 60 天物化窗口内被保证——见 docs/phases/p9。
            if meeting_room not in (meeting_room_booking.UNSET, None):
                meeting_room_booking.book_for_event(
                    event, meeting_room, policy=booking_policy, booked_by=user
                )
            event_id = event.id
            transaction.on_commit(
                lambda: calendar_im_notify.notify_event_created(event_id)
            )

    @staticmethod
    def _provision_video_room(event, organizer, attendees=()):
        """Create the event's LiveKit room and grant everyone access.

        Used both when an event is created with a video meeting and when one is
        added back to an event that had none.
        """
        room = models.Room.objects.create(name=event.title, scheduled_at=event.start_at)
        models.ResourceAccess.objects.create(
            resource=room, user=organizer, role=models.RoleChoices.OWNER
        )
        for attendee in attendees:
            models.ResourceAccess.objects.get_or_create(
                resource=room,
                user=attendee,
                defaults={"role": models.RoleChoices.MEMBER},
            )
        return room

    def _apply_video_meeting(self, event, wanted):
        """Add / remove the event's video meeting on edit. Returns True if changed.

        Removing only **detaches** the room, it does not delete it — same
        reasoning as ``perform_destroy``: a recording or an in-progress call
        must not be yanked out from under whoever is in it. Re-adding therefore
        mints a fresh room (and a fresh meeting number), which is what
        「移除视频会议」 means anywhere else too.
        """
        if wanted is ABSENT or bool(wanted) == (event.room_id is not None):
            return False
        if wanted:
            attendees = models.User.objects.filter(
                event_attendances__event=event
            ).exclude(id=event.organizer_id)
            event.room = self._provision_video_room(event, event.organizer, attendees)
        else:
            event.room = None
        event.save(update_fields=["room", "updated_at"])
        return True

    def _resync_series_room(self, parent, meeting_room):
        """Apply an explicit room change across a whole series.

        Retiming an existing booking is already handled inside
        ``calendar_recurrence``; this runs only when the caller actually named a
        different room (or cleared it), and then it has to reach every future
        occurrence — each holds its own booking row.

        ``skip``, not ``strict``: a series edit touches dozens of occurrences,
        and refusing the whole thing because occurrence #7 is taken would leave
        the user unable to edit their own recurring meeting at all. Occurrences
        that miss out are recorded as ``conflict`` and surfaced per-occurrence.
        """
        if meeting_room is meeting_room_booking.UNSET:
            return
        meeting_room_booking.resync_event_booking(
            parent,
            room=meeting_room,
            policy=meeting_room_booking.SKIP,
            booked_by=self.request.user,
        )
        for child in parent.occurrences.filter(start_at__gte=django_timezone.now()):
            meeting_room_booking.resync_event_booking(
                child,
                room=meeting_room,
                policy=meeting_room_booking.SKIP,
                booked_by=self.request.user,
            )
        meeting_room_booking.invalidate_booking_cache(parent)

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

    @staticmethod
    def _maybe_rearm_reminder(event, *, schedule_changed: bool) -> None:
        """Clear a handled reminder only when its new trigger is still future."""
        if not schedule_changed or event.reminder_pushed_at is None:
            return
        trigger_at = calendar_reminders.reminder_trigger_at(
            event.start_at, event.reminders
        )
        if trigger_at is None or trigger_at <= django_timezone.now():
            return
        event.reminder_pushed_at = None
        event.reminder_outcome = ""
        event.save(
            update_fields=["reminder_pushed_at", "reminder_outcome", "updated_at"]
        )

    @staticmethod
    def _queue_recurring_time_change(  # noqa: PLR0913 - card window is explicit
        event,
        *,
        recurrence_scope: str,
        old_start,
        old_end,
        old_start_date,
        old_end_date,
        display_start,
        display_end,
        display_start_date,
        display_end_date,
    ) -> None:
        """Emit one range-aware card for one recurring edit operation."""
        if event.all_day and old_start_date and display_start_date:
            unchanged = (old_start_date, old_end_date) == (
                display_start_date,
                display_end_date,
            )
        else:
            unchanged = (old_start, old_end) == (display_start, display_end)
        if unchanged:
            return
        delivery = calendar_im_notify.prepare_event_change(
            event,
            "time_changed",
            old_start=old_start,
            old_end=old_end,
            old_start_date=old_start_date,
            old_end_date=old_end_date,
            recurrence_scope=recurrence_scope,
            display_start=display_start,
            display_end=display_end,
            display_start_date=display_start_date,
            display_end_date=display_end_date,
        )
        transaction.on_commit(lambda: calendar_im_notify.deliver_event_change(delivery))

    def update(self, request, *args, **kwargs):  # noqa: PLR0915 - scope branches
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

        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        visibility_explicit = bool(
            serializer.validated_data.pop("visibility_explicit", False)
        )
        if (
            instance.visibility == models.EventVisibilityChoices.PUBLIC
            and serializer.validated_data.get("visibility")
            == models.EventVisibilityChoices.DEFAULT
            and not visibility_explicit
        ):
            # Legacy Web/App always serialized a default/private switch even
            # when the user only changed another field.  Preserve a public
            # event unless a v2 client marks the visibility change as explicit.
            serializer.validated_data.pop("visibility")

        parent = instance.recurrence_parent
        is_recurring = parent is not None or bool(instance.recurrence)
        if not is_recurring:
            self.perform_update(serializer)
            return Response(serializer.data)

        if any(
            key in (request.data or {}) for key in ("attendee_ids", "attendee_entries")
        ):
            submitted_field = (
                "attendee_entries"
                if "attendee_entries" in (request.data or {})
                else "attendee_ids"
            )
            raise exceptions.ValidationError(
                {submitted_field: "attendees cannot be changed on recurring events"}
            )

        data = dict(serializer.validated_data)
        old_start, old_end = instance.start_at, instance.end_at
        old_start_date, old_end_date = instance.start_date, instance.end_date
        duration = old_end - old_start
        display_start = data.get("start_at", old_start)
        display_end = data.get(
            "end_at",
            display_start + duration if "start_at" in data else old_end,
        )
        display_start_date = data.get("start_date", old_start_date)
        display_end_date = data.get("end_date", old_end_date)
        reminder_schedule_changed = "start_at" in data or "reminders" in data
        # 会议室在三选分支里单独处理:series 级用 skip(一场冲突不该让用户
        # 彻底改不动系列),单场 one 用调用方给的 policy(默认 strict)。
        meeting_room, booking_policy = self._pop_room_args(data)
        # 系列级(all / following)刻意不支持增删视频会议:改一次要同步重写整
        # 串已物化子场次的 room,与 attendee_ids 在三选路径下被剔除是同一档
        # 降级(前端同样对重复日程隐藏该控件)。仅「仅此次」按单场处理。
        with_video = data.pop("with_video_meeting", ABSENT)
        for excluded in (
            "attendee_ids",
            "attendee_entries",
            "recurrence",
        ):
            data.pop(excluded, None)

        if parent is not None and scope == "following":
            new_parent = calendar_recurrence.split_series(
                instance,
                data,
                schedule_changed=reminder_schedule_changed,
            )
            self._maybe_rearm_reminder(
                new_parent, schedule_changed=reminder_schedule_changed
            )
            self._resync_series_room(new_parent, meeting_room)
            self._queue_recurring_time_change(
                new_parent,
                recurrence_scope="following",
                old_start=old_start,
                old_end=old_end,
                old_start_date=old_start_date,
                old_end_date=old_end_date,
                display_start=display_start,
                display_end=display_end,
                display_start_date=display_start_date,
                display_end_date=display_end_date,
            )
            return Response(self.get_serializer(new_parent).data)

        if parent is not None and scope == "all":
            updated = calendar_recurrence.edit_series_all(
                parent,
                instance.start_at,
                data,
                schedule_changed=reminder_schedule_changed,
            )
            self._maybe_rearm_reminder(
                updated, schedule_changed=reminder_schedule_changed
            )
            self._sync_room(updated)
            self._resync_series_room(updated, meeting_room)
            self._queue_recurring_time_change(
                updated,
                recurrence_scope="all",
                old_start=old_start,
                old_end=old_end,
                old_start_date=old_start_date,
                old_end_date=old_end_date,
                display_start=display_start,
                display_end=display_end,
                display_start_date=display_start_date,
                display_end_date=display_end_date,
            )
            return Response(self.get_serializer(updated).data)

        if parent is None:
            # 主事件 = 系列锚点:任何 scope 都按「全部」处理。
            updated = calendar_recurrence.edit_series_all(
                instance,
                instance.start_at,
                data,
                schedule_changed=reminder_schedule_changed,
            )
            self._maybe_rearm_reminder(
                updated, schedule_changed=reminder_schedule_changed
            )
            self._sync_room(updated)
            self._resync_series_room(updated, meeting_room)
            self._queue_recurring_time_change(
                updated,
                recurrence_scope="all",
                old_start=old_start,
                old_end=old_end,
                old_start_date=old_start_date,
                old_end_date=old_end_date,
                display_start=display_start,
                display_end=display_end,
                display_start_date=display_start_date,
                display_end_date=display_end_date,
            )
            return Response(self.get_serializer(updated).data)

        # 子场次缺省 / one:改行 + 主事件记原时刻 exdate。
        original_start = instance.start_at
        try:
            with transaction.atomic():
                event = serializer.save()
                self._maybe_rearm_reminder(
                    event, schedule_changed=reminder_schedule_changed
                )
                self._apply_video_meeting(event, with_video)
                meeting_room_booking.resync_event_booking(
                    event,
                    room=meeting_room,
                    policy=booking_policy,
                    booked_by=request.user,
                )
                meeting_room_booking.invalidate_booking_cache(event)
                exdates = list(parent.recurrence_exdates or [])
                key = original_start.isoformat()
                if key not in exdates:
                    exdates.append(key)
                    parent.recurrence_exdates = exdates
                    parent.save(update_fields=["recurrence_exdates", "updated_at"])
                self._queue_recurring_time_change(
                    event,
                    recurrence_scope="one",
                    old_start=old_start,
                    old_end=old_end,
                    old_start_date=old_start_date,
                    old_end_date=old_end_date,
                    display_start=event.start_at,
                    display_end=event.end_at,
                    display_start_date=event.start_date,
                    display_end_date=event.end_date,
                )
        except IntegrityError as exc:
            # 撞 (recurrence_parent, start_at) 唯一索引 = 移到了别的场次槽位。
            raise exceptions.ValidationError(
                {"start_at": "another occurrence already exists at this time"}
            ) from exc
        return Response(self.get_serializer(event).data)

    def perform_update(self, serializer):
        """Organizer-only edit. Syncs the linked Room's name / scheduled_at so a
        reschedule (or rename) stays consistent.

        参与者(P8 编辑增删):``attendee_ids`` 缺省(None)= 不动;传列表 =
        **全量同步** —— 列表内新面孔补建 attendee + room member,不在列表的
        既有参与者删行并移出 room(组织者恒保留,不受列表影响)。重复日程
        显式提交 attendee_ids 会在 update() 中返回 400,不经此逻辑。

        P8 变更推送(仅非重复日程走此路径):save 前快照 start/end + attendee
        集合 → 值差分 → ``transaction.on_commit`` 推 event-card。防噪规则:
        改标题/描述/提醒不推;幂等 PATCH 不推;时间+人同变只发一张
        time_changed(携增删计数)。当前参与者收到个人变更卡；新增者收到
        邀请卡、移除者收到移除卡。RSVP 由独立 action 通知组织者。
        """
        self._require_organizer(serializer.instance)
        instance = serializer.instance
        old_start, old_end = instance.start_at, instance.end_at
        old_start_date, old_end_date = instance.start_date, instance.end_date
        old_attendees = self._attendee_identities(instance)
        old_attendee_roles = self._attendee_roles(instance)
        old_internal_ids = {
            identity for kind, identity in old_attendees if kind == "user"
        }
        data = serializer.validated_data
        reminder_schedule_changed = "start_at" in data or "reminders" in data
        attendee_entries = self._pop_attendee_entries(data)
        meeting_room, booking_policy = self._pop_room_args(data)
        # 编辑时缺省 = 不动(见字段注释),所以哨兵不是 True/False 而是 ABSENT。
        with_video = data.pop("with_video_meeting", ABSENT)
        with transaction.atomic():
            event = serializer.save()
            self._maybe_rearm_reminder(
                event, schedule_changed=reminder_schedule_changed
            )
            self._apply_video_meeting(event, with_video)
            self._sync_room(event)
            # P9 会议室:单次日程用 strict —— 用户明确改了这一场,订不上就该
            # 直说(409),而不是悄悄留下一个没订到房的日程。
            meeting_room_booking.resync_event_booking(
                event,
                room=meeting_room,
                policy=booking_policy,
                booked_by=self.request.user,
            )
            meeting_room_booking.invalidate_booking_cache(event)
            if attendee_entries is not None:
                self._sync_attendees(event, attendee_entries, event.room)

            new_attendees = self._attendee_identities(event)
            new_attendee_roles = self._attendee_roles(event)
            new_internal_ids = {
                identity for kind, identity in new_attendees if kind == "user"
            }
            kind = None
            schedule_changed = (
                (event.start_date, event.end_date) != (old_start_date, old_end_date)
                if event.all_day and event.start_date
                else (event.start_at, event.end_at) != (old_start, old_end)
            )
            if schedule_changed:
                kind = "time_changed"
            elif (
                new_attendees != old_attendees
                or new_attendee_roles != old_attendee_roles
            ):
                kind = "attendees_changed"
            if kind:
                added_user_ids = new_internal_ids - old_internal_ids
                removed_user_ids = old_internal_ids - new_internal_ids
                delivery = calendar_im_notify.prepare_event_change(
                    event,
                    kind,
                    old_start=old_start,
                    old_end=old_end,
                    old_start_date=old_start_date,
                    old_end_date=old_end_date,
                    added_count=len(new_attendees - old_attendees),
                    removed_count=len(old_attendees - new_attendees),
                    added_user_ids=added_user_ids,
                    removed_user_ids=removed_user_ids,
                )
                transaction.on_commit(
                    lambda: calendar_im_notify.deliver_event_change(delivery)
                )

    def destroy(self, request, *args, **kwargs):
        """Delete one occurrence, following occurrences, or the whole series."""
        instance = self.get_object()
        self._require_organizer(instance)
        scope = str(request.query_params.get("scope") or "").strip()
        if scope not in ("", "one", "following", "all"):
            raise exceptions.ValidationError(
                {"scope": "expected one | following | all"}
            )

        parent = instance.recurrence_parent
        if parent is not None:
            scope = scope or "one"
            if scope == "following":
                self._delete_following_with_notification(instance)
            elif scope == "all":
                self._delete_with_notification(
                    parent,
                    notification_event=instance,
                    recurrence_scope="all",
                )
            else:
                self._delete_with_notification(
                    instance,
                    recurrence_scope="one",
                )
            return Response(status=drf_status.HTTP_204_NO_CONTENT)

        if instance.recurrence:
            if scope not in ("", "all"):
                raise exceptions.ValidationError(
                    {"scope": "a recurring parent can only be deleted with all"}
                )
            self._delete_with_notification(instance, recurrence_scope="all")
            return Response(status=drf_status.HTTP_204_NO_CONTENT)

        if scope not in ("", "one"):
            raise exceptions.ValidationError(
                {"scope": "following and all require a recurring event"}
            )
        self._delete_with_notification(instance)
        return Response(status=drf_status.HTTP_204_NO_CONTENT)

    def perform_destroy(self, instance):
        """DRF hook retained for internal callers; HTTP DELETE uses destroy()."""
        self._require_organizer(instance)
        recurrence_scope = (
            "one"
            if instance.recurrence_parent_id
            else "all"
            if instance.recurrence
            else ""
        )
        self._delete_with_notification(
            instance,
            recurrence_scope=recurrence_scope,
        )

    @staticmethod
    def _cancel_snapshot(event, recurrence_scope: str):
        """Freeze a cancellation card before its event rows are deleted."""
        cancel_cid = event.source_conversation_id
        cancel_card = calendar_im_notify.build_event_card(
            event,
            "cancelled",
            recurrence_scope=recurrence_scope,
        )
        source_card = calendar_im_notify.redact_private_source_card(cancel_card)
        personal_card = calendar_im_notify.private_personal_card(cancel_card)
        attendee_user_ids = tuple(event.attendees.values_list("user_id", flat=True))
        return (
            cancel_cid,
            source_card,
            personal_card,
            event.organizer,
            attendee_user_ids,
        )

    def _delete_following_with_notification(self, instance) -> None:
        (
            cancel_cid,
            source_card,
            personal_card,
            cancel_organizer,
            attendee_user_ids,
        ) = self._cancel_snapshot(instance, "following")
        with transaction.atomic():
            calendar_recurrence.delete_following(instance)
            transaction.on_commit(
                lambda: calendar_im_notify.notify_event_cancelled(
                    cancel_cid,
                    source_card,
                    organizer=cancel_organizer,
                    attendee_user_ids=attendee_user_ids,
                    personal_card=personal_card,
                )
            )

    def _delete_with_notification(
        self,
        instance,
        *,
        recurrence_scope: str = "",
        notification_event=None,
    ) -> None:
        """Delete with existing recurrence semantics and emit one card."""
        card_event = notification_event or instance
        (
            cancel_cid,
            source_card,
            personal_card,
            cancel_organizer,
            attendee_user_ids,
        ) = self._cancel_snapshot(card_event, recurrence_scope)

        with transaction.atomic():
            parent = instance.recurrence_parent
            if parent is not None:
                exdates = list(parent.recurrence_exdates or [])
                key = instance.start_at.isoformat()
                if key not in exdates:
                    exdates.append(key)
                    parent.recurrence_exdates = exdates
                    parent.save(update_fields=["recurrence_exdates", "updated_at"])
            elif instance.recurrence:
                instance.occurrences.filter(
                    start_at__gte=django_timezone.now()
                ).delete()
            instance.delete()
            transaction.on_commit(
                lambda: calendar_im_notify.notify_event_cancelled(
                    cancel_cid,
                    source_card,
                    organizer=cancel_organizer,
                    attendee_user_ids=attendee_user_ids,
                    personal_card=personal_card,
                )
            )

    @decorators.action(detail=False, methods=["get"], url_path="freebusy")
    def freebusy(self, request):  # noqa: PLR0912 - validation and merge branches
        """P2-M3 忙闲视图:`?attendee_ids=a,b&start=ISO&end=ISO` → 每人 busy 区间。

        只返回区间,**不泄露标题/详情**(private 事件同样只出区间)。busy 口径:
        该人 rsvp≠declined 的 CONFIRMED 事件与窗口的交集,**仅重叠**区间合并
        ——首尾相接(20-21 + 21-22)保留边界,客户端才能画出两个色块(飞书
        同款;P8-UX 反馈:相接合并后群成员日历看不出是两个日程)。
        attendee_ids 按组织隔离过滤(跨组织 id 静默丢弃,同建事件口径);
        窗口上限 31 天。

        P8 编辑增删参与者修正:可选 ``exclude_event_id`` —— 编辑日程时把
        **该日程本身**从忙闲里剔除,否则原参与者必然在其自身时段「忙碌」
        而被误报冲突。非法 id 静默忽略。
        """
        organization = get_caller_organization(request.user)
        if organization is None:
            return Response({"results": []})

        raw_ids = []
        for raw_chunk in str(request.query_params.get("attendee_ids") or "").split(","):
            chunk = raw_chunk.strip()
            if not chunk:
                continue
            try:
                raw_ids.append(uuid.UUID(chunk))
            except ValueError:
                continue  # 非法 id 静默丢弃
        start = parse_datetime(request.query_params.get("start", "") or "")
        end = parse_datetime(request.query_params.get("end", "") or "")
        if not raw_ids or not start or not end or end <= start:
            raise exceptions.ValidationError(
                {"detail": "attendee_ids, start and end (ISO, end > start) required"}
            )
        if end - start > timedelta(days=31):
            raise exceptions.ValidationError(
                {"detail": "window too large (max 31 days)"}
            )

        exclude_event_id = None
        raw_exclude = str(request.query_params.get("exclude_event_id") or "").strip()
        if raw_exclude:
            try:
                exclude_event_id = uuid.UUID(raw_exclude)
            except ValueError:
                pass  # 非法 id 静默忽略(与 attendee_ids 口径一致)

        same_org_ids = set(
            models.Membership.objects.filter(
                user_id__in=raw_ids,
                organization=organization,
                status=models.MembershipStatusChoices.ACTIVE,
            ).values_list("user_id", flat=True)
        )
        external_pairs = models.ExternalContact.objects.filter(
            Q(user_a=request.user) | Q(user_b=request.user),
            status=models.ExternalContactStatusChoices.ACCEPTED,
        ).values_list("user_a_id", "user_b_id")
        external_ids = {
            user_b_id if user_a_id == request.user.id else user_a_id
            for user_a_id, user_b_id in external_pairs
        }
        users = models.User.objects.filter(
            id__in=(set(raw_ids) & (same_org_ids | external_ids)),
            is_active=True,
            is_device=False,
        ).distinct()

        qs = models.EventAttendee.objects.filter(
            user__in=users,
            event__status=models.EventStatusChoices.CONFIRMED,
            event__start_at__lt=end,
            event__end_at__gt=start,
        ).exclude(rsvp=models.EventRSVPChoices.DECLINED)
        if exclude_event_id is not None:
            qs = qs.exclude(event_id=exclude_event_id)
        rows = qs.values_list("user_id", "event__start_at", "event__end_at")
        busy_map = {str(u.id): [] for u in users}
        for uid, s_at, e_at in rows:
            busy_map[str(uid)].append((max(s_at, start), min(e_at, end)))

        results = []
        for uid, intervals in busy_map.items():
            merged = []
            for s_at, e_at in sorted(intervals):
                # 严格 < :首尾相接不合并,保留两个日程的边界。
                if merged and s_at < merged[-1][1]:
                    merged[-1] = (merged[-1][0], max(merged[-1][1], e_at))
                else:
                    merged.append((s_at, e_at))
            results.append(
                {
                    "user_id": uid,
                    "busy": [
                        {"start": s.isoformat(), "end": e.isoformat()}
                        for s, e in merged
                    ],
                }
            )
        return Response({"results": results})

    @decorators.action(detail=True, methods=["post"])
    def rsvp(self, request, pk=None):  # pylint: disable=unused-argument
        """Set the caller's RSVP on this event (must be an attendee)."""
        event = self.get_object()
        if event.organizer_id == request.user.id:
            raise exceptions.PermissionDenied(
                "The organizer's RSVP is fixed as accepted."
            )
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
        if attendee.rsvp != status_value:
            with transaction.atomic():
                attendee.rsvp = status_value
                attendee.save(update_fields=["rsvp", "updated_at"])
                event_id = event.id
                responder_id = request.user.id
                transaction.on_commit(
                    lambda: calendar_im_notify.notify_event_rsvp(
                        event_id,
                        responder_id,
                        status_value,
                    )
                )
        return Response({"status": status_value}, status=drf_status.HTTP_200_OK)
