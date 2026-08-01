"""Organization invitation API (M 端) — pre-provision members before first login.

Org admins create invitations (email + destination department / role / title);
the invitee's Membership is materialized with those values when they first sign
in (``core/services/invitation_provisioning.py``). Revoking sets the invitation
to ``revoked`` rather than deleting it, so the audit trail survives.
"""

from django.utils import timezone

from rest_framework import mixins, serializers, viewsets

from core import models
from core.api.admin_org import IsOrgAdmin, _OrgScopedAdminViewSet
from core.api.serializers import UserLightSerializer
from core.api.viewsets import Pagination
from core.services.audit import record_audit


class OrgInvitationReadSerializer(serializers.ModelSerializer):
    """An invitation row for the console's pending-invites list."""

    invited_by = UserLightSerializer(read_only=True)
    department = serializers.SerializerMethodField()

    class Meta:
        model = models.OrgInvitation
        fields = [
            "id",
            "email",
            "department",
            "org_role",
            "title",
            "status",
            "invited_by",
            "created_at",
        ]
        read_only_fields = fields

    def get_department(self, obj):
        if obj.department_id:
            return {"id": str(obj.department_id), "name": obj.department.name}
        return None


class OrgInvitationCreateSerializer(serializers.ModelSerializer):
    """Create an invitation within the caller's organization."""

    # Surfaced (not enforced) when the email's domain is not the organization's:
    # inviting a contractor on their own domain is legitimate, so this is a
    # "did you mean to?" signal for the console, not a rejection.
    domain_warning = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = models.OrgInvitation
        fields = ["id", "email", "department", "org_role", "title", "domain_warning"]
        read_only_fields = ["id", "domain_warning"]

    def validate_email(self, value):
        return value.strip().lower()

    def get_domain_warning(self, obj):
        """True when the invitee's email domain differs from the org's primary one.

        This is the first thing that reads ``Organization.primary_domain`` — the
        column has existed since P1 with a help_text promising exactly this and
        no code behind it.
        """
        primary_domain = (self._organization().primary_domain or "").strip().lower()
        if not primary_domain:
            return False
        email = (getattr(obj, "email", "") or "").lower()
        return not email.endswith(f"@{primary_domain}")

    def validate_department(self, value):
        if value is not None and value.organization_id != self._organization().id:
            raise serializers.ValidationError("department must be in your organization")
        return value

    def validate(self, attrs):
        email = attrs.get("email")
        if (
            email
            and models.OrgInvitation.objects.filter(
                organization=self._organization(),
                email__iexact=email,
                status=models.InvitationStatusChoices.PENDING,
            ).exists()
        ):
            raise serializers.ValidationError(
                {"email": "A pending invitation already exists for this email."}
            )
        return attrs

    def _organization(self):
        return self.context["organization"]

    def create(self, validated_data):
        validated_data["organization"] = self._organization()
        validated_data["invited_by"] = self.context["request"].user
        return super().create(validated_data)


class OrgInvitationViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    _OrgScopedAdminViewSet,
):
    """List / create / revoke organization invitations (org admins only).

    ``list`` defaults to pending invitations; pass ``?status=`` for others.
    """

    permission_classes = [IsOrgAdmin]
    pagination_class = Pagination

    def get_serializer_class(self):
        if self.action == "create":
            return OrgInvitationCreateSerializer
        return OrgInvitationReadSerializer

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.OrgInvitation.objects.none()
        queryset = models.OrgInvitation.objects.filter(
            organization=organization
        ).select_related("department", "invited_by")
        status = self.request.query_params.get(
            "status", models.InvitationStatusChoices.PENDING
        )
        if status:
            queryset = queryset.filter(status=status)
        return queryset

    def perform_create(self, serializer):
        invitation = serializer.save()
        record_audit(
            actor=self.request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.MEMBER_INVITE,
            target_type="invitation",
            target_id=invitation.id,
            target_label=invitation.email,
            metadata={
                "department": (
                    str(invitation.department_id)
                    if invitation.department_id
                    else None
                ),
                "org_role": invitation.org_role,
            },
        )

    def perform_destroy(self, instance):
        """Revoke (soft) rather than delete, preserving the audit trail."""
        if instance.status == models.InvitationStatusChoices.PENDING:
            instance.status = models.InvitationStatusChoices.REVOKED
            instance.save(update_fields=["status", "updated_at"])
            record_audit(
                actor=self.request.user,
                organization=instance.organization,
                action=models.AuditActionChoices.MEMBER_INVITE_REVOKE,
                target_type="invitation",
                target_id=instance.id,
                target_label=instance.email,
            )
