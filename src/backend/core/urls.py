"""URL configuration for the core app."""

from django.conf import settings
from django.urls import include, path

from lasuite.oidc_login.urls import urlpatterns as oidc_urls
from rest_framework.routers import DefaultRouter, SimpleRouter

from core.addons import viewsets as addons_viewsets
from core.api import get_frontend_configuration, viewsets
from core.api.admin_audit import AuditLogViewSet
from core.api.admin_bots import AdminBotViewSet
from core.api.admin_import import ImportJobViewSet, MemberExportView
from core.api.admin_invitations import OrgInvitationViewSet
from core.api.admin_invite_links import InviteLinkViewSet, JoinRequestViewSet
from core.api.admin_meeting_rooms import (
    MeetingRoomAdminViewSet,
    MeetingRoomBookingAdminViewSet,
    MeetingRoomFacilityAdminViewSet,
    MeetingRoomNodeAdminViewSet,
)
from core.api.admin_org import (
    DepartmentAdminViewSet,
    MembershipAdminViewSet,
    OrgDictItemViewSet,
    UserGroupViewSet,
)
from core.api.admin_roles import (
    AdminRoleAssignmentViewSet,
    AdminRoleViewSet,
    PermissionCatalogueView,
)
from core.api.admin_stats import AdminStatsOverviewView
from core.api.agent_internal import IngestTranscriptView
from core.api.approval import ApprovalInstanceViewSet, ApprovalTemplateViewSet
from core.api.bot_webhook import BotWebhookView
from core.api.calendar import CalendarEventViewSet
from core.api.calendar_exports import CalendarExportJobViewSet
from core.api.calendars import CalendarShareView, CalendarViewSet
from core.api.directory import (
    ContactPreferenceViewSet,
    DepartmentViewSet,
    DirectoryMemberViewSet,
    DirectoryMeView,
    ExternalContactViewSet,
    SpecialAlertContactViewSet,
    StarredContactViewSet,
    UserGroupDirectoryViewSet,
)
from core.api.docs_session import DocsSessionView
from core.api.im import ImViewSet
from core.api.im_bots import ImBotViewSet
from core.api.im_cards import ImCardViewSet
from core.api.im_input import (
    AdminImEmojiViewSet,
    ImCustomEmojiViewSet,
    ImPreferenceView,
)
from core.api.im_later import ImLaterViewSet
from core.api.invite import (
    CancelJoinRequestView,
    InviteApplyView,
    InviteResolveView,
    MyJoinRequestsView,
)
from core.api.keycloak_sms import (
    KeycloakOtpSendView,
    KeycloakOtpVerifyView,
    KeycloakSmsGatewayView,
)
from core.api.meeting_rooms import (
    MeetingRoomFacilityViewSet,
    MeetingRoomNodeViewSet,
    MeetingRoomViewSet,
)
from core.api.mobile_auth import RefreshTokenView, SendOtpView, VerifyOtpView
from core.api.personal_calendars import (
    CalendarAccessGrantViewSet,
    CalendarPreferenceViewSet,
    CalendarSubscriptionViewSet,
    PersonalCalendarViewSet,
)
from core.api.push import ImPushHookView, PushPreferenceView, PushTokenView
from core.api.qr_login import (
    QrAuthenticatorStatusView,
    QrCancelView,
    QrConfirmView,
    QrInitiateView,
    QrPollView,
    QrReadyView,
    QrScanView,
)
from core.api.recording_accesses import RecordingAccessViewSet
from core.api.search import (
    DocsMyDocumentsView,
    DocsSearchView,
    GlobalAskStreamView,
    GlobalAskView,
)
from core.api.tasks import (
    TaskGroupViewSet,
    TaskLabelViewSet,
    TaskListViewSet,
    TaskViewSet,
)
from core.external_api import viewsets as external_viewsets

