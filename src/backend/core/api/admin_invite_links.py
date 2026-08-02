"""Invite links and the application queue, from the console (P10 M4).

The queue is where the department scope has to hold. A department-scoped HR
sees applications landing in their subtree and nowhere else, and approving one
cannot place a person outside it — the same bidirectional check the member
endpoints got in M2-f, reused rather than re-derived, because a second
implementation of "is this in my scope" is a second thing to get wrong.
"""

from datetime import timedelta

from django.db.models import Q
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from rest_framework import mixins, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from core import models
from core.api.admin_org import DepartmentScopedMixin, _OrgScopedAdminViewSet
from core.api.admin_roles import HasOrgPermission
from core.api.serializers import UserLightSerializer
from core.api.viewsets import Pagination
from core.services import invite_links
from core.services.audit import record_audit

#: A link that never expires is a permanent back door; one that expires in a
#: year may as well be one. 30 days is long enough for a hiring round.
MAX_EXPIRY_DAYS = 30
DEFAULT_EXPIRY_DAYS = 7


class InviteLinkSerializer(serializers.ModelSerializer):
    department = serializers.SerializerMethodField()
    created_by = UserLightSerializer(read_only=True)
    is_expired = serializers.SerializerMethodField()

    class Meta:
        model = models.OrgInviteLink
        fields = [
            "id",
            "code",
            "department",
            "org_role",
            "title",
            "require_approval",
            "expires_at",
            "max_uses",
            "used_count",
            "is_active",
            "is_expired",
            "created_by",
            "created_at",
        ]
        read_only_fields = fields

    def get_department(self, obj):
        if obj.department_id:
            return {"id": str(obj.department_id), "name": obj.department.name}
        return None

    def get_is_expired(self, obj):
        return obj.expires_at <= timezone.now()


class InviteLinkCreateSerializer(serializers.ModelSerializer):
    #: Days from now, because that is what the console asks for. An absolute
    #: timestamp from a client whose clock we do not control is a worse input.
    expires_in_days = serializers.IntegerField(
        min_value=1, max_value=MAX_EXPIRY_DAYS, default=DEFAULT_EXPIRY_DAYS
    )

    class Meta:
        model = models.OrgInviteLink
        fields = [
            "id",
            "code",
            "department",
            "org_role",
            "title",
            "require_approval",
            "max_uses",
            "expires_in_days",
        ]
        read_only_fields = ["id", "code"]

    def validate_department(self, value):
        if value is not None and value.organization_id != self._organization().id:
            raise serializers.ValidationError(
                _("That department is not in your organization.")
            )
        return value

    def _organization(self):
        return self.context["organization"]

    def create(self, validated_data):
        days = validated_data.pop("expires_in_days", DEFAULT_EXPIRY_DAYS)
        validated_data["organization"] = self._organization()
        validated_data["created_by"] = self.context["request"].user
        validated_data["expires_at"] = timezone.now() + timedelta(days=days)
        return super().create(validated_data)


class InviteLinkViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    DepartmentScopedMixin,
    _OrgScopedAdminViewSet,
):
    """List / issue / revoke invite links."""

    permission_classes = [HasOrgPermission]
    required_permission = "org.invitation.write"
    pagination_class = Pagination

    def get_serializer_class(self):
        if self.action == "create":
            return InviteLinkCreateSerializer
        return InviteLinkSerializer

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.OrgInviteLink.objects.none()
        queryset = models.OrgInviteLink.objects.filter(
            organization=organization
        ).select_related("department", "created_by")
        # A scoped administrator sees the links that feed their own subtree.
        # Organization-level links (department=None) are nobody's subtree, so a
        # scoped holder does not see or issue them.
        context = self.admin_context()
        if context.is_scoped:
            queryset = context.filter_departments(
                models.Department.objects.filter(organization=organization)
            )
            return models.OrgInviteLink.objects.filter(
                organization=organization, department__in=queryset
            ).select_related("department", "created_by")
        # `list` only, for the same reason as JoinRequestViewSet below: a filter
        # left on for detail routes turns "already revoked" into 404.
        if self.action == "list" and self.request.query_params.get("active") == "1":
            queryset = queryset.filter(is_active=True, expires_at__gt=timezone.now())
        return queryset

    def perform_create(self, serializer):
        # A link with no department is organization-wide, which is outside any
        # department scope — same rule as creating a root department in M2-f.
        self.assert_in_scope(
            serializer.validated_data.get("department"),
            message=_("You can only issue links for departments you administer."),
        )
        link = serializer.save()
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.INVITE_LINK_CREATE,
            target_type="invite_link",
            target_id=link.id,
            target_label=link.code,
            metadata={
                "department": str(link.department_id) if link.department_id else None,
                "org_role": link.org_role,
                "require_approval": link.require_approval,
                "expires_at": link.expires_at.isoformat(),
            },
        )

    def perform_destroy(self, instance):
        """Revoke (deactivate) rather than delete — applications point at it."""
        if instance.is_active:
            instance.is_active = False
            instance.save(update_fields=["is_active", "updated_at"])
            invite_links.expire_stale_requests()
            record_audit(
                actor=self.request.user,
                organization=instance.organization,
                action=models.AuditActionChoices.INVITE_LINK_REVOKE,
                target_type="invite_link",
                target_id=instance.id,
                target_label=instance.code,
            )


