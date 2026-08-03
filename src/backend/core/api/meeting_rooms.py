"""Meeting-room browsing API (P9 会议室) — the C-side, read-only half.

Three shapes of question, three endpoints:

- *what rooms exist?* — ``/meeting-room-nodes/`` + ``/meeting-rooms/``
- *which are free between X and Y?* — ``/meeting-rooms/availability/``, the
  picker behind 「添加会议室」
- *who has this floor booked today?* — ``/meeting-rooms/timeline/``, the
  horizontal timeline tab

Booking happens through the calendar API (a room is a field on an event), not
here — so "cancel the event" releases the room for free. Admin CRUD lives in
``core/api/admin_meeting_rooms.py``.

Privacy follows the existing freebusy precedent: availability returns *ranges
only*, never titles. The timeline is a "who took this room" board, so it always
names the organizer, but hides the title of private events from outsiders.
"""

import uuid
from datetime import datetime, time as dt_time, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db.models import Q
from django.utils.dateparse import parse_date, parse_datetime

from rest_framework import decorators, exceptions, mixins, viewsets
from rest_framework.response import Response

from core import models, utils
from core.api import permissions
from core.api.directory import get_caller_membership, get_caller_organization
from core.api.viewsets import Pagination

#: Availability windows are a picker aid, not a report.
MAX_AVAILABILITY_DAYS = 31
#: The timeline renders a day (occasionally a week); anything more is a mistake.
MAX_TIMELINE_DAYS = 7
MAX_TIMELINE_ROOMS = 200


def node_path_label(node, cache=None):
    """``北京 · A 座 · 3F`` — the node's ancestors and itself, root first.

    ``cache`` is an optional dict reused across calls in one request so a list
    of events sharing a handful of rooms costs a handful of queries, not one
    per row.
    """
    if node is None:
        return ""
    cache = {} if cache is None else cache
    if node.id in cache:
        return cache[node.id]
    ids = node.ancestor_ids()
    names = []
    if ids:
        by_id = {
            row.id: row.name
            for row in models.MeetingRoomNode.objects.filter(id__in=ids).only(
                "id", "name"
            )
        }
        names = [by_id[i] for i in ids if i in by_id]
    label = " · ".join(names + [node.name])
    cache[node.id] = label
    return label


def _parse_window(params, *, max_days, required=True):
    """``?start=&end=`` as aware datetimes, validated as a sane window."""
    start = parse_datetime(params.get("start", "") or "")
    end = parse_datetime(params.get("end", "") or "")
    if not start or not end:
        if not required:
            return None, None
        raise exceptions.ValidationError(
            {"detail": "start and end (ISO 8601) are required"}
        )
    if end <= start:
        raise exceptions.ValidationError({"detail": "end must be after start"})
    if end - start > timedelta(days=max_days):
        raise exceptions.ValidationError(
            {"detail": f"window too large (max {max_days} days)"}
        )
    return start, end


def parse_uuid(raw):
    """``None`` for anything that is not a uuid — never raises.

    Public because the admin console (``admin_meeting_rooms``) filters on the
    same query params: handing a malformed id straight to ``filter(id=...)``
    turns a typo in the URL into a 500.
    """
    try:
        return uuid.UUID(str(raw).strip())
    except (ValueError, TypeError, AttributeError):
        return None


def facility_ids_from_params(params):
    """Parse ``?facilities=<uuid>,<uuid>`` — unparseable chunks are dropped."""
    ids = []
    for chunk in str(params.get("facilities") or "").split(","):
        parsed = parse_uuid(chunk)
        if parsed is not None:
            ids.append(parsed)
    return ids


def path_ids(path):
    """Uuids out of a materialized ``path`` (``"<root>/<child>/"``), self included."""
    return [uuid.UUID(h) for h in str(path or "").strip("/").split("/") if h]


