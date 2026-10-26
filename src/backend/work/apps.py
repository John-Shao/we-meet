"""Clean-slate Work R0a app (not registered until D-04)."""

from django.apps import AppConfig


class WorkConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "work"
