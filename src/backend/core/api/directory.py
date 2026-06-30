"""Directory (通讯录) + org-structure read API.

Exposes the organization's department tree and member directory so the IM
new-conversation picker, meeting invite and (future) approval routing can
browse / search people by department instead of guessing raw identifiers. This
replaces the ``ALLOW_UNSECURE_USER_LISTING`` escape hatch with an org-scoped,
authenticated directory.

Read-only on purpose — department / membership mutations live in the admin
console (P1-d). Every queryset is scoped to the caller's organization from day
one, even though MVP runs a single organization.
"""

from django.db.models import Q

from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action

from core import models, utils
from core.api import permissions
from core.api.serializers import UserLightSerializer
from core.api.viewsets import Pagination


def get_caller_organization(user):
    """Resolve the caller's organization (MVP: the single org of their membership).

    Prefers the primary membership; returns ``None`` for users with no active
    membership (so their directory queries come back empty rather than leaking
    another organization's data).
    """
    membership = (
        models.Membership.objects.filter(
            user=user, status=models.MembershipStatusChoices.ACTIVE
        )
        .select_related("organization")
        .order_by("-is_primary", "created_at")
        .first()
    )
    return membership.organization if membership else None


class DepartmentSerializer(serializers.ModelSerializer):
    """Serialize a department node (flat; the client builds the tree from path/parent)."""

    head = UserLightSerializer(read_only=True)

    class Meta:
        model = models.Department
        fields = [
            "id",
            "name",
            "parent",
            "path",
            "depth",
            "sort_order",
            "head",
        ]
        read_only_fields = fields


class DirectoryMemberSerializer(serializers.Serializer):
    """Serialize a Membership row as a person-card for the directory / picker.

    ``id`` is the we-meet user id — the IM new-conversation endpoint resolves the
    peer's IM uid server-side from it (P1-d), so the raw IM uid is never exposed
    here nor resolved per-row (which would lazily register every listed user).
    """

    id = serializers.UUIDField(source="user.id", read_only=True)
    # The membership row id — admins PATCH /admin/memberships/{membership_id}/ to
    # move this person between departments.
    membership_id = serializers.UUIDField(source="id", read_only=True)
    sub = serializers.CharField(source="user.sub", read_only=True)
    full_name = serializers.CharField(source="user.full_name", read_only=True)
    short_name = serializers.CharField(source="user.short_name", read_only=True)
    email = serializers.EmailField(source="user.email", read_only=True)
    avatar_url = serializers.SerializerMethodField()
    title = serializers.CharField(read_only=True)
    org_role = serializers.CharField(read_only=True)
    department = serializers.SerializerMethodField()
    is_self = serializers.SerializerMethodField()

    def get_avatar_url(self, obj):
        """Short-lived presigned GET URL for the avatar, '' if unset."""
        return utils.generate_profile_image_get_url("avatar", obj.user.avatar_key)

    def get_department(self, obj):
        """Lightweight {id, name} of the membership's department, or None (org-level)."""
        if obj.department_id:
            return {"id": str(obj.department_id), "name": obj.department.name}
        return None

    def get_is_self(self, obj):
        """Whether this card is the caller (lets the UI hide 'message myself')."""
        request = self.context.get("request")
        return bool(request and obj.user_id == request.user.id)


class DepartmentViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet
):
    """Browse the caller organization's department tree (read-only)."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = DepartmentSerializer
    pagination_class = None  # department trees are small — return the whole list

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.Department.objects.none()
        queryset = (
            models.Department.objects.filter(
                organization=organization,
                is_active=True,
                deleted_at__isnull=True,
            )
            .select_related("head")
            .order_by("path", "sort_order", "name")
        )
        parent = self.request.query_params.get("parent")
        if parent:
            queryset = queryset.filter(parent_id=parent)
        return queryset

    @action(detail=True, methods=["get"])
    def members(self, request, *args, **kwargs):
        """Members of this department, optionally of its whole subtree."""
        department = self.get_object()
        memberships = (
            models.Membership.objects.filter(
                status=models.MembershipStatusChoices.ACTIVE,
                user__is_device=False,
                user__sub__isnull=False,  # skip OIDC-less Django-admin accounts
            )
            .exclude(user__sub="")
            .select_related("user", "department")
            .order_by("user__full_name")
        )
        if request.query_params.get("include_subtree") == "true":
            subtree_ids = models.Department.objects.filter(
                organization=department.organization,
                path__startswith=department.path,
            ).values_list("id", flat=True)
            memberships = memberships.filter(department_id__in=subtree_ids)
        else:
            memberships = memberships.filter(department=department)

        paginator = Pagination()
        page = paginator.paginate_queryset(memberships, request, view=self)
        serializer = DirectoryMemberSerializer(
            page, many=True, context={"request": request}
        )
        return paginator.get_paginated_response(serializer.data)


class DirectoryMemberViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet
):
    """Search / browse organization members, one card per user (read-only).

    The list is built from each user's *primary* membership (guaranteed unique
    per user per organization), so a person never appears twice.
    """

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = DirectoryMemberSerializer
    pagination_class = Pagination
    lookup_field = "user_id"

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.Membership.objects.none()
        queryset = (
            models.Membership.objects.filter(
                organization=organization,
                status=models.MembershipStatusChoices.ACTIVE,
                is_primary=True,
                user__is_device=False,
                user__sub__isnull=False,  # skip OIDC-less Django-admin accounts
            )
            .exclude(user__sub="")
            .select_related("user", "department")
            .order_by("user__full_name")
        )
        department = self.request.query_params.get("department")
        if department:
            queryset = queryset.filter(department_id=department)
        query = self.request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(
                Q(user__full_name__icontains=query)
                | Q(user__email__icontains=query)
            )
        return queryset

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["request"] = self.request
        return context
