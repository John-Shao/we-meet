"""Calendar / scheduling API (P2 — 日历/日程).

CalendarEvent CRUD + RSVP, scoped to the caller's organization. Creating an
event also provisions its join target — a Room owned by the organizer with the
invitees as members, with ``scheduled_at`` set — and records EventAttendee rows.
The room's IM group is left lazy (provisioned by ``/rooms/{id}/im/ensure-group``
on first need / by the reminder job in P2-c), so event creation never depends on
jusi-light-im being reachable.
"""

import uuid
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone as django_timezone
from django.utils.dateparse import parse_datetime

from rest_framework import decorators, exceptions, serializers, viewsets
from rest_framework import status as drf_status
from rest_framework.response import Response

from core import models, utils
from core.api import permissions
from core.api.directory import get_caller_organization
from core.api.meeting_rooms import bookable_scope_filter, room_path_label
from core.api.viewsets import Pagination
from core.services import calendar_im_notify, calendar_recurrence, meeting_room_booking

#: "the client did not mention this field at all" — distinct from an explicit
#: ``false``. Only meaningful for fields whose absence and whose ``false`` must
#: do different things (see ``with_video_meeting``).
ABSENT = object()


class MeetingRoomUnavailableError(exceptions.APIException):
    """409 — the requested meeting room is already booked for that range."""

    status_code = drf_status.HTTP_409_CONFLICT
    default_code = "meeting_room_unavailable"
    default_detail = "The meeting room is already booked for this time."


