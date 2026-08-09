"""Meeting-room admin console API (P9 会议室) — the write side.

Org administrators maintain the hierarchy (地区 / 建筑 / 楼层), the rooms hanging
off it, and the facility dictionary. Employees read all of this through
``core/api/meeting_rooms.py`` and book by putting a room on a calendar event.

Deletes are soft (``deleted_at``) for nodes and rooms so historical bookings
keep resolving to a name. Reparenting a node rewrites its whole subtree's
materialized paths — same algorithm as the department console, which is where
that logic was first worked out.
"""

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from core import models
from core.api.admin_org import _OrgScopedAdminViewSet
from core.api.admin_roles import HasOrgPermission
from core.api.meeting_rooms import (
    facility_ids_from_params,
    node_path_label,
    parse_uuid,
)
from core.api.viewsets import Pagination
from core.services.audit import record_audit


def parse_int(raw):
    """``None`` for anything not an integer — query params are user input."""
    try:
        return int(str(raw).strip())
    except (ValueError, TypeError, AttributeError):
        return None


class MeetingRoomNodeAdminSerializer(serializers.ModelSerializer):
    """Create / update a hierarchy node within the caller's organization."""

    effective_timezone = serializers.SerializerMethodField()
    room_count = serializers.SerializerMethodField()
    level_number = serializers.IntegerField(read_only=True)
    level_type = serializers.CharField(read_only=True)
    timezone = serializers.CharField(
        required=False, allow_blank=True, allow_null=True
    )

    class Meta:
        model = models.MeetingRoomNode
        fields = [
            "id",
            "name",
            "parent",
            "path",
            "depth",
            "level_number",
            "level_type",
            "sort_order",
            "timezone",
            "effective_timezone",
            "is_active",
            "room_count",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "path",
            "depth",
            "level_number",
            "level_type",
            "effective_timezone",
            "created_at",
        ]

    def get_effective_timezone(self, obj):
        return str(obj.resolve_timezone())

    def get_room_count(self, obj):
        return obj.rooms.filter(deleted_at__isnull=True).count()

    def validate_parent(self, value):
        if value is None:
            return value
        organization = self.context.get("organization")
        if value.organization_id != getattr(organization, "id", None):
            raise serializers.ValidationError("parent must be in your organization")
        if value.deleted_at is not None or not value.is_active:
            raise serializers.ValidationError("parent must be active")
        if value.is_floor:
            raise serializers.ValidationError("a floor cannot contain another level")
        return value

    def validate_timezone(self, value):
        """Empty means "inherit from ancestors" — store NULL, not ''."""
        normalized = (value or "").strip() or None
        if normalized is not None:
            try:
                ZoneInfo(normalized)
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise serializers.ValidationError("invalid IANA timezone") from exc
        return normalized

    def validate(self, attrs):
        attrs = super().validate(attrs)
        parent = attrs.get("parent") if self.instance is None else self.instance.parent
        depth = parent.depth + 1 if parent is not None else 0
        timezone_value = attrs.get(
            "timezone", getattr(self.instance, "timezone", None)
        )
        if depth == 1 and not timezone_value:
            raise serializers.ValidationError(
                {"timezone": "city timezone is required"}
            )
        if depth != 1 and timezone_value:
            raise serializers.ValidationError(
                {"timezone": "timezone can only be configured on a city"}
            )
        return attrs

    def update(self, instance, validated_data):
        # Reparenting has to rewrite descendant paths, so it goes through the
        # `move` action rather than a PATCH (same rule as the department admin).
        validated_data.pop("parent", None)
        return super().update(instance, validated_data)

    def create(self, validated_data):
        validated_data["organization"] = self.context["organization"]
        return super().create(validated_data)


class MeetingRoomFacilityAdminSerializer(serializers.ModelSerializer):
    """Create / update a facility type (电视 / 投影仪 / 白板 ...)."""

    class Meta:
        model = models.MeetingRoomFacility
        fields = ["id", "name", "code", "sort_order", "is_active", "created_at"]
        read_only_fields = ["id", "created_at"]

    def create(self, validated_data):
        validated_data["organization"] = self.context["organization"]
        return super().create(validated_data)


