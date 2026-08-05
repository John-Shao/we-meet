"""M 端群机器人治理 —— ``/api/v1.0/admin/bots/``(二期线 B)。

运营端看全组织有哪些机器人、装在哪个群、谁建的、发了多少条,能停用,能读凭据。

## 刻意没有的东西

**没有 create,也没有 destroy。** 装机器人是群主在 C 端做的事;删除要调 jusi
的 remove_members 并在群里留一条系统消息,那是 C 端那条路径的责任。M 端从这里
删一行,群里会留下一个还在说话、但治理页上已经不存在的机器人。

**没有密钥轮换。** 轮换是**无声的破坏**:对方的 CI 从此收到 400,而群里什么
都不显示 —— 没有人知道发生了什么,包括被影响的那个团队。M 端的正确手段是
**停用**:可见、有 ``disabled_reason``、可逆。C 端群主本来就有轮换。

## 组织门有两条腿

* 自定义机器人认 ``bot.organization``
* 内置助手的 ``organization`` **是 NULL**,只能靠会话投影认归属

没有投影就看不见 —— **fail closed**。宁可少显示一个,不能把别的组织的机器人
显示给你。(``filter(bot__organization=org)`` 会静默漏掉全部内置助手,那正是
这条要绕开的坑。)
"""

from __future__ import annotations

from django.db.models import F, Q

from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from core import models
from core.api.admin_org import OrgWideOnlyMixin
from core.api.admin_roles import HasOrgPermission
from core.api.directory import get_caller_organization
from core.api.im_bots import webhook_url_for
from core.api.throttling import AdminBotCredentialThrottle
from core.api.viewsets import Pagination
from core.services.audit import record_audit


class AdminBotSerializer(serializers.ModelSerializer):
    """一个机器人安装,治理视角。

    **永远不含** ``webhook_url`` / ``signing_secret`` / ``callback_secret`` /
    ``keywords`` / ``ip_allowlist`` 的原值。一页 100 行就是 100 张活凭证进了
    浏览器内存和 HTTP 缓存 —— 凭据只从 :meth:`AdminBotViewSet.credential`
    一行一行地取,而且每次留一条审计。
    """

    name = serializers.CharField(source="bot.name", read_only=True)
    kind = serializers.CharField(source="bot.kind", read_only=True)
    slug = serializers.CharField(source="bot.slug", read_only=True)
    avatar_color_index = serializers.IntegerField(
        source="bot.avatar_color_index", read_only=True
    )
    conversation_name = serializers.SerializerMethodField()
    created_by_name = serializers.SerializerMethodField()
    has_callback = serializers.SerializerMethodField()

    class Meta:
        model = models.ImBotInstallation
        fields = [
            "id",
            "cid",
            "conversation_name",
            "name",
            "kind",
            "slug",
            "avatar_color_index",
            "is_active",
            "disabled_reason",
            "message_count",
            "last_used_at",
            "created_at",
            "created_by_name",
            "has_callback",
        ]
        read_only_fields = fields

    def get_conversation_name(self, instance) -> str:
        """会议群读 ``room.name``(房间改名立刻跟着改),其余读投影。

        两者都可能为空 —— jusi 没有 admin 读接口,投影是在本表建立之后才开始
        攒的。前端对空名显示「未命名群聊」+ 可复制的 cid 前 12 位。
        """
        meeting = self.context.get("meeting_names", {}).get(instance.cid)
        if meeting:
            return meeting
        return self.context.get("conversation_names", {}).get(instance.cid, "")

    def get_created_by_name(self, instance) -> str:
        user = instance.created_by
        if user is None:
            return ""
        return user.full_name or user.short_name or user.email or ""

    def get_has_callback(self, instance) -> bool:
        """只说**有没有**配回调,不给地址 —— 地址是群主填的运维细节。"""
        return bool(instance.callback_url)


