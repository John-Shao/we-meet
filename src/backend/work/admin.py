"""Provider operations for Work tenant entitlements and member grants."""

from django import forms
from django.contrib import admin, messages

from . import audit, grants
from .models import WorkAccessAudit, WorkMemberGrant, WorkOrganizationEntitlement


class WorkMemberGrantForm(forms.ModelForm):
    """Let the service own the revoked/enabled invariant."""

    class Meta:
        model = WorkMemberGrant
        fields = "__all__"  # noqa: DJ007 -- service owns the revoked/enabled invariant.

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("enabled"):
            # Re-enabling a revoked row goes through the service, which clears
            # these fields and re-checks seats; validate the post-service shape.
            self.instance.revoked_at = None
            self.instance.revoked_reason = ""
        return cleaned



class AuditedAccessAdmin(admin.ModelAdmin):
    """Record who changed an access row, with before/after and request id."""

    audit_type = ""

    def audit_target(self, obj, target_id=None):
        return {
            "organization": obj.organization,
            "target_type": type(obj).__name__,
            "target_id": target_id if target_id is not None else obj.pk,
        }

    def audit_before(self, obj):
        if not obj.pk:
            return {}
        return audit.snapshot(type(obj).objects.filter(pk=obj.pk).first())

    def save_model(self, request, obj, form, change):
        before = self.audit_before(obj) if change else {}
        super().save_model(request, obj, form, change)
        audit.record_access_change(
            request=request,
            action=f"{self.audit_type}_{'updated' if change else 'created'}",
            before=before,
            after=audit.snapshot(obj),
            **self.audit_target(obj),
        )

    def delete_model(self, request, obj):
        target_id, before = str(obj.pk), audit.snapshot(obj)
        target = self.audit_target(obj, target_id)
        super().delete_model(request, obj)
        audit.record_access_change(
            request=request,
            action=f"{self.audit_type}_deleted",
            before=before,
            **target,
        )

    def delete_queryset(self, request, queryset):
        targets = [
            (self.audit_target(obj), audit.snapshot(obj))
            for obj in queryset.select_related("organization")
        ]
        super().delete_queryset(request, queryset)
        for target, before in targets:
            audit.record_access_change(
                request=request,
                action=f"{self.audit_type}_deleted",
                before=before,
                **target,
            )


@admin.register(WorkOrganizationEntitlement)
class WorkOrganizationEntitlementAdmin(AuditedAccessAdmin):
    audit_type = "entitlement"
    list_display = (
        "organization",
        "enabled",
        "daily_token_budget",
        "member_limit",
        "seats",
        "updated_at",
    )
    list_filter = ("enabled",)
    search_fields = ("organization__name", "organization__slug")
    autocomplete_fields = ("organization", "updated_by")
    readonly_fields = ("created_at", "updated_at", "seats")
    list_select_related = ("organization",)

    @admin.display(description="seats used / limit")
    def seats(self, obj):
        if not obj.pk:
            return "-"
        usage = grants.seat_usage(obj.organization_id)
        limit = usage["limit"]
        return f"{usage['active']} / {limit if limit is not None else 'unlimited'}"


@admin.register(WorkMemberGrant)
class WorkMemberGrantAdmin(AuditedAccessAdmin):
    audit_type = "grant"
    form = WorkMemberGrantForm
    list_display = (
        "organization",
        "user",
        "enabled",
        "source",
        "expires_at",
        "revoked_at",
        "revoked_reason",
    )
    list_filter = ("enabled", "source", "revoked_reason")
    search_fields = ("organization__name", "user__email", "user__sub")
    autocomplete_fields = ("organization", "user", "granted_by")
    readonly_fields = (
        "created_at",
        "updated_at",
        "revoked_at",
        "revoked_reason",
        "revoked_by",
    )
    list_select_related = ("organization", "user")

    def get_readonly_fields(self, request, obj=None):
        fields = list(super().get_readonly_fields(request, obj))
        if obj is not None:
            # A grant belongs to its member; moving it would silently move a seat.
            fields.extend(["organization", "user"])
        return fields

    def has_delete_permission(self, request, obj=None):
        # Revocation is a soft state change (disable + reason); deleting the
        # row would erase the fact that the seat was ever granted.
        return False

    def save_model(self, request, obj, form, change):
        """All seat checks and revocation revival live in ``work.grants``."""
        try:
            if obj.enabled:
                saved = grants.grant_member(
                    organization_id=obj.organization_id,
                    user_id=obj.user_id,
                    actor=request.user,
                    source=obj.source,
                    expires_at=obj.expires_at,
                    request_id=audit.request_id(request),
                )
            elif change:
                saved = grants.disable_member_grant(
                    organization_id=obj.organization_id,
                    user_id=obj.user_id,
                    actor=request.user,
                    request_id=audit.request_id(request),
                )
            else:
                saved = grants.grant_member(
                    organization_id=obj.organization_id,
                    user_id=obj.user_id,
                    actor=request.user,
                    source=obj.source,
                    expires_at=obj.expires_at,
                    request_id=audit.request_id(request),
                )
                saved = grants.disable_member_grant(
                    organization_id=obj.organization_id,
                    user_id=obj.user_id,
                    actor=request.user,
                    request_id=audit.request_id(request),
                )
        except (grants.MemberLimitReached, grants.GrantRejected) as exc:
            messages.error(request, str(exc.detail))
            return
        obj.pk = saved.pk
        obj.enabled = saved.enabled
        obj.revoked_at = saved.revoked_at
        obj.revoked_reason = saved.revoked_reason
        obj.revoked_by = saved.revoked_by



@admin.register(WorkAccessAudit)
class WorkAccessAuditAdmin(admin.ModelAdmin):
    list_display = (
        "created_at",
        "action",
        "organization",
        "actor",
        "target_type",
        "target_id",
        "request_id",
    )
    list_filter = ("action",)
    search_fields = ("organization__name", "actor__email", "target_id", "request_id")
    readonly_fields = (
        "organization",
        "actor",
        "action",
        "target_type",
        "target_id",
        "request_id",
        "before",
        "after",
        "created_at",
    )
    list_select_related = ("organization", "actor")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
