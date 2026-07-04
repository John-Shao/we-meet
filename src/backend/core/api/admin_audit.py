"""Console audit-log read API (M 端) — org-scoped, read-only.

Surfaces the append-only ``AuditLog`` written by the admin write paths
(``core/services/audit.py``). Org admins can filter by actor, action and a
created-at window. There is no write endpoint: audit rows are only ever created
server-side as a side effect of the actions they record.
"""

from rest_framework import mixins, serializers, viewsets

from core import models
from core.api.admin_org import IsOrgAdmin
from core.api.directory import get_caller_organization
from core.api.serializers import UserLightSerializer
from core.api.viewsets import Pagination


class AuditLogSerializer(serializers.ModelSerializer):
    """One audit row for the console log view (actor as a light user card)."""

    actor = UserLightSerializer(read_only=True)

    class Meta:
        model = models.AuditLog
        fields = [
            "id",
            "actor",
            "action",
            "target_type",
            "target_id",
            "target_label",
            "metadata",
            "created_at",
        ]
        read_only_fields = fields


class AuditLogViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """List the caller organization's audit log (org admins only).

    Filters: ``?action=`` / ``?actor=<user_id>`` / ``?since=`` / ``?until=``
    (ISO timestamps). Ordered newest-first by the model's default ordering.
    """

    permission_classes = [IsOrgAdmin]
    serializer_class = AuditLogSerializer
    pagination_class = Pagination

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.AuditLog.objects.none()
        queryset = models.AuditLog.objects.filter(
            organization=organization
        ).select_related("actor")

        action = self.request.query_params.get("action")
        if action:
            queryset = queryset.filter(action=action)
        actor = self.request.query_params.get("actor")
        if actor:
            queryset = queryset.filter(actor_id=actor)
        since = self.request.query_params.get("since")
        if since:
            queryset = queryset.filter(created_at__gte=since)
        until = self.request.query_params.get("until")
        if until:
            queryset = queryset.filter(created_at__lte=until)
        return queryset
