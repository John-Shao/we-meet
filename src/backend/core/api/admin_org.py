"""Org admin console API — department tree + membership management (write side).

Mutations are restricted to organization administrators (``IsOrgAdmin``). Plain
members browse via the read-only directory API (``core/api/directory.py``).

Scope (P1-d2 MVP):
  - Departments: create (with parent), update (name / head / sort_order),
    soft-delete. Reparenting a department (which rewrites descendant paths) is
    intentionally out of scope here — build the tree by creating nodes under
    their parent, and move *people* via membership edits.
  - Memberships: add an existing user to a department, change their role /
    department / title / primary flag, or remove them.

Everything is scoped to the caller's organization, resolved from their own
membership (single-org MVP; ready for multi-org without query changes).
"""

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from core import models, utils
from core.api import permissions
from core.api.directory import get_caller_organization, is_caller_org_admin
from core.api.viewsets import Pagination
from core.services import offboarding
from core.services.audit import record_audit


class IsOrgAdmin(permissions.IsAuthenticated):
    """Authenticated AND an administrator/owner of their own organization.

    Delegates to the memoized ``is_caller_org_admin`` so a request that also
    hits ``get_caller_organization`` (every viewset here does, via
    ``get_organization``) resolves the membership once instead of three times.
    """

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        return is_caller_org_admin(request.user)