class JoinRequestSerializer(serializers.ModelSerializer):
    department = serializers.SerializerMethodField()
    reviewed_by = UserLightSerializer(read_only=True)
    invited_by = serializers.SerializerMethodField()
    link_code = serializers.SerializerMethodField()

    class Meta:
        model = models.OrgJoinRequest
        fields = [
            "id",
            "full_name",
            "phone",
            "department",
            "org_role",
            "status",
            "invited_by",
            "link_code",
            "reviewed_by",
            "reviewed_at",
            "reject_reason",
            "created_at",
        ]
        read_only_fields = fields

    def get_department(self, obj):
        if obj.department_id:
            return {"id": str(obj.department_id), "name": obj.department.name}
        return None

    def get_invited_by(self, obj):
        """Who issued the link this application came through."""
        if obj.link_id and obj.link.created_by_id:
            return UserLightSerializer(obj.link.created_by).data
        return None

    def get_link_code(self, obj):
        return obj.link.code if obj.link_id else ""


class JoinRequestViewSet(
    mixins.ListModelMixin, DepartmentScopedMixin, _OrgScopedAdminViewSet
):
    """The application queue: list, approve, reject."""

    permission_classes = [HasOrgPermission]
    required_permission = "org.member.write"
    pagination_class = Pagination
    serializer_class = JoinRequestSerializer

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.OrgJoinRequest.objects.none()
        queryset = models.OrgJoinRequest.objects.filter(
            organization=organization
        ).select_related("department", "link__created_by", "reviewed_by", "user")

        context = self.admin_context()
        if context.is_scoped:
            departments = context.filter_departments(
                models.Department.objects.filter(organization=organization)
            )
            queryset = queryset.filter(department__in=departments)

        # Filters belong to `list` only. Applying them here for every action
        # makes `approve` on an already-approved row return 404 instead of the
        # "already handled" it should — the same trap M2-d hit by slicing the
        # queryset in `get_queryset`.
        if self.action != "list":
            return queryset

        status_filter = self.request.query_params.get(
            "status", models.OrgJoinStatusChoices.PENDING
        )
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        if self.request.query_params.get("mine") == "1":
            queryset = queryset.filter(link__created_by=self.request.user)
        return queryset

    @action(detail=True, methods=["post"])
    def approve(self, request, *args, **kwargs):
        join_request = self.get_object()
        department = self._resolve_department(request.data.get("department"))
        if department is not _UNSET:
            # Both directions, exactly as in M2-f: the application must be in
            # scope (the queryset already guarantees that) **and** approving it
            # must not place the person outside the reviewer's scope.
            self.assert_in_scope(
                department,
                message=_("You cannot place someone outside the departments you administer."),
            )
        try:
            invite_links.approve_request(
                join_request,
                actor=request.user,
                department=None if department is _UNSET else department,
                org_role=request.data.get("org_role") or None,
            )
        except invite_links.InviteError as exc:
            return Response({"detail": exc.message}, status=status.HTTP_400_BAD_REQUEST)
        join_request.refresh_from_db()
        return Response(self.get_serializer(join_request).data)

    @action(detail=True, methods=["post"])
    def reject(self, request, *args, **kwargs):
        join_request = self.get_object()
        try:
            invite_links.reject_request(
                join_request, actor=request.user, reason=request.data.get("reason", "")
            )
        except invite_links.InviteError as exc:
            return Response({"detail": exc.message}, status=status.HTTP_400_BAD_REQUEST)
        join_request.refresh_from_db()
        return Response(self.get_serializer(join_request).data)

    def _resolve_department(self, value):
        """``_UNSET`` when the caller did not name one; ``None`` means org level."""
        if value is None:
            return _UNSET
        if value == "":
            return None
        department = models.Department.objects.filter(
            pk=value, organization=self.get_organization()
        ).first()
        if department is None:
            raise serializers.ValidationError(
                {"department": _("That department is not in your organization.")}
            )
        return department


class _Unset:
    """Distinguishes "not supplied" from "explicitly organization level"."""

    def __repr__(self):  # pragma: no cover — debugging aid
        return "<unset>"


_UNSET = _Unset()
