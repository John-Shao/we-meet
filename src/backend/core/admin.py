"""Admin classes and registrations for core app."""

from django import forms
from django.contrib import admin, messages
from django.contrib.auth import admin as auth_admin
from django.db import transaction
from django.db.models import Count
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from core.recording.event import notification

from . import models


@admin.register(models.User)
class UserAdmin(auth_admin.UserAdmin):
    """Admin class for the User model"""

    fieldsets = (
        (
            None,
            {
                "fields": (
                    "id",
                    "admin_email",
                    "password",
                )
            },
        ),
        (
            _("Personal info"),
            {
                "fields": (
                    "sub",
                    "email",
                    "full_name",
                    "short_name",
                    "language",
                    "timezone",
                )
            },
        ),
        (
            _("Permissions"),
            {
                "fields": (
                    "is_active",
                    "is_device",
                    "is_staff",
                    "is_superuser",
                    "groups",
                    "user_permissions",
                ),
            },
        ),
        (_("Important dates"), {"fields": ("created_at", "updated_at")}),
    )
    add_fieldsets = (
        (
            None,
            {
                "classes": ("wide",),
                "fields": ("email", "password1", "password2"),
            },
        ),
    )
    list_display = (
        "id",
        "sub",
        "admin_email",
        "email",
        "full_name",
        "short_name",
        "is_active",
        "is_staff",
        "is_superuser",
        "is_device",
        "created_at",
        "updated_at",
    )
    list_filter = ("is_staff", "is_superuser", "is_device", "is_active")
    ordering = (
        "is_active",
        "-is_superuser",
        "-is_staff",
        "-is_device",
        "-updated_at",
        "full_name",
    )
    readonly_fields = (
        "id",
        "sub",
        "email",
        "full_name",
        "short_name",
        "created_at",
        "updated_at",
    )
    search_fields = ("id", "sub", "admin_email", "email", "full_name")


class ResourceAccessInline(admin.TabularInline):
    """Admin class for the room user access model"""

    model = models.ResourceAccess
    extra = 0
    autocomplete_fields = ["user"]


@admin.register(models.Room)
class RoomAdmin(admin.ModelAdmin):
    """Room admin interface declaration."""

    inlines = (ResourceAccessInline,)
    search_fields = ["name", "slug", "=id"]
    list_display = ["name", "slug", "access_level", "get_owner", "created_at"]
    list_filter = ["access_level", "created_at"]
    readonly_fields = ["id", "created_at", "updated_at"]

    def get_queryset(self, request):
        """Optimize queries by prefetching related access and user data to avoid N+1 queries."""
        return super().get_queryset(request).prefetch_related("accesses__user")

    def get_owner(self, obj):
        """Return the owner of the room for display in the admin list."""

        owners = [
            access
            for access in obj.accesses.all()
            if access.role == models.RoleChoices.OWNER
        ]

        if not owners:
            return _("No owner")

        if len(owners) > 1:
            return _("Multiple owners")

        return str(owners[0].user)


class RecordingAccessInline(admin.TabularInline):
    """Inline admin class for recording accesses."""

    model = models.RecordingAccess
    extra = 0
    autocomplete_fields = ["user"]


@admin.action(description=_("Resend notification to external service"))
def resend_notification(modeladmin, request, queryset):  # pylint: disable=unused-argument
    """Resend notification to external service for selected recordings."""

    notification_service = notification.NotificationService()
    processed = 0
    skipped = 0
    failed = 0

    for recording in queryset:
        if recording.is_expired:
            skipped += 1
            continue

        try:
            success = notification_service.notify_external_services(recording)

            if success:
                processed += 1
            else:
                failed += 1
                modeladmin.message_user(
                    request,
                    _("Failed to notify for recording %(id)s") % {"id": recording.id},
                    level=messages.ERROR,
                )

        except Exception as e:  # noqa: BLE001 # pylint: disable=broad-except
            failed += 1
            modeladmin.message_user(
                request,
                _("Failed to notify for recording %(id)s: %(error)s")
                % {"id": recording.id, "error": str(e)},
                level=messages.ERROR,
            )

    if processed > 0:
        modeladmin.message_user(
            request,
            _("Successfully sent notifications for %(count)s recording(s).")
            % {"count": processed},
            level=messages.SUCCESS,
        )

    if skipped > 0:
        modeladmin.message_user(
            request,
            _("Skipped %(count)s expired recording(s).") % {"count": skipped},
            level=messages.WARNING,
        )