class DepartmentAdminSerializer(serializers.ModelSerializer):
    """Create / update a department within the caller's organization."""

    class Meta:
        model = models.Department
        fields = [
            "id",
            "name",
            "parent",
            "head",
            "sort_order",
            "path",
            "depth",
            "is_active",
        ]
        # parent is set at creation only — changing it would require a subtree
        # path rewrite (out of scope for the MVP admin console).
        read_only_fields = ["id", "path", "depth", "is_active"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance is not None:  # update — parent is immutable
            self.fields["parent"].read_only = True

    def validate_parent(self, value):
        if value is not None and value.organization_id != self._organization().id:
            raise serializers.ValidationError("parent must be in your organization")
        return value

    def validate_head(self, value):
        if value is not None and not models.Membership.objects.filter(
            user=value,
            organization=self._organization(),
            status=models.MembershipStatusChoices.ACTIVE,
        ).exists():
            raise serializers.ValidationError("head must be a member of your organization")
        return value

    def _organization(self):
        return self.context["organization"]

    def create(self, validated_data):
        validated_data["organization"] = self._organization()
        return super().create(validated_data)


class MembershipAdminSerializer(serializers.ModelSerializer):
    """Add / update / remove a user's membership within the caller's organization."""

    class Meta:
        model = models.Membership
        fields = [
            "id",
            "user",
            "department",
            "title",
            "org_role",
            "is_primary",
            "status",
            # --- work profile (P10 M1) ---
            "employee_no",
            "employee_type",
            "job_level",
            "job_sequence",
            "manager",
            "dotted_manager",
            "hire_date",
            "work_country",
            "work_city",
            "alias",
            "work_station",
            "extension",
        ]
        read_only_fields = ["id"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance is not None:  # user is fixed once the membership exists
            self.fields["user"].read_only = True

    def validate_department(self, value):
        if value is not None and value.organization_id != self._organization().id:
            raise serializers.ValidationError("department must be in your organization")
        return value

    def _validate_dict_item(self, value, scope):
        """A dictionary FK must belong to this org AND to the right dictionary."""
        if value is None:
            return value
        if value.organization_id != self._organization().id:
            raise serializers.ValidationError("must be in your organization")
        if value.scope != scope:
            raise serializers.ValidationError(
                f"must be a '{scope}' option, got '{value.scope}'"
            )
        return value

    def validate_employee_type(self, value):
        return self._validate_dict_item(value, models.DictScopeChoices.EMPLOYEE_TYPE)

    def validate_job_level(self, value):
        return self._validate_dict_item(value, models.DictScopeChoices.JOB_LEVEL)

    def validate_job_sequence(self, value):
        return self._validate_dict_item(value, models.DictScopeChoices.JOB_SEQUENCE)

    def _validate_manager(self, value, field):
        if value is None:
            return value
        if value.organization_id != self._organization().id:
            raise serializers.ValidationError("must be in your organization")
        if self.instance is not None and value.pk == self.instance.pk:
            raise serializers.ValidationError("a member cannot be their own manager")
        return value

    def validate_manager(self, value):
        return self._validate_manager(value, "manager")

    def validate_dotted_manager(self, value):
        return self._validate_manager(value, "dotted_manager")

    def validate(self, attrs):
        """Guard against locking the organization out of administration.

        On update, refuse to suspend one's own membership (an admin could strand
        themselves) and refuse to remove the last active owner (by suspending it
        or demoting its role) so the organization always keeps an owner.
        """
        instance = self.instance
        if instance is None:  # create — nothing to protect yet
            return attrs

        new_status = attrs.get("status", instance.status)
        new_role = attrs.get("org_role", instance.org_role)

        request = self.context.get("request")
        if (
            request is not None
            and instance.user_id == request.user.id
            and new_status != models.MembershipStatusChoices.ACTIVE
        ):
            raise serializers.ValidationError(
                {"status": _("You cannot suspend your own membership.")}
            )

        was_active_owner = (
            instance.status == models.MembershipStatusChoices.ACTIVE
            and instance.org_role == models.OrgRoleChoices.OWNER
        )
        still_active_owner = (
            new_status == models.MembershipStatusChoices.ACTIVE
            and new_role == models.OrgRoleChoices.OWNER
        )
        if was_active_owner and not still_active_owner:
            other_owner_exists = (
                models.Membership.objects.filter(
                    organization=instance.organization,
                    status=models.MembershipStatusChoices.ACTIVE,
                    org_role=models.OrgRoleChoices.OWNER,
                )
                .exclude(id=instance.id)
                .exists()
            )
            if not other_owner_exists:
                raise serializers.ValidationError(
                    _("The organization must keep at least one active owner.")
                )
        return attrs

    def _organization(self):
        return self.context["organization"]

    def create(self, validated_data):
        validated_data["organization"] = self._organization()
        return super().create(validated_data)


class MembershipAdminReadSerializer(serializers.Serializer):
    """A membership row for the console's member table (all statuses).

    Richer than the directory card: it carries the membership id (the admin
    write handle), the lifecycle ``status`` and the ``org_role`` so the console
    can list invited / suspended members the directory hides.
    """

    id = serializers.UUIDField(read_only=True)  # membership id (PATCH/DELETE handle)
    user_id = serializers.UUIDField(source="user.id", read_only=True)
    sub = serializers.CharField(source="user.sub", read_only=True)
    full_name = serializers.CharField(source="user.full_name", read_only=True)
    short_name = serializers.CharField(source="user.short_name", read_only=True)
    email = serializers.EmailField(source="user.email", read_only=True)
    avatar_url = serializers.SerializerMethodField()
    title = serializers.CharField(read_only=True)
    org_role = serializers.CharField(read_only=True)
    is_primary = serializers.BooleanField(read_only=True)
    status = serializers.CharField(read_only=True)
    department = serializers.SerializerMethodField()
    # --- work profile (P10 M1) ---
    employee_no = serializers.CharField(read_only=True)
    employee_type = serializers.SerializerMethodField()
    job_level = serializers.SerializerMethodField()
    job_sequence = serializers.SerializerMethodField()
    hire_date = serializers.DateField(read_only=True)
    work_country = serializers.CharField(read_only=True)
    work_city = serializers.CharField(read_only=True)
    alias = serializers.CharField(read_only=True)
    work_station = serializers.CharField(read_only=True)
    extension = serializers.CharField(read_only=True)
    source = serializers.CharField(read_only=True)
    manager = serializers.SerializerMethodField()
    dotted_manager = serializers.SerializerMethodField()
    # --- offboarding ---
    left_at = serializers.DateTimeField(read_only=True)
    left_reason = serializers.CharField(read_only=True)
    left_snapshot = serializers.JSONField(read_only=True)
    left_days = serializers.SerializerMethodField()

    def get_avatar_url(self, obj):
        """Short-lived presigned GET URL for the avatar, '' if unset."""
        return utils.generate_profile_image_get_url("avatar", obj.user.avatar_key)

    def get_department(self, obj):
        """Lightweight {id, name} of the membership's department, or None."""
        if obj.department_id:
            return {"id": str(obj.department_id), "name": obj.department.name}
        return None

    @staticmethod
    def _dict_item(item):
        if item is None:
            return None
        return {"id": str(item.id), "code": item.code, "label": item.label}

    def get_employee_type(self, obj):
        return self._dict_item(obj.employee_type)

    def get_job_level(self, obj):
        return self._dict_item(obj.job_level)

    def get_job_sequence(self, obj):
        return self._dict_item(obj.job_sequence)

    @staticmethod
    def _manager_ref(membership):
        if membership is None:
            return None
        user = membership.user
        return {
            "membership_id": str(membership.id),
            "user_id": str(user.id),
            "full_name": user.full_name or user.short_name or "",
        }

    def get_manager(self, obj):
        return self._manager_ref(obj.manager)

    def get_dotted_manager(self, obj):
        return self._manager_ref(obj.dotted_manager)

    def get_left_days(self, obj):
        """Days since leaving — computed, never stored (it would change nightly)."""
        if not obj.left_at:
            return None
        return max((timezone.now() - obj.left_at).days, 0)


class _OrgScopedMembershipField(serializers.PrimaryKeyRelatedField):
    """A membership picker constrained to the caller's own organization."""

    def get_queryset(self):
        organization = self.context.get("organization")
        queryset = models.Membership.objects.filter(
            status=models.MembershipStatusChoices.ACTIVE
        )
        return (
            queryset.filter(organization=organization)
            if organization
            else queryset.none()
        )


class OffboardSerializer(serializers.Serializer):
    """Request body for ``POST /admin/memberships/{id}/offboard/``."""

    left_at = serializers.DateTimeField(required=False, allow_null=True)
    reason = serializers.CharField(
        required=False, allow_blank=True, max_length=64, default=""
    )
    # Departments this member heads must get a new head, or the caller must say
    # explicitly that leaving them headless is intended.
    transfer_head_to = _OrgScopedMembershipField(required=False, allow_null=True)
    allow_orphan_head = serializers.BooleanField(required=False, default=False)
    disable_login = serializers.BooleanField(required=False, default=True)


class RehireSerializer(serializers.Serializer):
    """Request body for ``POST /admin/memberships/{id}/rehire/``."""

    department = serializers.PrimaryKeyRelatedField(
        queryset=models.Department.objects.filter(deleted_at__isnull=True),
        required=False,
        allow_null=True,
    )
    org_role = serializers.ChoiceField(
        choices=models.OrgRoleChoices.choices, required=False
    )


class _OrgScopedAdminViewSet(viewsets.GenericViewSet):
    """Shared plumbing: org-admin permission + org in serializer context."""

    permission_classes = [IsOrgAdmin]

    def get_organization(self):
        return get_caller_organization(self.request.user)

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["organization"] = self.get_organization()
        return context


class DepartmentAdminViewSet(
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    _OrgScopedAdminViewSet,
):
    """Create / update / soft-delete departments (org admins only)."""

    serializer_class = DepartmentAdminSerializer

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.Department.objects.none()
        return models.Department.objects.filter(
            organization=organization, deleted_at__isnull=True
        )

    def perform_create(self, serializer):
        instance = serializer.save()
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.DEPT_CREATE,
            target_type="department",
            target_id=instance.id,
            target_label=instance.name,
            metadata={
                "parent": str(instance.parent_id) if instance.parent_id else None
            },
        )

    def perform_update(self, serializer):
        before = {
            "name": serializer.instance.name,
            "head": str(serializer.instance.head_id) if serializer.instance.head_id else None,
            "sort_order": serializer.instance.sort_order,
        }
        instance = serializer.save()
        after = {
            "name": instance.name,
            "head": str(instance.head_id) if instance.head_id else None,
            "sort_order": instance.sort_order,
        }
        changes = {k: {"from": before[k], "to": after[k]} for k in after if before[k] != after[k]}
        if not changes:
            return
        # A pure rename gets its own action; head / sort edits fold into dept.update.
        action = (
            models.AuditActionChoices.DEPT_RENAME
            if set(changes) == {"name"}
            else models.AuditActionChoices.DEPT_UPDATE
        )
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=action,
            target_type="department",
            target_id=instance.id,
            target_label=instance.name,
            metadata={"changes": changes},
        )

    def perform_destroy(self, instance):
        """Soft-delete a department.

        Its members fall back to organization-level (``department=None`` →
        "no department") by default; pass ``?reassign=<dept_id>`` to move them to
        another department instead. Refuse if the department still has
        sub-departments (delete or move those first).
        """
        if instance.children.filter(deleted_at__isnull=True).exists():
            raise serializers.ValidationError(
                {"detail": "department has sub-departments; delete or move them first"}
            )
        members = models.Membership.objects.filter(department=instance)
        reassign_id = self.request.query_params.get("reassign")
        target = None
        if reassign_id:
            target = models.Department.objects.filter(
                id=reassign_id,
                organization=instance.organization,
                deleted_at__isnull=True,
            ).first()
            if target is None or target.id == instance.id:
                raise serializers.ValidationError(
                    {"reassign": "invalid target department"}
                )
        with transaction.atomic():
            # target is None → members drop to organization-level (no department).
            members.update(department=target)
            instance.is_active = False
            instance.deleted_at = timezone.now()
            instance.save()
        record_audit(
            actor=self.request.user,
            organization=instance.organization,
            action=models.AuditActionChoices.DEPT_DELETE,
            target_type="department",
            target_id=instance.id,
            target_label=instance.name,
            metadata={"reassign_to": str(target.id) if target else None},
        )

    @action(detail=True, methods=["post"])
    def move(self, request, *args, **kwargs):
        """Reparent a department, rewriting its whole subtree's materialized paths.

        Body ``{"parent": "<dept_id>" | null}`` (null → top level). The model's
        ``save()`` only refreshes one node's path/depth (by design, see
        ``Department`` docstring); moving a subtree is the console's job, done
        here. Rejects moving a department under itself or one of its descendants
        (a cycle). ``team_key`` is id-derived and stays stable, so team-scoped
        access grants survive the move.
        """
        node = self.get_object()
        organization = self.get_organization()
        parent_id = request.data.get("parent")

        new_parent = None
        if parent_id:
            new_parent = models.Department.objects.filter(
                id=parent_id,
                organization=organization,
                deleted_at__isnull=True,
            ).first()
            if new_parent is None:
                raise serializers.ValidationError(
                    {"parent": "invalid target parent"}
                )
            # node.path includes self, so a descendant's path starts with it.
            if new_parent.id == node.id or new_parent.path.startswith(node.path):
                raise serializers.ValidationError(
                    {"parent": "cannot move a department under itself or its descendant"}
                )

        new_parent_id = new_parent.id if new_parent else None
        if node.parent_id == new_parent_id:
            return Response(DepartmentAdminSerializer(node).data)  # no-op

        old_path = node.path
        new_path = (
            f"{new_parent.path}{node.id.hex}/" if new_parent else f"{node.id.hex}/"
        )
        new_depth = (new_parent.depth + 1) if new_parent else 0
        depth_delta = new_depth - node.depth

        # The subtree (descendants only; the node itself is updated separately).
        descendants = list(
            models.Department.objects.filter(
                organization=organization, path__startswith=old_path
            ).exclude(id=node.id)
        )

        with transaction.atomic():
            # .update() bypasses Department.save()'s single-node path refresh,
            # letting us write the exact recomputed subtree paths directly.
            models.Department.objects.filter(id=node.id).update(
                parent=new_parent, path=new_path, depth=new_depth
            )
            for dept in descendants:
                models.Department.objects.filter(id=dept.id).update(
                    path=new_path + dept.path[len(old_path):],
                    depth=dept.depth + depth_delta,
                )

        node.refresh_from_db()
        record_audit(
            actor=self.request.user,
            organization=organization,
            action=models.AuditActionChoices.DEPT_MOVE,
            target_type="department",
            target_id=node.id,
            target_label=node.name,
            metadata={"to_parent": new_parent_id and str(new_parent_id)},
        )
        return Response(DepartmentAdminSerializer(node).data)


class MembershipAdminViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    _OrgScopedAdminViewSet,
):
    """List / add / update / remove memberships (org admins only).

    ``list`` returns members of every lifecycle status (active / invited /
    suspended), unlike the active-only directory, filterable by
    ``?status=`` / ``?department=`` / ``?org_role=`` / ``?q=`` (name or email).
    """

    serializer_class = MembershipAdminSerializer
    pagination_class = Pagination

    def get_serializer_class(self):
        # Reads expose a rich member card; writes take the thin write serializer.
        if self.action == "list":
            return MembershipAdminReadSerializer
        return MembershipAdminSerializer

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.Membership.objects.none()
        queryset = models.Membership.objects.filter(
            organization=organization
        ).select_related(
            "user",
            "department",
            "employee_type",
            "job_level",
            "job_sequence",
            "manager__user",
            "dotted_manager__user",
        )

        status = self.request.query_params.get("status")
        if status:
            queryset = queryset.filter(status=status)
        department = self.request.query_params.get("department")
        if department:
            # ``?include_subtree=true`` mirrors 飞书's "仅展示部门直属成员" switch
            # (inverted): off means the whole subtree, on means direct members.
            if self.request.query_params.get("include_subtree") == "true":
                node = models.Department.objects.filter(
                    organization=organization, id=department
                ).first()
                queryset = (
                    queryset.filter(department__path__startswith=node.path)
                    if node
                    else queryset.none()
                )
            else:
                queryset = queryset.filter(department_id=department)
        org_role = self.request.query_params.get("org_role")
        if org_role:
            queryset = queryset.filter(org_role=org_role)
        employee_type = self.request.query_params.get("employee_type")
        if employee_type:
            queryset = queryset.filter(employee_type_id=employee_type)
        # Offboarded-list date range (飞书's 离职日期 filter).
        left_after = self.request.query_params.get("left_after")
        if left_after:
            queryset = queryset.filter(left_at__gte=left_after)
        left_before = self.request.query_params.get("left_before")
        if left_before:
            queryset = queryset.filter(left_at__lte=left_before)
        query = self.request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(
                Q(user__full_name__icontains=query)
                | Q(user__email__icontains=query)
                | Q(employee_no__icontains=query)
                | Q(title__icontains=query)
            )

        ordering = self.request.query_params.get("ordering") or "user__full_name"
        allowed = {
            "user__full_name",
            "-user__full_name",
            "hire_date",
            "-hire_date",
            "left_at",
            "-left_at",
            "employee_no",
            "-employee_no",
        }
        if ordering not in allowed:
            ordering = "user__full_name"
        return queryset.order_by(ordering)

    @staticmethod
    def _member_label(membership):
        user = membership.user
        return user.full_name or user.email or str(user.sub or user.id)

    @staticmethod
    def _member_snapshot(membership):
        return {
            "status": membership.status,
            "org_role": membership.org_role,
            "department": (
                str(membership.department_id) if membership.department_id else None
            ),
            "title": membership.title,
        }

    @staticmethod
    def _member_update_action(before, after):
        """Pick the most specific audit action for a membership edit."""
        if before["status"] != after["status"]:
            if after["status"] == models.MembershipStatusChoices.SUSPENDED:
                return models.AuditActionChoices.MEMBER_SUSPEND
            if (
                before["status"] == models.MembershipStatusChoices.SUSPENDED
                and after["status"] == models.MembershipStatusChoices.ACTIVE
            ):
                return models.AuditActionChoices.MEMBER_RESTORE
        if before["org_role"] != after["org_role"]:
            return models.AuditActionChoices.MEMBER_ROLE_CHANGE
        if before["department"] != after["department"]:
            return models.AuditActionChoices.MEMBER_DEPARTMENT_CHANGE
        return models.AuditActionChoices.MEMBER_UPDATE

    def perform_create(self, serializer):
        instance = serializer.save()
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.MEMBER_ADD,
            target_type="membership",
            target_id=instance.id,
            target_label=self._member_label(instance),
            metadata=self._member_snapshot(instance),
        )

    def perform_update(self, serializer):
        before = self._member_snapshot(serializer.instance)
        label = self._member_label(serializer.instance)
        instance = serializer.save()
        after = self._member_snapshot(instance)
        changes = {
            key: {"from": before[key], "to": after[key]}
            for key in after
            if before[key] != after[key]
        }
        if not changes:
            return
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=self._member_update_action(before, after),
            target_type="membership",
            target_id=instance.id,
            target_label=label,
            metadata={"changes": changes},
        )

    def perform_destroy(self, instance):
        label = self._member_label(instance)
        organization = instance.organization
        target_id = instance.id
        super().perform_destroy(instance)
        record_audit(
            actor=self.request.user,
            organization=organization,
            action=models.AuditActionChoices.MEMBER_REMOVE,
            target_type="membership",
            target_id=target_id,
            target_label=label,
        )

    # --- lifecycle (P10 M1) -------------------------------------------------

    @action(detail=True, methods=["get"], url_path="owned-resources")
    def owned_resources(self, request, *args, **kwargs):
        """What this member would leave behind — shown before confirming offboard."""
        return Response(offboarding.collect_owned_resources(self.get_object()))

    @action(detail=True, methods=["post"])
    def offboard(self, request, *args, **kwargs):
        """Mark the member as having left.

        Everything downstream (directory visibility, team-based resource access,
        org-scoped API results) already keys on ``status=ACTIVE``, so this one
        flag is what removes them — see ``core/services/offboarding``.
        """
        membership = self.get_object()
        serializer = OffboardSerializer(
            data=request.data, context={"organization": self.get_organization()}
        )
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        report = offboarding.offboard_membership(
            membership,
            actor=request.user,
            left_at=data.get("left_at"),
            reason=data.get("reason", ""),
            transfer_head_to=data.get("transfer_head_to"),
            allow_orphan_head=data.get("allow_orphan_head", False),
            disable_login=data.get("disable_login", True),
        )
        membership.refresh_from_db()
        return Response(
            {
                **report,
                "membership": MembershipAdminReadSerializer(membership).data,
            }
        )

    @action(detail=True, methods=["post"])
    def rehire(self, request, *args, **kwargs):
        """Bring a departed member back, reusing the same membership row."""
        membership = self.get_object()
        serializer = RehireSerializer(
            data=request.data, context={"organization": self.get_organization()}
        )
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        offboarding.rehire_membership(
            membership,
            actor=request.user,
            department=data.get("department"),
            org_role=data.get("org_role"),
        )
        membership.refresh_from_db()
        return Response(MembershipAdminReadSerializer(membership).data)

    @action(detail=True, methods=["delete"])
    def purge(self, request, *args, **kwargs):
        """Delete a departed member's row for good (飞书's 清空列表).

        Only reachable once they have left — this is a cleanup of the offboarded
        list, not a second way to remove an active member.
        """
        membership = self.get_object()
        if membership.status != models.MembershipStatusChoices.LEFT:
            raise serializers.ValidationError(
                {"detail": _("Only departed members can be purged.")}
            )
        label = self._member_label(membership)
        organization = membership.organization
        target_id = membership.id
        membership.delete()
        record_audit(
            actor=request.user,
            organization=organization,
            action=models.AuditActionChoices.MEMBER_PURGE,
            target_type="membership",
            target_id=target_id,
            target_label=label,
        )
        return Response(status=204)
