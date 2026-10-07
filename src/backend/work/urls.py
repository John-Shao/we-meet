"""Routes under the existing versioned API prefix."""

from django.urls import path

from .api import CapabilitiesView, MaterialViewSet
from .local_api import DeviceView, LocalAdmissionView, LocalRunView
from .remote_api import InboxView, RemoteTaskView, WorkspaceView
from .review_api import ReviewView
from .task_api import RunViewSet, TaskViewSet

urlpatterns = [
    path(
        "runs/<uuid:pk>/reviews/",
        ReviewView.as_view({"get": "reviews", "post": "reviews"}),
    ),
    path(
        "runs/<uuid:pk>/reviews/<uuid:review_id>/cancel/",
        ReviewView.as_view({"post": "cancel_review"}),
    ),
    path("local/workspaces/", WorkspaceView.as_view()),
    path("local/remote-tasks/", RemoteTaskView.as_view()),
    path("local/inbox/", InboxView.as_view()),
    path("local/devices/", DeviceView.as_view()),
    path("local/tasks/", LocalAdmissionView.as_view()),
    path("local/runs/<uuid:pk>/claim/", LocalRunView.as_view(operation="claim")),
    path("local/runs/<uuid:pk>/report/", LocalRunView.as_view(operation="report")),
    path("local/runs/<uuid:pk>/sync/", LocalRunView.as_view(operation="sync")),
    path("tasks/", TaskViewSet.as_view({"get": "list", "post": "create"})),
    path("tasks/<uuid:pk>/", TaskViewSet.as_view({"get": "retrieve"})),
    path("tasks/<uuid:pk>/retry/", TaskViewSet.as_view({"post": "retry"})),
    path("runs/<uuid:pk>/events/", RunViewSet.as_view({"get": "events"})),
    path("runs/<uuid:pk>/cancel/", RunViewSet.as_view({"post": "cancel"})),
    path(
        "runs/<uuid:pk>/artifact/",
        RunViewSet.as_view({"get": "artifact", "post": "artifact"}),
    ),
    path("runs/<uuid:pk>/adopt/", RunViewSet.as_view({"post": "adopt"})),
    path("runs/<uuid:pk>/download/", RunViewSet.as_view({"get": "download"})),
    path("runs/<uuid:pk>/files/", RunViewSet.as_view({"get": "files"})),
    path("runs/<uuid:pk>/file-download/", RunViewSet.as_view({"get": "file_download"})),
    path("capabilities/", CapabilitiesView.as_view()),
    path("materials/", MaterialViewSet.as_view({"get": "list", "post": "create"})),
    path(
        "materials/<uuid:pk>/",
        MaterialViewSet.as_view({"get": "retrieve", "delete": "destroy"}),
    ),
    path("materials/<uuid:pk>/preview/", MaterialViewSet.as_view({"get": "preview"})),
    path("materials/<uuid:pk>/retry/", MaterialViewSet.as_view({"post": "retry"})),
]
