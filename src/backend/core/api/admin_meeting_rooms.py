"""Meeting-room admin console API (P9 会议室) — the write side.

Org administrators maintain the hierarchy (地区 / 建筑 / 楼层), the rooms hanging
off it, and the facility dictionary. Employees read all of this through
``core/api/meeting_rooms.py`` and book by putting a room on a calendar event.

Deletes are soft (``deleted_at``) for nodes and rooms so historical bookings
keep resolving to a name. Reparenting a node rewrites its whole subtree's
materialized paths — same algorithm as the department console, which is where
that logic was first worked out.
"""

from django.db import transaction
from django.utils import timezone

from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from core import models
from core.api.admin_org import IsOrgAdmin, _OrgScopedAdminViewSet
from core.api.meeting_rooms import node_path_label
from core.api.viewsets import Pagination
from core.services.audit import record_audit


class MeetingRoomNodeAdminSerializer(serializers.ModelSerializer):
    """Create / update a hierarchy node within the caller's organization."""

    effective_timezone = serializers.SerializerMethodField()
    room_count = serializers.SerializerMethodField()
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
            "sort_order",
            "timezone",
            "effective_timezone",
            "is_active",
            "room_count",
            "created_at",
        ]
        read_only_fields = ["id", "path", "depth", "effective_timezone", "created_at"]

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
        return value

    def validate_timezone(self, value):
        """Empty means "inherit from ancestors" — store NULL, not ''."""
        return (value or "").strip() or None

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
    """Create / update a bookable room."""

    facility_ids = serializers.ListField(
        child=serializers.UUIDField(), write_only=True, required=False
    )
    facilities = serializers.SerializerMethodField()
    node_name = serializers.SerializerMethodField()
    path_label = serializers.SerializerMethodField()

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
            "created_at",
        ]
        read_only_fields = ["id", "facilities", "node_name", "path_label", "created_at"]

    def get_facilities(self, obj):
        return [
            {"id": str(f.id), "name": f.name, "code": f.code}
            for f in obj.facilities.all()
        ]

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
        return value

    def _set_facilities(self, room, facility_ids):
        organization = self.context["organization"]
        room.facilities.set(
            models.MeetingRoomFacility.objects.filter(
                id__in=facility_ids, organization=organization
            )
        )

    def create(self, validated_data):
        facility_ids = validated_data.pop("facility_ids", None)
        validated_data["organization"] = self.context["organization"]
        room = super().create(validated_data)
        if facility_ids is not None:
            self._set_facilities(room, facility_ids)
        return room

    def update(self, instance, validated_data):
        facility_ids = validated_data.pop("facility_ids", None)
        room = super().update(instance, validated_data)
        if facility_ids is not None:
            self._set_facilities(room, facility_ids)
        return room


class MeetingRoomNodeAdminViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    _OrgScopedAdminViewSet,
):
    """CRUD for the room hierarchy (org admins only)."""

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
                id=parent_id, organization=organization, deleted_at__isnull=True
            ).first()
            if new_parent is None:
                raise serializers.ValidationError({"parent": "invalid target parent"})
            # node.path includes self, so a descendant's path starts with it.
            if new_parent.id == node.id or new_parent.path.startswith(node.path):
                raise serializers.ValidationError(
                    {"parent": "cannot move a level under itself or its descendant"}
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
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    _OrgScopedAdminViewSet,
):
    """CRUD for bookable rooms (org admins only)."""

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
            .prefetch_related("facilities")
        )
        params = self.request.query_params
        node_id = params.get("node")
        if node_id:
            node = models.MeetingRoomNode.objects.filter(
                id=node_id, organization=organization
            ).first()
            queryset = (
                queryset.filter(node__path__startswith=node.path)
                if node
                else queryset.none()
            )
        query = str(params.get("q") or "").strip()
        if query:
            queryset = queryset.filter(name__icontains=query)
        is_active = params.get("is_active")
        if is_active in ("0", "false", "False"):
            queryset = queryset.filter(is_active=False)
        elif is_active in ("1", "true", "True"):
            queryset = queryset.filter(is_active=True)
        return queryset

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

    permission_classes = [IsOrgAdmin]
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
