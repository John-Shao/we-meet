"""Custom admin roles and their assignments (P10 M2).

The console's "roles and permissions" page. Two resources:

- ``/admin/roles/`` — the org's roles. Built-in ones (hr / it / admin_office)
  are seeded per organization and can have their permission set edited, but not
  their ``code`` (application logic and the seeder both key on it) and not their
  existence.
- ``/admin/role-assignments/`` — who holds which role, over which departments.

Managing roles is the escalation-sensitive corner of the console, so it is
gated on ``org.role.write``, which :mod:`core.permissions_registry` refuses to
put inside any custom role. Only the organization's own owner/administrator has
it. Without that rule an HR role could write itself ``org.role.write`` once and
then grant itself everything.
"""

from django.db import transaction
from django.db.models import Count
from django.utils.translation import gettext_lazy as _

from rest_framework import mixins, permissions as drf_permissions, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models, permissions_registry
from core.api import permissions
from core.api.directory import get_caller_organization
from core.services.audit import record_audit
from core.services.org_roles import ensure_builtin_roles
from core.services.org_permissions import get_admin_context


class HasOrgPermission(permissions.IsAuthenticated):
    """Authenticated AND holding ``required_permission`` in this organization.

    Set ``required_permission`` on the view. Deliberately a *separate* class
    from ``IsOrgAdmin`` rather than a replacement: the six admin modules that
    predate M2 keep their existing gate untouched, and new endpoints opt into
    the finer-grained one. An org owner/administrator satisfies both.
    """

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        required = getattr(view, "required_permission", None)
        if required is None:  # misconfiguration — fail closed, loudly
            raise RuntimeError(
                f"{view.__class__.__name__} uses HasOrgPermission without "
                "setting required_permission"
            )
        return get_admin_context(request).has(required)


