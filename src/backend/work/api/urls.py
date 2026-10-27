"""R0a Work API routes (D2: 29 paths / 33 operations)."""

from django.urls import path

from work.api.views.admin import (
    AdminOverviewView,
    AuditExportContentView,
    AuditExportCreateView,
    AuditExportDetailView,
    AuditExportTicketView,
    SeatListView,
)
from work.api.views.artifact import (
    AcceptanceView,
    ArtifactContentView,
    ArtifactVersionCreateView,
    ArtifactVersionDetailView,
)
from work.api.views.config import (
    ProviderConfigRevokeView,
    ProviderConfigView,
    ProviderCredentialCreateView,
    ProviderCredentialRevokeView,
    ProviderCredentialRotateView,
)
from work.api.views.run import (
    CancelRunView,
    OperationListView,
    RunDetailView,
    StreamTaskEventsView,
)
from work.api.views.task import (
    BootstrapView,
    InboxView,
    InputCreateView,
    TaskCollectionView,
    TaskItemView,
    TaskPreviewView,
    TaskRetryView,
    TemplateListView,
)
from work.api.views.usage import OrgUsageView, UserUsageView

urlpatterns = [
    path("bootstrap", BootstrapView.as_view(), name="work-bootstrap"),
    path("inputs", InputCreateView.as_view(), name="work-input-create"),
    path("templates", TemplateListView.as_view(), name="work-templates"),
    path("task-previews", TaskPreviewView.as_view(), name="work-task-preview"),
    path("tasks", TaskCollectionView.as_view(), name="work-task-collection"),
    path("tasks/<uuid:task_id>", TaskItemView.as_view(), name="work-task-item"),
    path(
        "tasks/<uuid:task_id>/runs",
        TaskRetryView.as_view(),
        name="work-task-retry",
    ),
    path(
        "tasks/<uuid:task_id>/events",
        StreamTaskEventsView.as_view(),
        name="work-task-events",
    ),
    path(
        "tasks/<uuid:task_id>/acceptances",
        AcceptanceView.as_view(),
        name="work-task-acceptance",
    ),
    path("runs/<uuid:run_id>", RunDetailView.as_view(), name="work-run-detail"),
    path(
        "runs/<uuid:run_id>/operations",
        OperationListView.as_view(),
        name="work-run-operations",
    ),
    path(
        "runs/<uuid:run_id>/cancel",
        CancelRunView.as_view(),
        name="work-run-cancel",
    ),
    path("inbox", InboxView.as_view(), name="work-inbox"),
    path(
        "artifacts/<uuid:artifact_id>/versions",
        ArtifactVersionCreateView.as_view(),
        name="work-artifact-version-create",
    ),
    path(
        "artifacts/<uuid:artifact_id>/versions/<int:version_no>",
        ArtifactVersionDetailView.as_view(),
        name="work-artifact-version-detail",
    ),
    path(
        "artifacts/<uuid:artifact_id>/versions/<int:version_no>/content",
        ArtifactContentView.as_view(),
        name="work-artifact-content",
    ),
    path("me/usage", UserUsageView.as_view(), name="work-user-usage"),
    path("admin/usage", OrgUsageView.as_view(), name="work-admin-usage"),
    path(
        "admin/provider-config",
        ProviderConfigView.as_view(),
        name="work-provider-config",
    ),
    path(
        "admin/provider-config/revoke",
        ProviderConfigRevokeView.as_view(),
        name="work-provider-config-revoke",
    ),
    path(
        "admin/provider-credentials",
        ProviderCredentialCreateView.as_view(),
        name="work-provider-credential-create",
    ),
    path(
        "admin/provider-credentials/<uuid:credential_id>/rotate",
        ProviderCredentialRotateView.as_view(),
        name="work-provider-credential-rotate",
    ),
    path(
        "admin/provider-credentials/<uuid:credential_id>/revoke",
        ProviderCredentialRevokeView.as_view(),
        name="work-provider-credential-revoke",
    ),
    path("admin/overview", AdminOverviewView.as_view(), name="work-admin-overview"),
    path("admin/seats", SeatListView.as_view(), name="work-admin-seats"),
    path(
        "admin/audit-exports",
        AuditExportCreateView.as_view(),
        name="work-audit-export-create",
    ),
    path(
        "admin/audit-exports/<uuid:export_id>",
        AuditExportDetailView.as_view(),
        name="work-audit-export-detail",
    ),
    path(
        "admin/audit-exports/<uuid:export_id>/download-ticket",
        AuditExportTicketView.as_view(),
        name="work-audit-export-ticket",
    ),
    path(
        "admin/audit-exports/<uuid:export_id>/content",
        AuditExportContentView.as_view(),
        name="work-audit-export-content",
    ),
]
