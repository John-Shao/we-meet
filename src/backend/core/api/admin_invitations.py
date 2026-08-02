"""Organization invitation API (M 端) — pre-provision members before first login.

Org admins add a person by **phone number or email** plus a destination
department / role / title; the invitee's Membership is materialized with those
values when they first sign in (``core/services/invitation_provisioning.py``).
Revoking sets the invitation to ``revoked`` rather than deleting it, so the
audit trail survives.

Phone is the key that matters in practice (P10 M2-g). we-meet signs people in
with a mobile OTP and synthesizes their email from the number, so an
administrator has phone numbers and no way to guess the mailbox — which is what
made the original email-only endpoint unusable in production rather than merely
limited.
"""

from django.db.models import Q
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from rest_framework import mixins, serializers, viewsets

from core import models
from core.api.admin_org import IsOrgAdmin, _OrgScopedAdminViewSet
from core.api.serializers import UserLightSerializer
from core.api.viewsets import Pagination
from core.services.audit import record_audit
from core.services.phone import normalize_cn_phone, phone_variants


class OrgInvitationReadSerializer(serializers.ModelSerializer):
    """An invitation row for the console's pending-invites list."""

    invited_by = UserLightSerializer(read_only=True)
    department = serializers.SerializerMethodField()

    class Meta:
        model = models.OrgInvitation
        fields = [
            "id",
            "email",
            "phone",
            "full_name",
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
        fields = [
            "id",
            "email",
            "phone",
            "full_name",
            "department",
            "org_role",
            "title",
            "domain_warning",
        ]
        read_only_fields = ["id", "domain_warning"]
        extra_kwargs = {"email": {"required": False}}

    def validate_email(self, value):
        return (value or "").strip().lower()

    def validate_phone(self, value):
        """Accept what a person types; store one canonical spelling.

        Format only, exactly like Feishu: whether the number has ever signed in
        is unknowable from here (Keycloak creates the account on first OTP), and
        pretending to check would be a lie with a loading spinner.
        """
        if not value or not value.strip():
            return ""
        number = normalize_cn_phone(value)
        if not number:
            raise serializers.ValidationError(
                _("Enter a valid mainland-China mobile number (11 digits).")
            )
        return number

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
        # No email is not a foreign domain — a phone-only invitation has nothing
        # to warn about, and saying otherwise would put a warning on the most
        # common case.
        if not email:
            return False
        return not email.endswith(f"@{primary_domain}")

    def validate_department(self, value):
        if value is not None and value.organization_id != self._organization().id:
            raise serializers.ValidationError("department must be in your organization")
        return value

    def validate(self, attrs):
        email = attrs.get("email") or ""
        phone = attrs.get("phone") or ""
        if not email and not phone:
            raise serializers.ValidationError(
                {"phone": _("Enter a phone number or an email address.")}
            )

        organization = self._organization()
        pending = models.OrgInvitation.objects.filter(
            organization=organization, status=models.InvitationStatusChoices.PENDING
        )
        if email and pending.filter(email__iexact=email).exists():
            raise serializers.ValidationError(
                {"email": _("A pending invitation already exists for this email.")}
            )
        if phone and pending.filter(phone=phone).exists():
            raise serializers.ValidationError(
                {"phone": _("A pending invitation already exists for this number.")}
            )

        self._reject_existing_member(organization, email=email, phone=phone)
        return attrs

    @staticmethod
    def _reject_existing_member(organization, *, email, phone):
        """Feishu's rule: one number cannot be entered into a company twice.

        A departed member is called out separately rather than lumped in with
        "already here". Their Membership row still exists, so an invitation for
        them would be marked accepted on their next sign-in while
        ``claim_pending_invitations`` quietly declines to create a second
        membership — the administrator would see the invitation disappear and
        the person stay departed, with nothing to explain it. Rehire is the
        operation they actually want.
        """
        match = Q()
        if email:
            match |= Q(user__email__iexact=email)
        variants = phone_variants(phone)
        if variants:
            match |= Q(user__phone__in=variants)
        if not match:
            return

        existing = (
            models.Membership.objects.filter(match, organization=organization)
            .select_related("user")
            .order_by("status")  # "active" sorts before "left"
            .first()
        )
        if existing is None:
            return

        field = "phone" if phone and existing.user.phone else "email"
        if existing.status == models.MembershipStatusChoices.LEFT:
            raise serializers.ValidationError(
                {
                    field: _(
                        "This person is a departed member of your organization. "
                        "Reinstate them from the 已离职 tab instead of adding them again."
                    )
                }
            )
        raise serializers.ValidationError(
            {field: _("This person is already in your organization.")}
        )

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
            target_label=invitation.email or invitation.phone,
            metadata={
                "phone": invitation.phone or None,
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
                target_label=instance.email or instance.phone,
            )