class PermissionCatalogueView(APIView):
    """The permission registry, for rendering the role editor."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        ctx = get_admin_context(request)
        if not ctx.has("org.role.read"):
            return Response({"detail": _("Not allowed.")}, status=403)
        return Response({"permissions": permissions_registry.permission_catalogue()})


class AdminRoleSerializer(serializers.ModelSerializer):
    """A role and its permission set."""

    assignment_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = models.AdminRole
        fields = [
            "id",
            "name",
            "code",
            "description",
            "permissions",
            "is_builtin",
            "is_active",
            "assignment_count",
        ]
        read_only_fields = ["id", "is_builtin"]

    def validate_permissions(self, value):
        try:
            return permissions_registry.validate_permission_codes(value)
        except ValueError as exc:
            raise serializers.ValidationError(
                _("Unknown or non-grantable permission: %(codes)s")
                % {"codes": str(exc)}
            ) from exc

    def validate_code(self, value):
        if self.instance is not None and value != self.instance.code:
            raise serializers.ValidationError(
                _("A role's code cannot be changed after creation.")
            )
        return value

    def create(self, validated_data):
        validated_data["organization"] = self.context["organization"]
        return super().create(validated_data)


class AdminRoleAssignmentSerializer(serializers.ModelSerializer):
    """Who holds a role, over what."""

    department_ids = serializers.ListField(
        child=serializers.UUIDField(), write_only=True, required=False, default=list
    )
    role_name = serializers.CharField(source="role.name", read_only=True)
    member_name = serializers.SerializerMethodField()
    departments = serializers.SerializerMethodField()

    class Meta:
        model = models.AdminRoleAssignment
        fields = [
            "id",
            "role",
            "role_name",
            "membership",
            "member_name",
            "scope_type",
            "department_ids",
            "departments",
        ]
        read_only_fields = ["id"]

    def get_member_name(self, instance):
        user = instance.membership.user
        return user.full_name or user.short_name or user.email or ""

    def get_departments(self, instance):
        return [
            {"id": str(row.department_id), "name": row.department.name}
            for row in instance.scope_departments.all()
        ]

    def _organization(self):
        return self.context["organization"]

    def validate_role(self, value):
        if value.organization_id != self._organization().id:
            raise serializers.ValidationError(_("Role must be in your organization."))
        return value

    def validate_membership(self, value):
        if value.organization_id != self._organization().id:
            raise serializers.ValidationError(_("Member must be in your organization."))
        return value

    def validate(self, attrs):
        """A department-scoped assignment that names no department reaches nobody.

        Accepting it would produce an administrator who sees an empty console
        and files a bug. Reject at the door instead.
        """
        scope_type = attrs.get(
            "scope_type",
            getattr(self.instance, "scope_type", models.AdminScopeChoices.ALL),
        )
        department_ids = attrs.get("department_ids") or []
        if scope_type == models.AdminScopeChoices.DEPARTMENTS and not department_ids:
            raise serializers.ValidationError(
                {
                    "department_ids": _(
                        "Select at least one department, or scope the role to "
                        "the whole organization."
                    )
                }
            )
        if scope_type == models.AdminScopeChoices.ALL and department_ids:
            raise serializers.ValidationError(
                {
                    "department_ids": _(
                        "Departments only apply when the scope is 'departments'."
                    )
                }
            )
        if department_ids:
            found = models.Department.objects.filter(
                organization=self._organization(),
                id__in=department_ids,
                deleted_at__isnull=True,
            ).count()
            if found != len(set(department_ids)):
                raise serializers.ValidationError(
                    {"department_ids": _("Unknown department in your organization.")}
                )
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        department_ids = validated_data.pop("department_ids", [])
        request = self.context.get("request")
        if request is not None:
            validated_data["created_by"] = request.user
        assignment = super().create(validated_data)
        self._sync_scope(assignment, department_ids)
        return assignment

    @transaction.atomic
    def update(self, instance, validated_data):
        department_ids = validated_data.pop("department_ids", None)
        assignment = super().update(instance, validated_data)
        if department_ids is not None:
            self._sync_scope(assignment, department_ids)
        return assignment

    @staticmethod
    def _sync_scope(assignment, department_ids):
        assignment.scope_departments.all().delete()
        models.AdminRoleScopeDepartment.objects.bulk_create(
            [
                models.AdminRoleScopeDepartment(
                    assignment=assignment, department_id=did
                )
                for did in dict.fromkeys(department_ids)
            ]
        )


class _RoleAdminViewSet(viewsets.GenericViewSet):
    """Shared plumbing for the two role resources."""

    permission_classes = [HasOrgPermission]
    pagination_class = None  # roles and their holders are counted in tens

    def get_organization(self):
        return get_caller_organization(self.request.user)

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["organization"] = self.get_organization()
        return context

    def get_permissions(self):
        # Reading is a weaker right than writing; the console lists roles on a
        # page that people with org.role.read can open.
        self.required_permission = (
            "org.role.read"
            if self.request.method in drf_permissions.SAFE_METHODS
            else "org.role.write"
        )
        return super().get_permissions()


class AdminRoleViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    _RoleAdminViewSet,
):
    """The organization's admin roles."""

    serializer_class = AdminRoleSerializer

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.AdminRole.objects.none()
        return models.AdminRole.objects.filter(organization=organization).annotate(
            assignment_count=Count("assignments", distinct=True)
        )

    def _audit(self, instance, action_code, **metadata):
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=action_code,
            target_type="admin_role",
            target_id=instance.id,
            target_label=instance.name,
            metadata={"code": instance.code, **metadata},
        )

    def perform_create(self, serializer):
        instance = serializer.save()
        self._audit(
            instance,
            models.AuditActionChoices.ROLE_CREATE,
            permissions=instance.permissions,
        )

    def perform_update(self, serializer):
        before = sorted(serializer.instance.permissions or [])
        instance = serializer.save()
        after = sorted(instance.permissions or [])
        # Diff, not the full list: "what changed" is the question an audit trail
        # is read to answer, and permission sets are long.
        self._audit(
            instance,
            models.AuditActionChoices.ROLE_UPDATE,
            granted=sorted(set(after) - set(before)),
            revoked=sorted(set(before) - set(after)),
        )

    def perform_destroy(self, instance):
        if instance.is_builtin:
            raise serializers.ValidationError(
                {
                    "detail": _(
                        "Built-in roles cannot be deleted. Deactivate it instead."
                    )
                }
            )
        holders = instance.assignments.count()
        self._audit(
            instance, models.AuditActionChoices.ROLE_DELETE, revoked_from=holders
        )
        instance.delete()

    @action(detail=False, methods=["post"], url_path="seed-builtin")
    def seed_builtin(self, request, *args, **kwargs):
        """Create any missing built-in roles for this organization."""
        organization = self.get_organization()
        created = ensure_builtin_roles(organization)
        return Response({"created": created})


class AdminRoleAssignmentViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    _RoleAdminViewSet,
):
    """Who holds which role. Filter with ``?membership=<id>`` / ``?role=<id>``."""

    serializer_class = AdminRoleAssignmentSerializer

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.AdminRoleAssignment.objects.none()
        queryset = (
            models.AdminRoleAssignment.objects.filter(role__organization=organization)
            .select_related("role", "membership__user")
            .prefetch_related("scope_departments__department")
        )
        for param, field_name in (("membership", "membership_id"), ("role", "role_id")):
            value = self.request.query_params.get(param)
            if value:
                queryset = queryset.filter(**{field_name: value})
        return queryset

    def _audit(self, instance, action_code):
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=action_code,
            target_type="admin_role_assignment",
            target_id=instance.id,
            target_label=instance.role.name,
            metadata={
                "membership_id": str(instance.membership_id),
                "scope_type": instance.scope_type,
            },
        )

    def perform_create(self, serializer):
        self._audit(serializer.save(), models.AuditActionChoices.ROLE_ASSIGN)

    def perform_update(self, serializer):
        self._audit(serializer.save(), models.AuditActionChoices.ROLE_ASSIGN)

    def perform_destroy(self, instance):
        self._audit(instance, models.AuditActionChoices.ROLE_UNASSIGN)
        instance.delete()