# - Main endpoints
router = DefaultRouter()
router.register("users", viewsets.UserViewSet, basename="users")
router.register("rooms", viewsets.RoomViewSet, basename="rooms")
router.register("recordings", viewsets.RecordingViewSet, basename="recordings")
router.register("files", viewsets.FileViewSet, basename="files")
router.register(
    "resource-accesses", viewsets.ResourceAccessViewSet, basename="resource_accesses"
)
router.register(
    "recording-accesses",
    RecordingAccessViewSet,
    basename="recording_accesses",
)
router.register(
    "addons/sessions",
    addons_viewsets.SessionViewSet,
    basename="addons_sessions",
)
router.register("im", ImViewSet, basename="im")
router.register("im/custom-emojis", ImCustomEmojiViewSet, basename="im_custom_emojis")
router.register("admin/im-emojis", AdminImEmojiViewSet, basename="admin_im_emojis")
router.register("im/later", ImLaterViewSet, basename="im_later")
# 群机器人:带 pk 的 CRUD 资源,双端都要标准 REST(见 core/api/im_bots.py)。
router.register("im/bots", ImBotViewSet, basename="im_bots")
# 卡片按钮的点击与叠加层(二期 A2)。detail 的 pk 是 jusi 的 mid。
router.register("im/cards", ImCardViewSet, basename="im_cards")
router.register(
    "calendar-events", CalendarEventViewSet, basename="calendar_events"
)
router.register("calendars", CalendarViewSet, basename="calendars")
router.register(
    "calendar-exports", CalendarExportJobViewSet, basename="calendar_exports"
)
router.register(
    "personal-calendars", PersonalCalendarViewSet, basename="personal_calendars"
)
router.register(
    "calendar-access-grants",
    CalendarAccessGrantViewSet,
    basename="calendar_access_grants",
)
router.register(
    "calendar-subscriptions",
    CalendarSubscriptionViewSet,
    basename="calendar_subscriptions",
)
router.register(
    "calendar-preferences",
    CalendarPreferenceViewSet,
    basename="calendar_preferences",
)
router.register(
    "directory/user-groups",
    UserGroupDirectoryViewSet,
    basename="directory_user_groups",
)
router.register(
    "directory/departments", DepartmentViewSet, basename="directory_departments"
)
router.register(
    "directory/members", DirectoryMemberViewSet, basename="directory_members"
)
router.register(
    "directory/external-contacts",
    ExternalContactViewSet,
    basename="directory_external_contacts",
)
router.register(
    "directory/starred", StarredContactViewSet, basename="directory_starred"
)
# 「他的消息特别提醒」名单(可渲染卡片),与 starred 并列;两者只差投影的 flag。
router.register(
    "directory/special-alert",
    SpecialAlertContactViewSet,
    basename="directory_special_alert",
)
# 逐联系人的两个独立 flag(星标 / 他的消息特别提醒):list 给端上缓存 flag 集合,
# PUT {user_id} 设置。星标联系人页的可渲染卡片走上面的 directory/starred。
router.register(
    "directory/contact-prefs",
    ContactPreferenceViewSet,
    basename="directory_contact_prefs",
)
router.register(
    "admin/departments", DepartmentAdminViewSet, basename="admin_departments"
)
router.register(
    "admin/memberships", MembershipAdminViewSet, basename="admin_memberships"
)
router.register(
    "admin/dictionaries", OrgDictItemViewSet, basename="admin_dictionaries"
)
router.register("admin/user-groups", UserGroupViewSet, basename="admin_user_groups")
router.register("admin/roles", AdminRoleViewSet, basename="admin_roles")
router.register("admin/import-jobs", ImportJobViewSet, basename="admin_import_jobs")
router.register(
    "admin/member-export", MemberExportView, basename="admin_member_export"
)
router.register(
    "admin/role-assignments",
    AdminRoleAssignmentViewSet,
    basename="admin_role_assignments",
)
router.register(
    "admin/invite-links", InviteLinkViewSet, basename="admin_invite_links"
)
router.register(
    "admin/join-requests", JoinRequestViewSet, basename="admin_join_requests"
)
router.register(
    "admin/audit-logs", AuditLogViewSet, basename="admin_audit_logs"
)
router.register("admin/bots", AdminBotViewSet, basename="admin_bots")
# P9 会议室 —— 实体会议室,与上面的 "rooms"(LiveKit 视频房间) 无关。
router.register(
    "meeting-rooms", MeetingRoomViewSet, basename="meeting_rooms"
)
router.register(
    "meeting-room-nodes", MeetingRoomNodeViewSet, basename="meeting_room_nodes"
)
router.register(
    "meeting-room-facilities",
    MeetingRoomFacilityViewSet,
    basename="meeting_room_facilities",
)
router.register(
    "admin/meeting-rooms", MeetingRoomAdminViewSet, basename="admin_meeting_rooms"
)
router.register(
    "admin/meeting-room-nodes",
    MeetingRoomNodeAdminViewSet,
    basename="admin_meeting_room_nodes",
)
router.register(
    "admin/meeting-room-facilities",
    MeetingRoomFacilityAdminViewSet,
    basename="admin_meeting_room_facilities",
)
router.register(
    "admin/meeting-room-bookings",
    MeetingRoomBookingAdminViewSet,
    basename="admin_meeting_room_bookings",
)
router.register(
    "admin/invitations", OrgInvitationViewSet, basename="admin_invitations"
)
router.register(
    "approval-templates", ApprovalTemplateViewSet, basename="approval_templates"
)
router.register("approvals", ApprovalInstanceViewSet, basename="approvals")
router.register("tasks", TaskViewSet, basename="tasks")
router.register("task-labels", TaskLabelViewSet, basename="task_labels")
router.register("task-lists", TaskListViewSet, basename="task_lists")
router.register("task-groups", TaskGroupViewSet, basename="task_groups")

