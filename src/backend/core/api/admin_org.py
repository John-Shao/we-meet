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

from core import models, utils
from core.api import permissions
from core.api.directory import get_caller_organization
from core.api.viewsets import Pagination
from core.services.audit import record_audit


class IsOrgAdmin(permissions.IsAuthenticated):
    """Authenticated AND an administrator/owner of their own organization."""

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        organization = get_caller_organization(request.user)
        if organization is None:
            return False
        return models.Membership.objects.filter(
            user=request.user,
            organization=organization,
            status=models.MembershipStatusChoices.ACTIVE,
            org_role__in=[
                models.OrgRoleChoices.ADMIN,
                models.OrgRoleChoices.OWNER,
            ],
        ).exists()


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

    def get_avatar_url(self, obj):
        """Short-lived presigned GET URL for the avatar, '' if unset."""
        return utils.generate_profile_image_get_url("avatar", obj.user.avatar_key)

    def get_department(self, obj):
        """Lightweight {id, name} of the membership's department, or None."""
        if obj.department_id:
            return {"id": str(obj.department_id), "name": obj.department.name}
        return None


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
        old_name = serializer.instance.name
        instance = serializer.save()
        if instance.name != old_name:
            record_audit(
                actor=self.request.user,
                organization=self.get_organization(),
                action=models.AuditActionChoices.DEPT_RENAME,
                target_type="department",
                target_id=instance.id,
                target_label=instance.name,
                metadata={"before": {"name": old_name}, "after": {"name": instance.name}},
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
        ).select_related("user", "department")

        status = self.request.query_params.get("status")
        if status:
            queryset = queryset.filter(status=status)
        department = self.request.query_params.get("department")
        if department:
            queryset = queryset.filter(department_id=department)
        org_role = self.request.query_params.get("org_role")
        if org_role:
            queryset = queryset.filter(org_role=org_role)
        query = self.request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(
                Q(user__full_name__icontains=query)
                | Q(user__email__icontains=query)
            )
        return queryset.order_by("user__full_name")

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
