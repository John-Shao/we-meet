"""Work application configuration."""

from django.apps import AppConfig
from django.db.models.signals import post_delete


class WorkConfig(AppConfig):
    """Register the standalone office domain."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "work"

    def ready(self):
        # Imported here: both modules touch models, which are not ready earlier.
        from core.models import Membership  # noqa: PLC0415
        from work import lifecycle  # noqa: PLC0415

        lifecycle.connect()
        post_delete.connect(
            lifecycle.on_membership_deleted,
            sender=Membership,
            dispatch_uid="work.lifecycle.on_membership_deleted",
            weak=False,
        )
