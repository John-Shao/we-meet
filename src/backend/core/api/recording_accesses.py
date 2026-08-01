"""Sharing a recording — with a person, a department, or a user group (P10 M2).

This is the **write path** for ``RecordingAccess.team``. Until now the column
existed, ``BaseAccessManager.filter_user`` read it, and ``RecordingViewSet``
filtered on it — but nothing could create such a row outside the Django admin.
P1 shipped "share a recording with a department" as a half: the reading half.

Two shapes of grant, mutually exclusive per row (the model's own
``check_recording_access_either_user_or_team`` constraint):

- ``user``   — one person, by we-meet user id.
- ``team``   — an opaque subject key: ``dept:<hex>`` or ``group:<hex>``. Live
  membership decides who it reaches, so a grant to a department keeps working
  as people join and leave it. That is the point of team grants, and the reason
  they are NOT expanded into per-user rows at grant time.
"""

from django.db.models import Q
from django.utils.translation import gettext_lazy as _

from rest_framework import exceptions, mixins, serializers, viewsets

from core import models, utils
from core.api import permissions
from core.api.directory import get_caller_organization


def resolve_team_label(organization, team: str) -> str:
    """Human-readable name behind an opaque team key, '' when unresolvable.

    Unresolvable is a normal state, not an error: the department or group may
    have been soft-deleted while the grant row stayed behind. The UI shows the
    raw key in that case rather than hiding a grant that still exists.
    """
    if not team or organization is None:
        return ""
    if team.startswith(models.TEAM_PREFIX_DEPT):
        return (
            models.Department.objects.filter(
                organization=organization, team_key=team
            )
            .values_list("name", flat=True)
            .first()
            or ""
        )
    if team.startswith(models.TEAM_PREFIX_GROUP):
        return (
            models.UserGroup.objects.filter(
                organization=organization, group_key=team
            )
            .values_list("name", flat=True)
            .first()
            or ""
        )
    return ""


class RecordingAccessSerializer(serializers.ModelSerializer):
    """One grant row: exactly one of ``user`` / ``team``, plus a role."""

    user_full_name = serializers.CharField(source="user.full_name", read_only=True)
    user_email = serializers.EmailField(source="user.email", read_only=True)
    avatar_url = serializers.SerializerMethodField()
    #: Resolved name of the department / group; '' when it no longer exists.
    team_label = serializers.SerializerMethodField()
    #: ``dept`` | ``group`` | ``user`` — lets the client pick an icon without
    #: re-parsing the opaque key.
    subject_kind = serializers.SerializerMethodField()

    class Meta:
        model = models.RecordingAccess
        fields = [
            "id",
            "recording",
            "user",
            "team",
            "role",
            "user_full_name",
            "user_email",
            "avatar_url",
            "team_label",
            "subject_kind",
        ]
        read_only_fields = ["id"]

    def get_avatar_url(self, instance):
        if instance.user_id is None:
            return ""
        return utils.generate_profile_image_get_url("avatar", instance.user.avatar_key)

    def get_team_label(self, instance):
        return resolve_team_label(self.context.get("organization"), instance.team)

    def get_subject_kind(self, instance):
        if instance.user_id is not None:
            return "user"
        if instance.team.startswith(models.TEAM_PREFIX_DEPT):
            return "dept"
        if instance.team.startswith(models.TEAM_PREFIX_GROUP):
            return "group"
        return "unknown"

    def validate_team(self, value):
        """A team key must be a *live subject in the caller's organization*.

        Three separate checks, and none is redundant:

        1. **Prefix whitelist** — the column is a bare CharField, so any typo'd
           string would be accepted and then match nothing. A dead ACL row is
           worse than a rejected request: it reads as "shared" in the UI.
        2. **Org ownership** — without it, an admin of org A could paste org B's
           department key and hand B's staff a live grant.
        3. **Still alive** — a soft-deleted department/group resolves to nobody,
           so creating a grant against it is silently a no-op.
        """
        if not value:
            return value
        if not value.startswith(models.TEAM_PREFIXES):
            raise serializers.ValidationError(
                _("Unknown team key prefix. Expected 'dept:' or 'group:'.")
            )

        organization = self.context.get("organization")
        if organization is None:
            raise serializers.ValidationError(
                _("You must belong to an organization to share with a team.")
            )

        if value.startswith(models.TEAM_PREFIX_DEPT):
            exists = models.Department.objects.filter(
                organization=organization,
                team_key=value,
                is_active=True,
                deleted_at__isnull=True,
            ).exists()
        else:
            exists = models.UserGroup.objects.filter(
                organization=organization,
                group_key=value,
                is_active=True,
                deleted_at__isnull=True,
            ).exists()
        if not exists:
            raise serializers.ValidationError(
                _("No such department or group in your organization.")
            )
        return value

    def validate(self, attrs):
        """Exactly one subject, and the caller must own/administer the recording.

        The model has a CHECK constraint for the first rule, but reaching it
        surfaces as a 500-shaped IntegrityError instead of a field error — say it
        here so the client gets something actionable.
        """
        user = attrs.get("user", getattr(self.instance, "user", None))
        team = attrs.get("team", getattr(self.instance, "team", "") or "")

        if bool(user) == bool(team):
            raise serializers.ValidationError(
                _("Provide exactly one of 'user' or 'team'.")
            )

        recording = attrs.get("recording", getattr(self.instance, "recording", None))
        request = self.context.get("request")
        if recording is not None and request is not None:
            roles = models.get_resource_roles(recording, request.user)
            if not {models.RoleChoices.OWNER, models.RoleChoices.ADMIN} & set(roles):
                raise exceptions.PermissionDenied(
                    _("You must own this recording to share it.")
                )
        return attrs


class RecordingAccessViewSet(
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    mixins.ListModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """Grant / revoke access to a recording.

    ``GET ?recording=<id>`` lists a recording's grants; the queryset is limited
    to recordings the caller administers, so listing is not an information leak
    about who else a recording was shared with.
    """

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = RecordingAccessSerializer
    queryset = models.RecordingAccess.objects.all()

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["organization"] = get_caller_organization(self.request.user)
        return context

    def get_queryset(self):
        user = self.request.user
        # Only grants on recordings the caller owns or administers — via either
        # kind of grant, so a department-appointed admin can manage sharing too.
        administered = models.Recording.objects.filter(
            Q(accesses__user=user) | Q(accesses__team__in=user.get_teams()),
            accesses__role__in=[models.RoleChoices.OWNER, models.RoleChoices.ADMIN],
        )
        queryset = (
            super()
            .get_queryset()
            .filter(recording__in=administered)
            .select_related("user", "recording")
        )
        recording_id = self.request.query_params.get("recording")
        if recording_id:
            queryset = queryset.filter(recording_id=recording_id)
        return queryset

    def perform_destroy(self, instance):
        """Never leave a recording nobody can administer."""
        if instance.role == models.RoleChoices.OWNER:
            remaining = (
                models.RecordingAccess.objects.filter(
                    recording=instance.recording, role=models.RoleChoices.OWNER
                )
                .exclude(pk=instance.pk)
                .exists()
            )
            if not remaining:
                raise serializers.ValidationError(
                    {"detail": _("A recording must keep at least one owner.")}
                )
        instance.delete()