@admin.action(description=_("Mark selected recordings as 'Failed to Stop'"))
def mark_as_failed_to_stop(modeladmin, request, queryset):
    """Force selected recordings status to failed_to_stop."""

    eligible_statuses = [
        models.RecordingStatusChoices.ACTIVE,
        models.RecordingStatusChoices.INITIATED,
        models.RecordingStatusChoices.STOPPED,
    ]

    eligible = queryset.filter(status__in=eligible_statuses)
    skipped = queryset.exclude(status__in=eligible_statuses).count()

    updated = eligible.update(status=models.RecordingStatusChoices.FAILED_TO_STOP)

    if updated > 0:
        modeladmin.message_user(
            request,
            _("%(count)s recording(s) successfully marked as 'Failed to Stop'.")
            % {"count": updated},
            level=messages.SUCCESS,
        )

    if skipped > 0:
        modeladmin.message_user(
            request,
            _("Skipped %(count)s recording(s) with an ineligible status.")
            % {"count": skipped},
            level=messages.WARNING,
        )


@admin.register(models.Recording)
class RecordingAdmin(admin.ModelAdmin):
    """Recording admin interface declaration."""

    inlines = (RecordingAccessInline,)
    search_fields = ["status", "=id", "worker_id", "room__slug", "=room__id"]
    list_display = (
        "id",
        "status",
        "mode",
        "room",
        "get_owner",
        "created_at",
        "worker_id",
    )
    list_filter = ["created_at"]
    list_select_related = ("room",)
    readonly_fields = (
        "id",
        "created_at",
        "options",
        "mode",
        "room",
        "status",
        "updated_at",
        "worker_id",
    )
    actions = [resend_notification, mark_as_failed_to_stop]

    def get_queryset(self, request):
        """Optimize queries by prefetching related access and user data to avoid N+1 queries."""
        return super().get_queryset(request).prefetch_related("accesses__user")

    def get_owner(self, obj):
        """Return the owner of the recording for display in the admin list."""

        owners = [
            access
            for access in obj.accesses.all()
            if access.role == models.RoleChoices.OWNER
        ]

        if not owners:
            return _("No owner")

        if len(owners) > 1:
            return _("Multiple owners")

        return str(owners[0].user)


class ApplicationDomainInline(admin.TabularInline):
    """Inline admin for managing allowed domains per application."""

    model = models.ApplicationDomain
    extra = 0


