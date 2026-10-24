"""Provider operations for Work tenant entitlements and member grants."""

from django.contrib import admin

from . import audit
from .models import WorkAccessAudit, WorkMemberGrant, WorkOrganizationEntitlement


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
        "updated_at",
    )
    list_filter = ("enabled",)
    search_fields = ("organization__name", "organization__slug")
    autocomplete_fields = ("organization", "updated_by")
    readonly_fields = ("created_at", "updated_at")
    list_select_related = ("organization",)


@admin.register(WorkMemberGrant)
class WorkMemberGrantAdmin(AuditedAccessAdmin):
    audit_type = "grant"
    list_display = ("organization", "user", "enabled", "source", "expires_at")
    list_filter = ("enabled", "source")
    search_fields = ("organization__name", "user__email", "user__sub")
    autocomplete_fields = ("organization", "user", "granted_by")
    readonly_fields = ("created_at", "updated_at")
    list_select_related = ("organization", "user")


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