def bookable_scope_filter(user):
    """``Q`` restricting rooms to the ones ``user`` is allowed to book (P9 M2).

    ``booking_scope=org`` is open to the whole organization. ``departments``
    limits the room to the departments an admin picked **and everything under
    them** — granting 深圳总部 has to mean the teams inside it, otherwise an
    admin would have to re-tick the box every time a sub-team is created.

    Deliberately no admin bypass: the console is where an admin changes the
    rule, not a place to sit outside it. Applied in ``get_queryset`` so browse /
    availability / timeline all hide the same rooms — surfacing a room the
    caller cannot book only earns them a 400 later.
    """
    membership = get_caller_membership(user)
    department = getattr(membership, "department", None) if membership else None
    allowed = path_ids(department.path) if department is not None else []
    scope = Q(booking_scope=models.MeetingRoomBookingScope.ORG)
    if not allowed:
        # No department → only org-wide rooms. Not an empty result set.
        return scope
    return scope | Q(bookable_departments__id__in=allowed)


def serialize_room(room, *, label_cache=None):
    """The room card shared by every endpoint here."""
    return {
        "id": str(room.id),
        "name": room.name,
        "code": room.code,
        "capacity": room.capacity,
        "description": room.description,
        "node": {"id": str(room.node_id), "name": room.node.name},
        "path_label": node_path_label(room.node, label_cache),
        "timezone": str(room.node.resolve_timezone()),
        "facilities": [
            {"id": str(f.id), "name": f.name, "code": f.code}
            for f in room.facilities.all()
        ],
        "is_active": room.is_active,
        "requires_approval": room.requires_approval,
    }


class MeetingRoomNodeViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """The room hierarchy, flat — clients build the tree from ``parent``/``path``.

    Unpaginated on purpose (same call as ``directory/departments``): a building
    tree is tens of rows, and paginating it would make every client stitch pages
    back together before it could draw anything.
    """

    permission_classes = [permissions.IsAuthenticated]
    pagination_class = None

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.MeetingRoomNode.objects.none()
        return models.MeetingRoomNode.objects.filter(
            organization=organization, deleted_at__isnull=True, is_active=True
        )

    def list(self, request, *args, **kwargs):
        nodes = list(self.get_queryset())
        counts = {}
        if nodes:
            rows = (
                models.MeetingRoom.objects.filter(
                    node__in=nodes, deleted_at__isnull=True, is_active=True
                )
                .values_list("node_id", flat=True)
            )
            for node_id in rows:
                counts[node_id] = counts.get(node_id, 0) + 1
        return Response(
            [
                {
                    "id": str(node.id),
                    "name": node.name,
                    "parent": str(node.parent_id) if node.parent_id else None,
                    "path": node.path,
                    "depth": node.depth,
                    "sort_order": node.sort_order,
                    "timezone": str(node.timezone) if node.timezone else None,
                    "effective_timezone": str(node.resolve_timezone()),
                    "room_count": counts.get(node.id, 0),
                }
                for node in nodes
            ]
        )


class MeetingRoomFacilityViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """The org's facility dictionary (TV / projector / ...), for filter chips."""

    permission_classes = [permissions.IsAuthenticated]
    pagination_class = None

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.MeetingRoomFacility.objects.none()
        return models.MeetingRoomFacility.objects.filter(
            organization=organization, is_active=True
        )

    def list(self, request, *args, **kwargs):
        return Response(
            [
                {
                    "id": str(f.id),
                    "name": f.name,
                    "code": f.code,
                    "sort_order": f.sort_order,
                }
                for f in self.get_queryset()
            ]
        )


class MeetingRoomViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet
):
    """Browse bookable rooms, check availability, read the day's timeline."""

    permission_classes = [permissions.IsAuthenticated]
    pagination_class = Pagination

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.MeetingRoom.objects.none()
        return (
            models.MeetingRoom.objects.filter(
                organization=organization,
                deleted_at__isnull=True,
                is_active=True,
            )
            # M2M join in the scope filter can duplicate rows — distinct() here
            # rather than at each call site, since availability / timeline read
            # this queryset directly.
            .filter(bookable_scope_filter(self.request.user))
            .distinct()
            .select_related("node")
            .prefetch_related("facilities")
        )

    def _filtered_rooms(self, params):
        """Apply ``?node=&q=&capacity_min=&facilities=`` to the base queryset."""
        rooms = self.get_queryset()
        node_id = parse_uuid(params.get("node"))
        if node_id is not None:
            node = models.MeetingRoomNode.objects.filter(
                id=node_id, organization=self._organization()
            ).first()
            if node is None:
                return rooms.none()
            # path includes self → this is "the node and everything under it".
            rooms = rooms.filter(node__path__startswith=node.path)
        query = str(params.get("q") or "").strip()
        if query:
            rooms = rooms.filter(
                Q(name__icontains=query) | Q(code__icontains=query)
            )
        capacity_min = params.get("capacity_min")
        if capacity_min:
            try:
                rooms = rooms.filter(capacity__gte=int(capacity_min))
            except (TypeError, ValueError):
                pass
        # AND semantics: a room must have *every* requested facility.
        for facility_id in facility_ids_from_params(params):
            rooms = rooms.filter(facilities__id=facility_id)
        return rooms.distinct()

    def _organization(self):
        return get_caller_organization(self.request.user)

    def list(self, request, *args, **kwargs):
        rooms = self._filtered_rooms(request.query_params)
        page = self.paginate_queryset(rooms)
        cache = {}
        data = [serialize_room(room, label_cache=cache) for room in page or rooms]
        if page is not None:
            return self.get_paginated_response(data)
        return Response(data)

    def retrieve(self, request, *args, **kwargs):
        return Response(serialize_room(self.get_object()))

    @decorators.action(detail=False, methods=["get"], url_path="availability")
    def availability(self, request):
        """Rooms matching the filters, each flagged free / busy for the window.

        ``?start=&end=`` (required) plus the same filters as the list. Powers
        both picker tabs: 「可用会议室」 is this with ``only_available=true``,
        「所有会议室」 is this as-is with the busy ones greyed out.

        ``exclude_event_id`` drops the caller's own event (and, for a recurring
        series, its occurrences) from the busy set — otherwise editing an event
        would always report its own room as taken.

        Ranges only, never titles: picking a room should not be a way to read
        other people's calendars.
        """
        organization = self._organization()
        if organization is None:
            return Response({"results": []})
        start, end = _parse_window(
            request.query_params, max_days=MAX_AVAILABILITY_DAYS
        )
        rooms = list(self._filtered_rooms(request.query_params))

        bookings = models.MeetingRoomBooking.objects.filter(
            room__in=rooms,
            status__in=models.ACTIVE_BOOKING_STATUSES,
            start_at__lt=end,
            end_at__gt=start,
        )
        exclude_event_id = parse_uuid(request.query_params.get("exclude_event_id"))
        if exclude_event_id is not None:
            bookings = bookings.exclude(
                Q(event_id=exclude_event_id)
                | Q(event__recurrence_parent_id=exclude_event_id)
            )

        busy = {}
        for row in bookings.order_by("start_at"):
            busy.setdefault(row.room_id, []).append(
                {
                    "start": max(row.start_at, start).isoformat(),
                    "end": min(row.end_at, end).isoformat(),
                }
            )

        only_available = str(
            request.query_params.get("only_available") or ""
        ).lower() in ("1", "true", "yes")
        cache = {}
        results = []
        for room in rooms:
            intervals = busy.get(room.id, [])
            if only_available and intervals:
                continue
            results.append(
                {
                    **serialize_room(room, label_cache=cache),
                    "is_available": not intervals,
                    "busy": intervals,
                }
            )
        return Response(
            {"start": start.isoformat(), "end": end.isoformat(), "results": results}
        )

    @decorators.action(detail=False, methods=["get"], url_path="timeline")
    def timeline(self, request):
        """Occupancy per room for a window — the horizontal timeline's data.

        Window is either ``?start=&end=`` or ``?node=&date=YYYY-MM-DD`` (the
        node's local midnight-to-midnight, using its effective timezone).

        Unlike availability this *does* name the organizer: the whole point of
        staring at a floor's timeline is to find who to ask about that 2pm
        block. Titles of private events are withheld from non-participants.
        """
        organization = self._organization()
        if organization is None:
            return Response({"results": []})

        start, end = _parse_window(
            request.query_params, max_days=MAX_TIMELINE_DAYS, required=False
        )
        tz_label = None
        if start is None:
            day = parse_date(str(request.query_params.get("date") or ""))
            node_id = parse_uuid(request.query_params.get("node"))
            if day is None:
                raise exceptions.ValidationError(
                    {"detail": "either start+end or node+date is required"}
                )
            node = (
                models.MeetingRoomNode.objects.filter(
                    id=node_id, organization=organization
                ).first()
                if node_id
                else None
            )
            tzinfo = (
                node.resolve_timezone() if node else ZoneInfo(settings.TIME_ZONE)
            )
            start = datetime.combine(day, dt_time.min, tzinfo=tzinfo)
            end = start + timedelta(days=1)
            tz_label = str(tzinfo)

        rooms = list(self._filtered_rooms(request.query_params))
        room_ids = request.query_params.get("room_ids")
        if room_ids:
            wanted = {
                parsed
                for parsed in (parse_uuid(c) for c in str(room_ids).split(","))
                if parsed is not None
            }
            rooms = [room for room in rooms if room.id in wanted]
        if len(rooms) > MAX_TIMELINE_ROOMS:
            raise exceptions.ValidationError(
                {"detail": f"too many rooms (max {MAX_TIMELINE_ROOMS}); narrow by node"}
            )

        bookings = (
            models.MeetingRoomBooking.objects.filter(
                room__in=rooms,
                status__in=models.ACTIVE_BOOKING_STATUSES,
                start_at__lt=end,
                end_at__gt=start,
            )
            .select_related("event", "event__organizer", "booked_by")
            .order_by("start_at")
        )

        visible_event_ids = set(
            models.EventAttendee.objects.filter(
                user=request.user,
                event_id__in=[b.event_id for b in bookings if b.event_id],
            ).values_list("event_id", flat=True)
        )

        by_room = {}
        for row in bookings:
            by_room.setdefault(row.room_id, []).append(
                self._serialize_booking(row, visible_event_ids, request.user)
            )

        cache = {}
        return Response(
            {
                "start": start.isoformat(),
                "end": end.isoformat(),
                "timezone": tz_label,
                "results": [
                    {
                        **serialize_room(room, label_cache=cache),
                        "bookings": by_room.get(room.id, []),
                    }
                    for room in rooms
                ],
            }
        )

    @staticmethod
    def _serialize_booking(row, visible_event_ids, user):
        event = row.event
        organizer = event.organizer if event and event.organizer_id else row.booked_by
        is_private = False
        title = row.title
        if event is not None:
            is_mine = event.organizer_id == user.id or event.id in visible_event_ids
            is_private = (
                event.visibility == models.EventVisibilityChoices.PRIVATE
                and not is_mine
            )
            title = None if is_private else event.title
        else:
            is_mine = False
        return {
            "id": str(row.id),
            "event_id": str(row.event_id) if row.event_id else None,
            "start": row.start_at.isoformat(),
            "end": row.end_at.isoformat(),
            "status": row.status,
            "source": row.source,
            "title": title,
            "is_private": is_private,
            "is_mine": is_mine,
            "organizer": {
                "id": str(organizer.id),
                "full_name": organizer.full_name,
                "avatar_url": utils.generate_profile_image_get_url(
                    "avatar", organizer.avatar_key
                ),
            }
            if organizer is not None
            else None,
        }