class ApplicationAdminForm(forms.ModelForm):
    """Custom form for Application admin with multi-select scopes."""

    scopes = forms.MultipleChoiceField(
        choices=models.ApplicationScope.choices,
        widget=forms.CheckboxSelectMultiple,
        required=False,
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance.pk and self.instance.scopes:
            self.fields["scopes"].initial = self.instance.scopes


@admin.register(models.Application)
class ApplicationAdmin(admin.ModelAdmin):
    """Admin interface for managing applications and their permissions."""

    form = ApplicationAdminForm

    list_display = ("id", "name", "client_id", "get_scopes_display", "is_active")
    fields = [
        "name",
        "id",
        "created_at",
        "updated_at",
        "scopes",
        "client_id",
        "client_secret",
        "is_active",
    ]
    readonly_fields = ["id", "created_at", "updated_at"]
    inlines = [ApplicationDomainInline]

    def get_readonly_fields(self, request, obj=None):
        """Make client_id and client_secret readonly after creation."""
        if obj:  # Editing existing object
            return self.readonly_fields + ["client_id", "client_secret"]
        return self.readonly_fields

    def get_fields(self, request, obj=None):
        """Hide client_secret after creation."""
        fields = super().get_fields(request, obj)
        if obj:
            return [f for f in fields if f != "client_secret"]
        return fields

    def get_scopes_display(self, obj):
        """Display scopes in list view."""
        if obj.scopes:
            return ", ".join(obj.scopes)
        return _("No scopes")

    get_scopes_display.short_description = _("Scopes")


# ---------------------------------------------------------------------------
# AI assistant catalog
# ---------------------------------------------------------------------------


class AIVoiceInline(admin.TabularInline):
    """Inline voices on the AIModel page (TTS / Omni models only)."""

    model = models.AIVoice
    extra = 0
    fields = ("value", "label", "sort_order", "is_active")


@admin.register(models.AIVendor)
class AIVendorAdmin(admin.ModelAdmin):
    list_display = ("code", "display_name", "sort_order", "is_active")
    list_editable = ("sort_order", "is_active")
    search_fields = ("code", "display_name")


@admin.register(models.AIModel)
class AIModelAdmin(admin.ModelAdmin):
    list_display = (
        "code",
        "vendor",
        "capability",
        "display_name",
        "api_key_env",
        "sort_order",
        "is_active",
    )
    list_filter = ("vendor", "capability", "is_active")
    list_editable = ("sort_order", "is_active")
    search_fields = ("code", "display_name")
    autocomplete_fields = ("vendor",)
    inlines = (AIVoiceInline,)


@admin.register(models.AIPrompt)
class AIPromptAdmin(admin.ModelAdmin):
    list_display = ("label", "sort_order", "is_active")
    list_filter = ("is_active",)
    list_editable = ("sort_order", "is_active")
    search_fields = ("label", "content")


@admin.register(models.AIVoice)
class AIVoiceAdmin(admin.ModelAdmin):
    list_display = ("value", "label", "model", "sort_order", "is_active")
    list_filter = ("model__vendor", "model__capability", "is_active")
    list_editable = ("sort_order", "is_active")
    search_fields = ("value", "label", "model__code")
    autocomplete_fields = ("model",)


@admin.register(models.AIAgentProfile)
class AIAgentProfileAdmin(admin.ModelAdmin):
    list_display = (
        "code",
        "display_name",
        "architecture",
        "agent_type",
        "_models_summary",
        "sort_order",
        "is_active",
    )
    list_filter = ("architecture", "agent_type", "is_active")
    list_editable = ("sort_order", "is_active")
    search_fields = ("code", "display_name")
    autocomplete_fields = (
        "stt_model",
        "tts_model",
        "vlm_model",
        "llm_model",
        "omni_model",
        "default_voice",
    )
    fieldsets = (
        (
            None,
            {
                "fields": (
                    "code",
                    "display_name",
                    "architecture",
                    "agent_type",
                    "sort_order",
                    "is_active",
                )
            },
        ),
        (
            _("Models"),
            {
                "fields": (
                    "stt_model",
                    "vlm_model",
                    "llm_model",
                    "tts_model",
                    "omni_model",
                )
            },
        ),
        (_("Defaults"), {"fields": ("default_voice",)}),
    )

    def _models_summary(self, obj):
        parts = []
        for cap in ("stt", "vlm", "llm", "tts", "omni"):
            model = getattr(obj, f"{cap}_model", None)
            if model:
                parts.append(f"{cap}: {model.code}")
        return " · ".join(parts) or "-"

    _models_summary.short_description = _("models")


@admin.register(models.UserAIPreference)
class UserAIPreferenceAdmin(admin.ModelAdmin):
    list_display = ("user", "profile", "voice", "prompt", "updated_at")
    list_filter = ("profile",)
    search_fields = ("user__email", "user__full_name")
    autocomplete_fields = ("user", "profile", "voice", "prompt")
    readonly_fields = ("created_at", "updated_at")


class ActionItemInline(admin.TabularInline):
    """Inline editor for the action items attached to a Summary."""

    model = models.ActionItem
    extra = 0
    fields = ("sort_order", "content", "owner_text", "due_text", "is_completed")
    autocomplete_fields = ()
    fk_name = "summary"


@admin.register(models.Summary)
class SummaryAdmin(admin.ModelAdmin):
    list_display = (
        "room",
        "status",
        "model_used",
        "transcripts_count",
        "updated_at",
    )
    list_filter = ("status",)
    search_fields = ("room__name", "content")
    autocomplete_fields = ("room",)
    readonly_fields = ("created_at", "updated_at")
    inlines = (ActionItemInline,)


@admin.register(models.ActionItem)
class ActionItemAdmin(admin.ModelAdmin):
    list_display = (
        "room",
        "owner_text",
        "_content_preview",
        "due_text",
        "is_completed",
        "sort_order",
    )
    list_filter = ("is_completed",)
    list_editable = ("is_completed", "sort_order")
    search_fields = ("content", "owner_text", "room__name")
    autocomplete_fields = ("room", "summary", "source_transcript")

    def _content_preview(self, obj):
        return (obj.content[:60] + "…") if len(obj.content) > 60 else obj.content

    _content_preview.short_description = _("content")


@admin.register(models.Transcript)
class TranscriptAdmin(admin.ModelAdmin):
    list_display = (
        "room",
        "speaker_identity",
        "speaker_name",
        "_text_preview",
        "language",
        "started_at",
    )
    list_filter = ("language",)
    search_fields = ("text", "speaker_identity", "speaker_name", "room__name")
    autocomplete_fields = ("room",)
    readonly_fields = ("created_at", "updated_at")
    date_hierarchy = "started_at"

    def _text_preview(self, obj):
        return (obj.text[:60] + "…") if len(obj.text) > 60 else obj.text

    _text_preview.short_description = _("text")


# ---------------------------------------------------------------------------
# Organization directory (P1) — org / department / membership
#
# Interim management surface: until the dedicated admin console ("M 端") ships,
# org / department / membership are managed here in the Django admin (Django
# staff only). Behaviour mirrors the org-admin API (core/api/admin_org.py):
#   - departments are SOFT-deleted (members fall back to "no department"),
#     never hard-deleted (hard delete would CASCADE the whole subtree);
#   - a department's parent is fixed after creation (reparenting would need a
#     descendant path rewrite — out of scope, build the tree top-down instead).
# ---------------------------------------------------------------------------


@admin.register(models.Organization)
class OrganizationAdmin(admin.ModelAdmin):
    """Enterprise tenant. The MVP runs a single bootstrapped 'default' org."""

    list_display = (
        "name",
        "slug",
        "primary_domain",
        "is_active",
        "_departments",
        "_members",
    )
    list_filter = ("is_active",)
    search_fields = ("name", "slug", "primary_domain")
    readonly_fields = ("id", "created_at", "updated_at")
    prepopulated_fields = {"slug": ("name",)}

    def get_prepopulated_fields(self, request, obj=None):
        # The slug seeds the auth backend's default-org lookup — freeze it once
        # the org exists so an edit can never orphan existing memberships.
        return {} if obj else self.prepopulated_fields

    def get_readonly_fields(self, request, obj=None):
        if obj:
            return self.readonly_fields + ("slug",)
        return self.readonly_fields

    def has_delete_permission(self, request, obj=None):
        # Single-tenant MVP: you don't delete the organization from this UI
        # (it would CASCADE every department and membership).
        return False

    @admin.display(description=_("departments"))
    def _departments(self, obj):
        return obj.departments.filter(deleted_at__isnull=True).count()

    @admin.display(description=_("members"))
    def _members(self, obj):
        return obj.memberships.count()


class DepartmentDeletedFilter(admin.SimpleListFilter):
    """Filter departments by soft-delete state (changelist shows all by default)."""

    title = _("deleted")
    parameter_name = "deleted"

    def lookups(self, request, model_admin):
        return (("0", _("Active (not deleted)")), ("1", _("Deleted")))

    def queryset(self, request, queryset):
        if self.value() == "0":
            return queryset.filter(deleted_at__isnull=True)
        if self.value() == "1":
            return queryset.filter(deleted_at__isnull=False)
        return queryset


@admin.register(models.Department)
class DepartmentAdmin(admin.ModelAdmin):
    """Department tree node.

    Create nodes under their parent to build the tree; ``team_key`` / ``path`` /
    ``depth`` are derived automatically on save. Use the *Soft-delete* action to
    remove a department — its members fall back to "no department". Hard delete
    is disabled on purpose (it would CASCADE the whole subtree).
    """

    list_display = (
        "name",
        "organization",
        "parent",
        "depth",
        "head",
        "sort_order",
        "_member_count",
        "is_active",
        "team_key",
    )
    list_filter = ("organization", "is_active", DepartmentDeletedFilter)
    search_fields = ("name", "=team_key", "=id")
    autocomplete_fields = ("organization", "parent", "head")
    readonly_fields = (
        "id",
        "team_key",
        "path",
        "depth",
        "deleted_at",
        "created_at",
        "updated_at",
    )
    ordering = ("organization", "path")
    actions = ("soft_delete_departments", "restore_departments")

    def get_readonly_fields(self, request, obj=None):
        # parent is set at creation only — changing it would require a subtree
        # path rewrite (out of scope, matching the admin API).
        if obj:
            return self.readonly_fields + ("parent",)
        return self.readonly_fields

    def get_queryset(self, request):
        return (
            super()
            .get_queryset(request)
            .select_related("organization", "parent", "head")
            .annotate(n_members=Count("memberships"))
        )

    def has_delete_permission(self, request, obj=None):
        # Enforce soft-delete via the action below — never a hard CASCADE delete.
        return False

    @admin.display(description=_("members"), ordering="n_members")
    def _member_count(self, obj):
        return obj.n_members

    @admin.action(
        description=_("Soft-delete selected departments (members → no department)")
    )
    def soft_delete_departments(self, request, queryset):
        done = 0
        for dept in queryset.filter(deleted_at__isnull=True):
            if dept.children.filter(deleted_at__isnull=True).exists():
                self.message_user(
                    request,
                    _("Skipped '%(name)s': it still has sub-departments.")
                    % {"name": dept.name},
                    level=messages.WARNING,
                )
                continue
            with transaction.atomic():
                # members fall back to organization-level (no department)
                dept.memberships.update(department=None)
                dept.is_active = False
                dept.deleted_at = timezone.now()
                dept.save()
            done += 1
        if done:
            self.message_user(
                request,
                _(
                    "%(count)s department(s) soft-deleted; their members now have no department."
                )
                % {"count": done},
                level=messages.SUCCESS,
            )

    @admin.action(description=_("Restore selected departments"))
    def restore_departments(self, request, queryset):
        restored = 0
        for dept in queryset.filter(deleted_at__isnull=False):
            dept.is_active = True
            dept.deleted_at = None
            dept.save()
            restored += 1
        self.message_user(
            request,
            _("%(count)s department(s) restored.") % {"count": restored},
            level=messages.SUCCESS if restored else messages.WARNING,
        )


@admin.register(models.Membership)
class MembershipAdmin(admin.ModelAdmin):
    """Links a user to an organization and (optionally) a department.

    Change a member's department / role / status inline from the list, or open a
    row for the full form. Removing a membership re-grants a default one on the
    user's next OIDC login (see authentication backend).
    """

    list_display = (
        "user",
        "organization",
        "department",
        "title",
        "org_role",
        "status",
        "is_primary",
        "joined_at",
    )
    list_filter = ("organization", "status", "org_role", "is_primary", "department")
    search_fields = (
        "user__email",
        "user__full_name",
        "user__sub",
        "employee_no",
        "title",
    )
    autocomplete_fields = ("user", "organization", "department")
    list_editable = ("department", "org_role", "status")
    list_select_related = ("user", "organization", "department")
    readonly_fields = ("id", "created_at", "updated_at")

    def get_changeform_initial_data(self, request):
        # Single-org MVP: prefill the only organization to cut friction.
        orgs = list(models.Organization.objects.all()[:2])
        return {"organization": orgs[0].pk} if len(orgs) == 1 else {}

    def formfield_for_foreignkey(self, db_field, request, **kwargs):
        # Don't offer soft-deleted departments when (re)assigning a member.
        if db_field.name == "department":
            kwargs["queryset"] = models.Department.objects.filter(
                deleted_at__isnull=True
            )
        return super().formfield_for_foreignkey(db_field, request, **kwargs)
