"""Console audit-log read API (M 端) — org-scoped, read-only.

Surfaces the append-only ``AuditLog`` written by the admin write paths
(``core/services/audit.py``). Org admins can filter by actor, action and a
created-at window. There is no write endpoint: audit rows are only ever created
server-side as a side effect of the actions they record.
"""

from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action as drf_action
from rest_framework.response import Response

from core import models
from core.api.admin_roles import HasOrgPermission
from core.api.directory import get_caller_organization
from core.api.serializers import UserLightSerializer
from core.api.viewsets import Pagination

#: 动作前缀 → 下拉里的分组标签。**分组从 value 的前缀推导,不是第二张清单**
#: —— 手写一张「动作→分组」的映射表就是又造一个会漂的副本,而这个端点存在的
#: 全部理由正是消灭那种副本。认不出的前缀落到 "other",宁可分组难看也不能让
#: 一个动作从下拉里消失。
ACTION_GROUPS: dict[str, str] = {
    "dept": "department",
    "member": "member",
    "dict_item": "member",
    "group": "group",
    "role": "role",
    "invite_link": "invitation",
    "join_request": "invitation",
    "room_node": "meeting_room",
    "meeting_room": "meeting_room",
    "meeting_room_facility": "meeting_room",
    "summary": "meeting",
    "bot": "bot",
}


def audit_action_catalogue() -> list[dict]:
    """``AuditActionChoices`` 作为 JSON,给控制台的筛选下拉。

    与 ``PermissionCatalogueView`` 对权限码做的是同一件事,理由也一样:前端
    原本硬编码了 10 个动作,而枚举里有 53 个 —— 43 种动作**根本筛不出来**,
    包括全部机器人动作。目录由后端吐之后,它**不可能**再跟枚举漂移。

    ``label`` 是英文枚举标签,不是最终展示文案:后端 ``.po`` 里
    ``AuditActionChoices`` **一条翻译都没有**,纯后端方案会把控制台现有的中文
    动作名换成 53 个英文串,是倒退。中文仍在前端 ``zh/admin.json``,这里的
    label 只作兜底 —— 对没有中文的语种,拿到英文也比裸 ``bot.create`` 强。
    """
    return [
        {
            "value": value,
            "label": str(label),
            "group": ACTION_GROUPS.get(value.split(".", 1)[0], "other"),
        }
        for value, label in models.AuditActionChoices.choices
    ]


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
    """List the caller organization's audit log.

    Filters: ``?action=`` / ``?actor=<user_id>`` / ``?since=`` / ``?until=``
    (ISO timestamps). Ordered newest-first by the model's default ordering.

    Gated on the code the console's navigation gates on. Was ``IsOrgAdmin``,
    which 403'd the built-in ``it`` role even though it is granted
    ``org.audit.read`` and therefore sees the menu entry. Widening only —
    owner/administrator hold ``ALL_PERMISSIONS``.
    """

    permission_classes = [HasOrgPermission]
    required_permission = "org.audit.read"
    serializer_class = AuditLogSerializer
    pagination_class = Pagination

    @drf_action(detail=False, methods=["get"], url_path="actions")
    def actions(self, request):
        """``GET /admin/audit-logs/actions/`` —— 筛选下拉的动作目录。

        挂在 list 路由下(``detail=False``):它是「这个日志里可能出现哪些动作」,
        与任何一行无关。权限沿用 viewset 的 ``org.audit.read``。
        """
        return Response({"actions": audit_action_catalogue()})

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