# - External API
external_router = SimpleRouter()
external_router.register(
    "application",
    external_viewsets.ApplicationViewSet,
    basename="external_application",
)
external_router.register(
    "rooms",
    external_viewsets.RoomViewSet,
    basename="external_room",
)

urlpatterns = [
    path(
        f"api/{settings.API_VERSION}/",
        include(
            [
                path("im/preferences/", ImPreferenceView.as_view(), name="im_preferences"),
                path(
                    "calendar-share/<str:token>/",
                    CalendarShareView.as_view(),
                    name="calendar_share",
                ),
                *router.urls,
                *oidc_urls,
                path("directory/me/", DirectoryMeView.as_view(), name="directory_me"),
                path(
                    "admin/permissions/",
                    PermissionCatalogueView.as_view(),
                    name="admin_permission_catalogue",
                ),
                # P10 M4 邀请链接。解析端点匿名可达(落地页要能在没登录时
                # 显示是谁在邀请你),其余需登录。
                path(
                    "invite/<str:code>/",
                    InviteResolveView.as_view(),
                    name="invite_resolve",
                ),
                path(
                    "invite/<str:code>/apply/",
                    InviteApplyView.as_view(),
                    name="invite_apply",
                ),
                path(
                    "join-requests/mine/",
                    MyJoinRequestsView.as_view(),
                    name="join_requests_mine",
                ),
                path(
                    "join-requests/<uuid:pk>/cancel/",
                    CancelJoinRequestView.as_view(),
                    name="join_requests_cancel",
                ),
                # P0 离线推送:App 端注册/注销个推 cid。
                path("push/tokens/", PushTokenView.as_view(), name="push_tokens"),
                # P0-M3 免打扰时段偏好。
                path(
                    "push/preferences/",
                    PushPreferenceView.as_view(),
                    name="push_preferences",
                ),
                path(
                    "admin/stats/overview/",
                    AdminStatsOverviewView.as_view(),
                    name="admin_stats_overview",
                ),
                path("config/", get_frontend_configuration, name="config"),
                # P1-4 全局搜索 AI 问答。
                path("search/ask/", GlobalAskView.as_view(), name="search_ask"),
                path(
                    "search/ask-stream/",
                    GlobalAskStreamView.as_view(),
                    name="search_ask_stream",
                ),
                # P1-4 搜索入口统一:Docs 文档搜索代理(s2s,按调用者可见范围)。
                path(
                    "docs/search/",
                    DocsSearchView.as_view(),
                    name="docs_search",
                ),
                # 分享云文档到聊天(入口 A):选择器"我的文档"列表代理(s2s)。
                path(
                    "docs/my-documents/",
                    DocsMyDocumentsView.as_view(),
                    name="docs_my_documents",
                ),
                # 内嵌云文档的登录态引导:换一条带登录态的 Docs 进站 URL
                # (不依赖浏览器里的 Keycloak 会话,见 core/api/docs_session.py)。
                path(
                    "docs/session/",
                    DocsSessionView.as_view(),
                    name="docs_session",
                ),
            ]
        ),
    ),
    # Mobile app SMS OTP authentication — native app login (unversioned).
    path("api/mobile/auth/send-otp/", SendOtpView.as_view(), name="mobile-send-otp"),
    path(
        "api/mobile/auth/verify-otp/",
        VerifyOtpView.as_view(),
        name="mobile-verify-otp",
    ),
    path(
        "api/mobile/auth/refresh/",
        RefreshTokenView.as_view(),
        name="mobile-refresh-token",
    ),
    # SMS gateway for the Keycloak phone-auth plugin (浏览器手机验证码登录). Keycloak
    # generates the OTP and POSTs it here; we relay it via the Volcengine template.
    path(
        "keycloak-sms/send/",
        KeycloakSmsGatewayView.as_view(),
        name="keycloak-sms-send",
    ),
    # 双栏登录页手机侧：AJAX 发码（跨域 ACAO:*）+ KC 认证器校验（shared-bearer）。
    path(
        "api/keycloak-sms/otp/send/",
        KeycloakOtpSendView.as_view(),
        name="keycloak-otp-send",
    ),
    path(
        "api/keycloak-sms/otp/verify/",
        KeycloakOtpVerifyView.as_view(),
        name="keycloak-otp-verify",
    ),
    # QR-code login: web shows the QR, App scans + confirms, web polls.
    path("api/qr-login/initiate/", QrInitiateView.as_view(), name="qr-login-initiate"),
    path("api/qr-login/poll/", QrPollView.as_view(), name="qr-login-poll"),
    path("api/qr-login/scan/", QrScanView.as_view(), name="qr-login-scan"),
    path("api/qr-login/confirm/", QrConfirmView.as_view(), name="qr-login-confirm"),
    path("api/qr-login/cancel/", QrCancelView.as_view(), name="qr-login-cancel"),
    # Keycloak 扫码认证器专用：查状态 + 已确认用户身份（shared-bearer, 不发 token）。
    path(
        "api/qr-login/authenticator-status/",
        QrAuthenticatorStatusView.as_view(),
        name="qr-login-authenticator-status",
    ),
    # 极简 status 信号，供 KC 双栏登录页扫码列 AJAX 轮询（跨域 ACAO:*，仅 status）。
    path("api/qr-login/ready/", QrReadyView.as_view(), name="qr-login-ready"),
    # Internal API for agent workers (multi_user_transcriber, etc.).
    # Authenticates via X-Agent-Token shared secret; NOT a public surface.
    path(
        "api/agent/transcripts/",
        IngestTranscriptView.as_view(),
        name="agent-ingest-transcript",
    ),
    # jusi-light-im p14 离线推送 webhook(HMAC 内部鉴权;NOT a public surface)。
    path(
        "api/agent/push-hook/",
        ImPushHookView.as_view(),
        name="agent-push-hook",
    ),
    # 群机器人 webhook(公网可达,path 里的 token 即凭据;对标飞书自定义机器人)。
    #
    # 刻意不进 api/v1.0/ 版本命名空间:这个地址会被贴进第三方的 CI 配置,不该
    # 随 API_VERSION 漂移。无尾斜杠与带尾斜杠都注册 —— APPEND_SLASH 对 POST
    # 是 301,会让发送方丢掉 body。
    path(
        "api/bot/v1/hook/<str:token>",
        BotWebhookView.as_view(),
        name="bot-webhook",
    ),
    path(
        "api/bot/v1/hook/<str:token>/",
        BotWebhookView.as_view(),
        name="bot-webhook-slash",
    ),
]

if settings.EXTERNAL_API_ENABLED:
    urlpatterns.append(
        path(
            f"external-api/{settings.EXTERNAL_API_VERSION}/",
            include(
                [
                    *external_router.urls,
                ]
            ),
        )
    )