class AdminBotViewSet(
    OrgWideOnlyMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    viewsets.GenericViewSet,
):
    """``/admin/bots/`` —— 列表、详情、停用/启用、读凭据。"""

    permission_classes = [HasOrgPermission]
    serializer_class = AdminBotSerializer
    pagination_class = Pagination

    def get_permissions(self):
        if self.action in ("disable", "enable"):
            # 停用会让**别人的** CI 告警断掉。并进 read 等于「让 IT 看看有哪些
            # 机器人」顺带给了「让 IT 弄坏财务的告警」。
            self.required_permission = "org.bot.write"
        elif self.action == "credential":
            self.required_permission = "org.bot.secret.read"
        else:
            self.required_permission = "org.bot.read"
        return super().get_permissions()

    def get_throttles(self):
        if self.action == "credential":
            return [AdminBotCredentialThrottle()]
        return super().get_throttles()

    # ---- 查询 ----

    def _organization(self):
        return get_caller_organization(self.request.user)

    def get_queryset(self):
        organization = self._organization()
        if organization is None:
            return models.ImBotInstallation.objects.none()

        # 组织门的两条腿。内置助手的 bot.organization 是 NULL,只能靠会话投影
        # 认 —— 没投影就看不见,fail closed。
        own_cids = models.ImConversation.objects.filter(
            organization=organization
        ).values_list("cid", flat=True)
        queryset = (
            models.ImBotInstallation.objects.filter(
                Q(bot__organization=organization) | Q(cid__in=own_cids)
            )
            .select_related("bot", "created_by")
            .order_by(F("last_used_at").desc(nulls_last=True), "-created_at")
        )

        # **筛选只加在 list 上。** 留给 detail 路由会让「已停用」变 404、于是
        # enable 永远调不到 —— 与 admin_invite_links 里那条注释同一个坑。
        if self.action != "list":
            return queryset

        # 默认只列自定义机器人:内置助手是(助手 × 会话)的笛卡尔积,几千行会把
        # 真正要治理的几十个自定义 bot 冲没。要看得 ?kind= 显式要。
        kind = (self.request.query_params.get("kind") or "").strip()
        if kind:
            queryset = queryset.filter(bot__kind=kind)
        else:
            queryset = queryset.filter(bot__kind=models.ImBotKindChoices.CUSTOM)

        active = (self.request.query_params.get("active") or "").strip()
        if active == "1":
            queryset = queryset.filter(is_active=True)
        elif active == "0":
            queryset = queryset.filter(is_active=False)

        search = (self.request.query_params.get("q") or "").strip()
        if search:
            queryset = queryset.filter(
                Q(bot__name__icontains=search) | Q(cid__icontains=search)
            )
        return queryset

    def get_serializer_context(self):
        """一次查两张表补齐群名,不做 N+1。"""
        context = super().get_serializer_context()
        page = getattr(self, "_page_cids", None)
        if page is None:
            return context
        context["conversation_names"] = dict(
            models.ImConversation.objects.filter(cid__in=page).values_list(
                "cid", "name"
            )
        )
        context["meeting_names"] = {
            cid: name
            for cid, name in models.MeetingConversation.objects.filter(
                cid__in=page
            ).values_list("cid", "room__name")
            if name
        }
        return context

    def _with_names(self, instances):
        self._page_cids = [i.cid for i in instances]
        return instances

    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        if page is not None:
            serializer = self.get_serializer(self._with_names(page), many=True)
            return self.get_paginated_response(serializer.data)
        rows = list(queryset)
        return Response(self.get_serializer(self._with_names(rows), many=True).data)

    def retrieve(self, request, *args, **kwargs):
        instance = self.get_object()
        self._with_names([instance])
        return Response(self.get_serializer(instance).data)

    # ---- 动作 ----

    def _audit(self, install, action_choice, **metadata):
        record_audit(
            actor=self.request.user,
            organization=self._organization(),
            action=action_choice,
            target_type="im_bot",
            target_id=install.pk,
            target_label=install.bot.name,
            metadata={"surface": "admin", "cid": install.cid, **metadata},
        )

    @action(detail=True, methods=["post"])
    def disable(self, request, pk=None):
        """在这个群里停用这个机器人。

        **只动 ``ImBotInstallation.is_active``,永不动 ``ImBot.is_active``。**
        内置助手的 ``organization`` 是 NULL —— 停用那个身份是**全局**停用,
        会打到别的组织。
        """
        install = self.get_object()
        reason = str((request.data or {}).get("reason") or "").strip()[:64]
        models.ImBotInstallation.objects.filter(pk=install.pk).update(
            is_active=False, disabled_reason=reason or "disabled_by_admin"
        )
        # 不复用 bot.update:「谁停了生产机器人」是这块唯一真正要能被筛出来的
        # 事件,混进 bot.update(C 端改个名也是它)等于没做。
        self._audit(install, models.AuditActionChoices.BOT_DISABLE, reason=reason)
        install.refresh_from_db()
        self._with_names([install])
        return Response(self.get_serializer(install).data)

    @action(detail=True, methods=["post"])
    def enable(self, request, pk=None):
        install = self.get_object()
        models.ImBotInstallation.objects.filter(pk=install.pk).update(
            is_active=True, disabled_reason=""
        )
        self._audit(install, models.AuditActionChoices.BOT_ENABLE)
        install.refresh_from_db()
        self._with_names([install])
        return Response(self.get_serializer(install).data)

    @action(detail=True, methods=["get"])
    def credential(self, request, pk=None):
        """读这个机器人的 webhook 地址与签名密钥。

        **刻意不放进 list**:一页 100 行就是 100 张活凭证进了浏览器内存和 HTTP
        缓存。限流(30/hour)不是防管理员 —— 是让「把全组织凭据撸一遍」这件事
        变慢、变可见。

        每次读写一条审计,``surface=admin`` 与 C 端群主自己读区分开。
        """
        install = self.get_object()
        self._audit(install, models.AuditActionChoices.BOT_WEBHOOK_VIEW)
        return Response(
            {
                "webhook_url": webhook_url_for(install),
                "signing_secret": install.signing_secret or "",
                "sign_verify_enabled": install.sign_verify_enabled,
            }
        )
