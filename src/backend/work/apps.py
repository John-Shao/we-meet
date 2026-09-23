"""Work application configuration."""

from django.apps import AppConfig


class WorkConfig(AppConfig):
    """Register the standalone office domain."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "work"