class MeetingRoomAdminSerializer(serializers.ModelSerializer):
    """Create / update a bookable room.

    Carries 飞书's 「会议室预定限制」 block: who may book the room
    (``booking_scope`` + ``bookable_departments``), how long one booking may run
    (``max_booking_minutes``) and how far ahead it may be made
    (``advance_booking_days``). All three are enforced by the calendar
    serializer / the C-side room queryset — see ``core/api/calendar.py``.

    ``requires_approval`` is deliberately **not** writable here. The column
    exists (P9 M1 landed the M2 fields up front to avoid a second migration) but
    nothing consumes it yet, and an admin switch that silently does nothing is
    worse than no switch. It lands with the approval wiring.
    """

    facility_ids = serializers.ListField(
        child=serializers.UUIDField(), write_only=True, required=False
    )
    facilities = serializers.SerializerMethodField()
    node_name = serializers.SerializerMethodField()
    path_label = serializers.SerializerMethodField()
    bookable_departments = serializers.SerializerMethodField()
    bookable_department_ids = serializers.ListField(
        child=serializers.UUIDField(), write_only=True, required=False
    )

    class Meta:
        model = models.MeetingRoom
        fields = [
            "id",
            "name",
            "code",
            "node",
            "node_name",
            "path_label",
            "capacity",
            "description",
            "facilities",
            "facility_ids",
            "sort_order",
            "is_active",
            "disabled_reason",
            "booking_scope",
            "bookable_departments",
            "bookable_department_ids",
            "max_booking_minutes",
            "advance_booking_days",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "facilities",
            "node_name",
            "path_label",
            "bookable_departments",
            "created_at",
        ]

    def get_facilities(self, obj):
        return [
            {"id": str(f.id), "name": f.name, "code": f.code}
            for f in obj.facilities.all()
        ]

    def get_bookable_departments(self, obj):
        return [
            {"id": str(d.id), "name": d.name} for d in obj.bookable_departments.all()
        ]

    def validate_max_booking_minutes(self, value):
        # 0 and null both mean "no limit"; normalize so the UI only has to
        # render one empty state.
        if value in (None, 0):
            return None
        if not 15 <= value <= 24 * 60:
            raise serializers.ValidationError(
                "must be between 15 minutes and 24 hours"
            )
        return value

    def validate_advance_booking_days(self, value):
        if value in (None, 0):
            return None
        if not 1 <= value <= 730:
            raise serializers.ValidationError("must be between 1 and 730 days")
        return value

    def validate(self, attrs):
        attrs = super().validate(attrs)
        scope = attrs.get(
            "booking_scope",
            getattr(self.instance, "booking_scope", models.MeetingRoomBookingScope.ORG),
        )
        if scope != models.MeetingRoomBookingScope.DEPARTMENTS:
            return attrs
        # Scoping to departments without naming one would hide the room from
        # everybody — almost certainly a half-filled form, not the intent.
        ids = attrs.get("bookable_department_ids")
        if ids is None:
            already = (
                self.instance is not None
                and self.instance.bookable_departments.exists()
            )
            if already:
                return attrs
        elif ids:
            return attrs
        raise serializers.ValidationError(
            {"bookable_department_ids": "pick at least one department"}
        )

    def get_node_name(self, obj):
        return obj.node.name if obj.node_id else ""

    def get_path_label(self, obj):
        return node_path_label(obj.node, self.context.setdefault("_labels", {}))

    def validate_node(self, value):
        organization = self.context.get("organization")
        if value.organization_id != getattr(organization, "id", None):
            raise serializers.ValidationError("node must be in your organization")
        if value.deleted_at is not None:
            raise serializers.ValidationError("node has been deleted")
        if not value.is_active:
            raise serializers.ValidationError("node is inactive")
        if not value.is_floor:
            raise serializers.ValidationError(
                "meeting rooms can only be added to a floor"
            )
        return value

    def _set_facilities(self, room, facility_ids):
        organization = self.context["organization"]
        room.facilities.set(
            models.MeetingRoomFacility.objects.filter(
                id__in=facility_ids, organization=organization
            )
        )

    def _set_departments(self, room, department_ids):
        organization = self.context["organization"]
        room.bookable_departments.set(
            models.Department.objects.filter(
                id__in=department_ids, organization=organization
            )
        )

    def _apply_m2m(self, room, facility_ids, department_ids):
        if facility_ids is not None:
            self._set_facilities(room, facility_ids)
        if department_ids is not None:
            self._set_departments(room, department_ids)
        # Going back to org-wide leaves the old department list dangling, which
        # would silently re-restrict the room the next time someone flips the
        # scope back. Clear it with the scope.
        if room.booking_scope == models.MeetingRoomBookingScope.ORG:
            room.bookable_departments.clear()

    def create(self, validated_data):
        facility_ids = validated_data.pop("facility_ids", None)
        department_ids = validated_data.pop("bookable_department_ids", None)
        validated_data["organization"] = self.context["organization"]
        room = super().create(validated_data)
        self._apply_m2m(room, facility_ids, department_ids)
        return room

    def update(self, instance, validated_data):
        facility_ids = validated_data.pop("facility_ids", None)
        department_ids = validated_data.pop("bookable_department_ids", None)
        room = super().update(instance, validated_data)
        self._apply_m2m(room, facility_ids, department_ids)
        return room


class MeetingRoomNodeAdminViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    _OrgScopedAdminViewSet,
):
    """CRUD for the room hierarchy (org admins only)."""

    # 与控制台导航同一个权限码(AdminShell.tsx)。原为 IsOrgAdmin —— 内置
    # admin_office 角色被授了 org.meeting_room.write、因此看得到菜单,点进去
    # 却 403。纯放宽:owner/administrator 持 ALL_PERMISSIONS 依然通过。
    permission_classes = [HasOrgPermission]
    required_permission = "org.meeting_room.write"
    serializer_class = MeetingRoomNodeAdminSerializer
    pagination_class = None

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.MeetingRoomNode.objects.none()
        return models.MeetingRoomNode.objects.filter(
            organization=organization, deleted_at__isnull=True
        )

    def perform_create(self, serializer):
        instance = serializer.save()
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.ROOM_NODE_CREATE,
            target_type="meeting_room_node",
            target_id=instance.id,
            target_label=instance.name,
            metadata={
                "parent": str(instance.parent_id) if instance.parent_id else None
            },
        )

    def perform_update(self, serializer):
        instance = serializer.save()
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.ROOM_NODE_UPDATE,
            target_type="meeting_room_node",
            target_id=instance.id,
            target_label=instance.name,
            metadata={"timezone": str(instance.timezone) if instance.timezone else None},
        )

    def perform_destroy(self, instance):
        """Soft-delete, and only once the node is empty.

        Refusing a non-empty node is deliberate: cascading would silently orphan
        rooms that still have future bookings on them.
        """
        if instance.children.filter(deleted_at__isnull=True).exists():
            raise serializers.ValidationError(
                {"detail": "delete or move the child levels first"}
            )
        if instance.rooms.filter(deleted_at__isnull=True).exists():
            raise serializers.ValidationError(
                {"detail": "delete or move the rooms in this level first"}
            )
        instance.deleted_at = timezone.now()
        instance.is_active = False
        instance.save(update_fields=["deleted_at", "is_active", "updated_at"])
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.ROOM_NODE_DELETE,
            target_type="meeting_room_node",
            target_id=instance.id,
            target_label=instance.name,
        )

    @action(detail=True, methods=["post"])
    def move(self, request, *args, **kwargs):
        """Reparent a node, rewriting its whole subtree's materialized paths.

        Body ``{"parent": "<node_id>" | null}``. ``save()`` only refreshes one
        node's path/depth by design, so moving a subtree is the console's job —
        this mirrors ``DepartmentAdminViewSet.move``.
        """
        node = self.get_object()
        organization = self.get_organization()
        parent_id = request.data.get("parent")

        new_parent = None
        if parent_id:
            new_parent = models.MeetingRoomNode.objects.filter(
                id=parent_id,
                organization=organization,
                deleted_at__isnull=True,
                is_active=True,
            ).first()
            if new_parent is None:
                raise serializers.ValidationError({"parent": "invalid target parent"})
            # node.path includes self, so a descendant's path starts with it.
            if new_parent.id == node.id or new_parent.path.startswith(node.path):
                raise serializers.ValidationError(
                    {"parent": "cannot move a level under itself or its descendant"}
                )

        if node.depth == 0:
            if new_parent is not None:
                raise serializers.ValidationError(
                    {"parent": "a country/region must remain at the top level"}
                )
        elif new_parent is None or new_parent.depth != node.depth - 1:
            raise serializers.ValidationError(
                {"parent": "moving a level cannot change its level type"}
            )

        new_parent_id = new_parent.id if new_parent else None
        if node.parent_id == new_parent_id:
            return Response(self.get_serializer(node).data)  # no-op

        old_path = node.path
        new_path = (
            f"{new_parent.path}{node.id.hex}/" if new_parent else f"{node.id.hex}/"
        )
        new_depth = (new_parent.depth + 1) if new_parent else 0
        depth_delta = new_depth - node.depth

        descendants = list(
            models.MeetingRoomNode.objects.filter(
                organization=organization, path__startswith=old_path
            ).exclude(id=node.id)
        )

        with transaction.atomic():
            # .update() bypasses save()'s single-node refresh, letting us write
            # the exact recomputed subtree paths directly.
            models.MeetingRoomNode.objects.filter(id=node.id).update(
                parent=new_parent, path=new_path, depth=new_depth
            )
            for child in descendants:
                models.MeetingRoomNode.objects.filter(id=child.id).update(
                    path=new_path + child.path[len(old_path):],
                    depth=child.depth + depth_delta,
                )

        node.refresh_from_db()
        record_audit(
            actor=self.request.user,
            organization=organization,
            action=models.AuditActionChoices.ROOM_NODE_MOVE,
            target_type="meeting_room_node",
            target_id=node.id,
            target_label=node.name,
            metadata={"to_parent": new_parent_id and str(new_parent_id)},
        )
        return Response(self.get_serializer(node).data)


class MeetingRoomAdminViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    _OrgScopedAdminViewSet,
):
    """CRUD for bookable rooms (org admins only).

    ``retrieve`` backs the console's room detail view: deep-linking to one room
    must not depend on having paged through the list to find it.
    """

    # 与控制台导航同一个权限码(AdminShell.tsx)。原为 IsOrgAdmin —— 内置
    # admin_office 角色被授了 org.meeting_room.write、因此看得到菜单,点进去
    # 却 403。纯放宽:owner/administrator 持 ALL_PERMISSIONS 依然通过。
    permission_classes = [HasOrgPermission]
    required_permission = "org.meeting_room.write"
    serializer_class = MeetingRoomAdminSerializer
    pagination_class = Pagination

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.MeetingRoom.objects.none()
        queryset = (
            models.MeetingRoom.objects.filter(
                organization=organization, deleted_at__isnull=True
            )
            .select_related("node")
            .prefetch_related("facilities", "bookable_departments")
        )
        params = self.request.query_params
        node_id = parse_uuid(params.get("node"))
        if params.get("node"):
            # A malformed id is an empty result, not a 500 from filter(id=...).
            node = (
                models.MeetingRoomNode.objects.filter(
                    id=node_id, organization=organization
                ).first()
                if node_id is not None
                else None
            )
            queryset = (
                queryset.filter(node__path__startswith=node.path)
                if node
                else queryset.none()
            )
        query = str(params.get("q") or "").strip()
        if query:
            # Admins search by room number at least as often as by name — the
            # C-side browse endpoint already matches both.
            queryset = queryset.filter(
                Q(name__icontains=query) | Q(code__icontains=query)
            )
        is_active = params.get("is_active")
        if is_active in ("0", "false", "False"):
            queryset = queryset.filter(is_active=False)
        elif is_active in ("1", "true", "True"):
            queryset = queryset.filter(is_active=True)
        capacity_min = parse_int(params.get("capacity_min"))
        if capacity_min is not None:
            queryset = queryset.filter(capacity__gte=capacity_min)
        # AND semantics, same as the C side: 「有电视 *且* 有白板」.
        facility_ids = facility_ids_from_params(params)
        for facility_id in facility_ids:
            queryset = queryset.filter(facilities__id=facility_id)
        return queryset.distinct() if facility_ids else queryset

    def perform_create(self, serializer):
        instance = serializer.save()
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.MEETING_ROOM_CREATE,
            target_type="meeting_room",
            target_id=instance.id,
            target_label=instance.name,
            metadata={"node": str(instance.node_id), "capacity": instance.capacity},
        )

    def perform_update(self, serializer):
        before_active = serializer.instance.is_active
        instance = serializer.save()
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.MEETING_ROOM_UPDATE,
            target_type="meeting_room",
            target_id=instance.id,
            target_label=instance.name,
            metadata={
                "is_active": {"from": before_active, "to": instance.is_active}
                if before_active != instance.is_active
                else None
            },
        )

    def perform_destroy(self, instance):
        """Soft-delete. Existing bookings are left alone on purpose.

        Yanking a room out from under meetings that are already on people's
        calendars is worse than letting them run; deciding what to do with them
        (release + notify) is M2 work.
        """
        instance.deleted_at = timezone.now()
        instance.is_active = False
        instance.save(update_fields=["deleted_at", "is_active", "updated_at"])
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.MEETING_ROOM_DELETE,
            target_type="meeting_room",
            target_id=instance.id,
            target_label=instance.name,
        )


class MeetingRoomFacilityAdminViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    _OrgScopedAdminViewSet,
):
    """CRUD for the facility dictionary (org admins only)."""

    # 与控制台导航同一个权限码(AdminShell.tsx)。原为 IsOrgAdmin —— 内置
    # admin_office 角色被授了 org.meeting_room.write、因此看得到菜单,点进去
    # 却 403。纯放宽:owner/administrator 持 ALL_PERMISSIONS 依然通过。
    permission_classes = [HasOrgPermission]
    required_permission = "org.meeting_room.write"
    serializer_class = MeetingRoomFacilityAdminSerializer
    pagination_class = None

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.MeetingRoomFacility.objects.none()
        return models.MeetingRoomFacility.objects.filter(organization=organization)

    def perform_create(self, serializer):
        instance = serializer.save()
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.MEETING_ROOM_FACILITY_CREATE,
            target_type="meeting_room_facility",
            target_id=instance.id,
            target_label=instance.name,
        )

    def perform_update(self, serializer):
        instance = serializer.save()
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.MEETING_ROOM_FACILITY_UPDATE,
            target_type="meeting_room_facility",
            target_id=instance.id,
            target_label=instance.name,
        )

    def perform_destroy(self, instance):
        """Retire rather than delete when rooms still reference it."""
        if instance.rooms.exists():
            instance.is_active = False
            instance.save(update_fields=["is_active", "updated_at"])
        else:
            instance.delete()
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.MEETING_ROOM_FACILITY_DELETE,
            target_type="meeting_room_facility",
            target_id=instance.id,
            target_label=instance.name,
        )


class MeetingRoomBookingAdminViewSet(mixins.ListModelMixin, _OrgScopedAdminViewSet):
    """Read-only booking ledger (``?room=&start=&end=&status=``).

    Read-only in M1: releasing someone else's booking has to notify them, and
    that flow is M2.
    """

    # 与控制台导航同一个权限码(AdminShell.tsx)。原为 IsOrgAdmin —— 内置
    # admin_office 角色被授了 org.meeting_room.write、因此看得到菜单,点进去
    # 却 403。纯放宽:owner/administrator 持 ALL_PERMISSIONS 依然通过。
    permission_classes = [HasOrgPermission]
    required_permission = "org.meeting_room.write"
    pagination_class = Pagination

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.MeetingRoomBooking.objects.none()
        queryset = models.MeetingRoomBooking.objects.filter(
            organization=organization
        ).select_related("room", "event", "booked_by")
        params = self.request.query_params
        if params.get("room"):
            queryset = queryset.filter(room_id=params["room"])
        if params.get("status"):
            queryset = queryset.filter(status=params["status"])
        start = params.get("start")
        end = params.get("end")
        if start:
            queryset = queryset.filter(end_at__gt=start)
        if end:
            queryset = queryset.filter(start_at__lt=end)
        return queryset.order_by("start_at")

    def list(self, request, *args, **kwargs):
        page = self.paginate_queryset(self.get_queryset())
        data = [
            {
                "id": str(row.id),
                "room": {"id": str(row.room_id), "name": row.room.name},
                "event_id": str(row.event_id) if row.event_id else None,
                "title": row.event.title if row.event_id else row.title,
                "start": row.start_at.isoformat(),
                "end": row.end_at.isoformat(),
                "status": row.status,
                "source": row.source,
                "booked_by": row.booked_by.full_name if row.booked_by_id else None,
            }
            for row in page
        ]
        return self.get_paginated_response(data)
