"""Core application initialization."""

from django.apps import AppConfig


class CoreConfig(AppConfig):
    """Register optional meeting-record projections after model loading."""

    name = "core"

    def ready(self):
        """Connect material-save projection handlers once per process."""
        # Models may only be imported after Django populates the app registry.
        from core.services.meeting_record_projection import (  # noqa: PLC0415
            connect_handlers,
        )

        connect_handlers()
