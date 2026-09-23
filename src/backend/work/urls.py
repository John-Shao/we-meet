"""Routes under the existing versioned API prefix."""

from django.urls import path

from .api import CapabilitiesView, MaterialViewSet
from .task_api import RunViewSet, TaskViewSet

urlpatterns = [
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
    path("capabilities/", CapabilitiesView.as_view()),
    path("materials/", MaterialViewSet.as_view({"get": "list", "post": "create"})),
    path(
        "materials/<uuid:pk>/",
        MaterialViewSet.as_view({"get": "retrieve", "delete": "destroy"}),
    ),
    path("materials/<uuid:pk>/preview/", MaterialViewSet.as_view({"get": "preview"})),
    path("materials/<uuid:pk>/retry/", MaterialViewSet.as_view({"post": "retry"})),
]
