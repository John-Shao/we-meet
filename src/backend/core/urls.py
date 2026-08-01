"""URL configuration for the core app."""

from django.conf import settings
from django.urls import include, path

from lasuite.oidc_login.urls import urlpatterns as oidc_urls
from rest_framework.routers import DefaultRouter, SimpleRouter

from core.addons import viewsets as addons_viewsets
from core.api import get_frontend_configuration, viewsets
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
from core.api.agent_internal import IngestTranscriptView
from core.api.recording_accesses import RecordingAccessViewSet
from core.api.approval import ApprovalInstanceViewSet, ApprovalTemplateViewSet
from core.api.calendar import CalendarEventViewSet
from core.api.admin_audit import AuditLogViewSet
from core.api.admin_invitations import OrgInvitationViewSet
from core.api.admin_stats import AdminStatsOverviewView
from core.api.directory import (
    ContactPreferenceViewSet,
    DepartmentViewSet,
    DirectoryMeView,
    DirectoryMemberViewSet,
    SpecialAlertContactViewSet,
    StarredContactViewSet,
    UserGroupDirectoryViewSet,
)
from core.api.im import ImViewSet
from core.api.meeting_rooms import (
    MeetingRoomFacilityViewSet,
    MeetingRoomNodeViewSet,
    MeetingRoomViewSet,
)
from core.api.im_later import ImLaterViewSet
from core.api.keycloak_sms import (
    KeycloakOtpSendView,
    KeycloakOtpVerifyView,
    KeycloakSmsGatewayView,
)
from core.api.mobile_auth import RefreshTokenView, SendOtpView, VerifyOtpView
from core.api.push import ImPushHookView, PushPreferenceView, PushTokenView
from core.api.search import (
    DocsMyDocumentsView,
    DocsSearchView,
    GlobalAskStreamView,
    GlobalAskView,
)
from core.api.qr_login import (
    QrAuthenticatorStatusView,
    QrCancelView,
    QrConfirmView,
    QrInitiateView,
    QrPollView,
    QrReadyView,
    QrScanView,
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
router.register("im/later", ImLaterViewSet, basename="im_later")
router.register(
    "calendar-events", CalendarEventViewSet, basename="calendar_events"
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
router.register(
    "admin/audit-logs", AuditLogViewSet, basename="admin_audit_logs"
)
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
                *router.urls,
                *oidc_urls,
                path("directory/me/", DirectoryMeView.as_view(), name="directory_me"),
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