class CalendarEventSerializer(serializers.ModelSerializer):
    """Read + write a calendar event.

    ``attendee_ids`` (write-only) is the list of we-meet user ids to invite;
    ``attendees`` / ``my_rsvp`` / ``room_slug`` are read-only enrichments.
    """

    # 组织者带头像(短时效预签名 URL,同 directory/im resolve 口径),供日程
    # 视图详情面板等处渲染「头像+名称」。
    organizer = serializers.SerializerMethodField()
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
        from datetime import datetime

        from dateutil.rrule import rrulestr

        try:
            rrulestr(value, dtstart=datetime(2026, 1, 1, 9, 0))
        except (ValueError, TypeError) as exc:
            raise serializers.ValidationError(f"invalid RRULE: {exc}") from exc
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
            }
            for a in obj.attendees.all()
        ]

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

    def validate(self, attrs):
        """All-day events cannot hold a room (M1) — see docs/phases/p9."""
        attrs = super().validate(attrs)
        room = attrs.get("meeting_room_id")
        all_day = attrs.get("all_day", getattr(self.instance, "all_day", False))
        if room is not None and all_day:
            raise serializers.ValidationError(
                {"meeting_room_id": "all-day events cannot book a meeting room"}
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
        # 分享日程到聊天:详情放宽为「凭 event_id 只读」——群里的非参与人点开
        # 分享卡片也能看基本信息(标题/时间/组织者/入会),语义同「拿到链接就能看」。
        # **只放宽 retrieve**,其余一律不动:list 仍只列自己的;update/destroy 走
        # 下面的受限 queryset + _require_organizer;rsvp 同样走受限 queryset,
        # 因此非参与人拿不到对象、无法表态。不做组织过滤——群本就可跨组织
        # (与云文档分享授权同口径)。
        if self.action == "retrieve":
            return (
                models.CalendarEvent.objects.all()
                .select_related("organizer", "room")
                .prefetch_related("attendees__user", "room_bookings__room__node")
            )
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.CalendarEvent.objects.none()
        user = self.request.user
        queryset = (
            models.CalendarEvent.objects.filter(organization=organization)
            .filter(Q(organizer=user) | Q(attendees__user=user))
            .distinct()
            .select_related("organizer", "room")
            .prefetch_related("attendees__user", "room_bookings__room__node")
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
        meeting_room, booking_policy = self._pop_room_args(data)
        # 缺省 = 开(老客户端不传该字段,行为保持不变)。
        with_video = bool(data.pop("with_video_meeting", True))

        with transaction.atomic():
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
                if room is not None:
                    models.ResourceAccess.objects.get_or_create(
                        resource=room,
                        user=attendee,
                        defaults={"role": models.RoleChoices.MEMBER},
                    )
            # P9 会议室:主事件行 = 系列首场,先抢它。冲突时 strict 抛出 →
            # 整个事务回滚 → 409,日程不落库(用户改时间或换房再来)。
            # 重复日程的后续场次此刻还没物化,它们的 booking 由物化任务补建
            # (policy=skip);占用只在 60 天物化窗口内被保证——见 docs/phases/p9。
            if meeting_room not in (meeting_room_booking.UNSET, None):
                meeting_room_booking.book_for_event(
                    event, meeting_room, policy=booking_policy, booked_by=user
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

        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)

        parent = instance.recurrence_parent
        is_recurring = parent is not None or bool(instance.recurrence)
        if not is_recurring:
            self.perform_update(serializer)
            return Response(serializer.data)

        data = dict(serializer.validated_data)
        # 会议室在三选分支里单独处理:series 级用 skip(一场冲突不该让用户
        # 彻底改不动系列),单场 one 用调用方给的 policy(默认 strict)。
        meeting_room, booking_policy = self._pop_room_args(data)
        # 系列级(all / following)刻意不支持增删视频会议:改一次要同步重写整
        # 串已物化子场次的 room,与 attendee_ids 在三选路径下被剔除是同一档
        # 降级(前端同样对重复日程隐藏该控件)。仅「仅此次」按单场处理。
        with_video = data.pop("with_video_meeting", ABSENT)
        for excluded in ("attendee_ids", "timezone", "recurrence"):
            data.pop(excluded, None)

        if parent is not None and scope == "following":
            new_parent = calendar_recurrence.split_series(instance, data)
            self._resync_series_room(new_parent, meeting_room)
            return Response(self.get_serializer(new_parent).data)

        if parent is not None and scope == "all":
            updated = calendar_recurrence.edit_series_all(
                parent, instance.start_at, data
            )
            self._sync_room(updated)
            self._resync_series_room(updated, meeting_room)
            return Response(self.get_serializer(updated).data)

        if parent is None:
            # 主事件 = 系列锚点:任何 scope 都按「全部」处理。
            updated = calendar_recurrence.edit_series_all(
                instance, instance.start_at, data
            )
            self._sync_room(updated)
            self._resync_series_room(updated, meeting_room)
            return Response(self.get_serializer(updated).data)

        # 子场次缺省 / one:改行 + 主事件记原时刻 exdate。
        original_start = instance.start_at
        try:
            with transaction.atomic():
                event = serializer.save()
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
        既有参与者删行并移出 room(组织者恒保留,不受列表影响)。重复日程的
        三选路径在 update() 里已剔除 attendee_ids,不经此逻辑。

        P8 变更推送(仅非重复日程走此路径):save 前快照 start/end + attendee
        集合 → 值差分 → ``transaction.on_commit`` 推 event-card。防噪规则:
        改标题/描述/提醒不推;幂等 PATCH 不推;时间+人同变只发一张
        time_changed(携增删计数);RSVP 不经此路径天然不推。
        """
        self._require_organizer(serializer.instance)
        instance = serializer.instance
        old_start, old_end = instance.start_at, instance.end_at
        old_attendees = set(instance.attendees.values_list("user_id", flat=True))
        data = serializer.validated_data
        attendee_ids = data.pop("attendee_ids", None)
        meeting_room, booking_policy = self._pop_room_args(data)
        # 编辑时缺省 = 不动(见字段注释),所以哨兵不是 True/False 而是 ABSENT。
        with_video = data.pop("with_video_meeting", ABSENT)
        with transaction.atomic():
            event = serializer.save()
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
            if attendee_ids is not None:
                room = event.room
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
                target_ids = set()
                for attendee in invited:
                    target_ids.add(attendee.id)
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
                # 全量同步的删除侧:不在目标列表的非组织者参与者移除,并同步
                # 移出 room 成员(OWNER=组织者,保险起见永不删)。
                removed_ids = old_attendees - target_ids - {event.organizer_id}
                if removed_ids:
                    event.attendees.filter(user_id__in=removed_ids).delete()
                    if room is not None:
                        models.ResourceAccess.objects.filter(
                            resource=room, user_id__in=removed_ids
                        ).exclude(role=models.RoleChoices.OWNER).delete()

            if event.source_conversation_id:
                new_attendees = set(event.attendees.values_list("user_id", flat=True))
                kind = None
                if (event.start_at, event.end_at) != (old_start, old_end):
                    kind = "time_changed"
                elif new_attendees != old_attendees:
                    kind = "attendees_changed"
                if kind:
                    added = len(new_attendees - old_attendees)
                    removed = len(old_attendees - new_attendees)
                    transaction.on_commit(
                        lambda: calendar_im_notify.notify_event_change(
                            event.id,
                            kind,
                            old_start=old_start,
                            old_end=old_end,
                            added_count=added,
                            removed_count=removed,
                        )
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

        # P8:取消卡快照必须在删除前组好(行与 attendees 马上级联消失);
        # 子场次不携带 source_conversation_id(物化不复制)→ 天然不推。
        # 组织者一并快照 —— 卡片以其 IM 身份发出(P8-UX 组织者气泡)。
        cancel_cid = instance.source_conversation_id
        cancel_card = (
            calendar_im_notify.build_event_card(instance, "cancelled")
            if cancel_cid
            else None
        )
        cancel_organizer = instance.organizer if cancel_cid else None

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
            if cancel_card is not None:
                transaction.on_commit(
                    lambda: calendar_im_notify.push_card(
                        cancel_cid, cancel_card, organizer=cancel_organizer
                    )
                )

    @decorators.action(detail=False, methods=["get"], url_path="freebusy")
    def freebusy(self, request):
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
        for chunk in str(request.query_params.get("attendee_ids") or "").split(","):
            chunk = chunk.strip()
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

        users = models.User.objects.filter(
            id__in=raw_ids,
            memberships__organization=organization,
            memberships__status=models.MembershipStatusChoices.ACTIVE,
        ).distinct()

        qs = models.EventAttendee.objects.filter(
            user__in=users,
            event__organization=organization,
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
