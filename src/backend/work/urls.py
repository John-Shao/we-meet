"""Routes under the existing versioned API prefix."""

from django.urls import path

from .api import CapabilitiesView, MaterialViewSet

urlpatterns = [
    path("capabilities/", CapabilitiesView.as_view()),
    path("materials/", MaterialViewSet.as_view({"get": "list", "post": "create"})),
    path(
        "materials/<uuid:pk>/",
        MaterialViewSet.as_view({"get": "retrieve", "delete": "destroy"}),
    ),
    path("materials/<uuid:pk>/preview/", MaterialViewSet.as_view({"get": "preview"})),
    path("materials/<uuid:pk>/retry/", MaterialViewSet.as_view({"post": "retry"})),
]
