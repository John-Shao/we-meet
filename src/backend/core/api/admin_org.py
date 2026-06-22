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
from django.utils import timezone

from rest_framework import mixins, serializers, viewsets

from core import models
from core.api import permissions
from core.api.directory import get_caller_organization


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

    def _organization(self):
        return self.context["organization"]

    def create(self, validated_data):
        validated_data["organization"] = self._organization()
        return super().create(validated_data)


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

    def perform_destroy(self, instance):
        """Soft-delete. Refuse if the department still has children or members
        unless ``?reassign=<dept_id>`` moves its members to another department."""
        if instance.children.filter(deleted_at__isnull=True).exists():
            raise serializers.ValidationError(
                {"detail": "department has sub-departments; delete or move them first"}
            )
        members = models.Membership.objects.filter(department=instance)
        reassign_id = self.request.query_params.get("reassign")
        with transaction.atomic():
            if members.exists():
                if not reassign_id:
                    raise serializers.ValidationError(
                        {"detail": "department has members; pass ?reassign=<dept_id>"}
                    )
                target = models.Department.objects.filter(
                    id=reassign_id,
                    organization=instance.organization,
                    deleted_at__isnull=True,
                ).first()
                if target is None or target.id == instance.id:
                    raise serializers.ValidationError(
                        {"reassign": "invalid target department"}
                    )
                members.update(department=target)
            instance.is_active = False
            instance.deleted_at = timezone.now()
            instance.save()


class MembershipAdminViewSet(
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    _OrgScopedAdminViewSet,
):
    """Add / update / remove memberships (org admins only)."""

    serializer_class = MembershipAdminSerializer

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.Membership.objects.none()
        return models.Membership.objects.filter(organization=organization)
