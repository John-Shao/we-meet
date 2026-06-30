"""URL configuration for the core app."""

from django.conf import settings
from django.urls import include, path

from lasuite.oidc_login.urls import urlpatterns as oidc_urls
from rest_framework.routers import DefaultRouter, SimpleRouter

from core.addons import viewsets as addons_viewsets
from core.api import get_frontend_configuration, viewsets
from core.api.admin_org import DepartmentAdminViewSet, MembershipAdminViewSet
from core.api.agent_internal import IngestTranscriptView
from core.api.approval import ApprovalInstanceViewSet, ApprovalTemplateViewSet
from core.api.calendar import CalendarEventViewSet
from core.api.directory import DepartmentViewSet, DirectoryMemberViewSet
from core.api.im import ImViewSet
from core.api.mobile_auth import RefreshTokenView, SendOtpView, VerifyOtpView
from core.api.qr_login import (
    QrCancelView,
    QrConfirmView,
    QrInitiateView,
    QrPollView,
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
    "addons/sessions",
    addons_viewsets.SessionViewSet,
    basename="addons_sessions",
)
router.register("im", ImViewSet, basename="im")
router.register(
    "calendar-events", CalendarEventViewSet, basename="calendar_events"
)
router.register(
    "directory/departments", DepartmentViewSet, basename="directory_departments"
)
router.register(
    "directory/members", DirectoryMemberViewSet, basename="directory_members"
)
router.register(
    "admin/departments", DepartmentAdminViewSet, basename="admin_departments"
)
router.register(
    "admin/memberships", MembershipAdminViewSet, basename="admin_memberships"
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
                path("config/", get_frontend_configuration, name="config"),
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
    # QR-code login: web shows the QR, App scans + confirms, web polls.
    path("api/qr-login/initiate/", QrInitiateView.as_view(), name="qr-login-initiate"),
    path("api/qr-login/poll/", QrPollView.as_view(), name="qr-login-poll"),
    path("api/qr-login/scan/", QrScanView.as_view(), name="qr-login-scan"),
    path("api/qr-login/confirm/", QrConfirmView.as_view(), name="qr-login-confirm"),
    path("api/qr-login/cancel/", QrCancelView.as_view(), name="qr-login-cancel"),
    # Internal API for agent workers (multi_user_transcriber, etc.).
    # Authenticates via X-Agent-Token shared secret; NOT a public surface.
    path(
        "api/agent/transcripts/",
        IngestTranscriptView.as_view(),
        name="agent-ingest-transcript",
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
