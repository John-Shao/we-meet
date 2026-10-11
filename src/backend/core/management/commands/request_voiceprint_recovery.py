"""Create a fresh private request for one deployment and recovery window."""

import json

from django.core.management.base import BaseCommand, CommandError

from core.services import voiceprint_recovery as recovery


class Command(BaseCommand):
    def add_arguments(self, parser):
        parser.add_argument("--config", required=True)
        parser.add_argument("--output", required=True)

    def handle(self, *args, **options):
        try:
            config = recovery.configuration(options["config"], "reader")
            recovery.write_private(
                options["output"], recovery.request_for(config["deployment_id"])
            )
        except Exception:  # noqa: BLE001 -- Private file/key failures never enter CLI diagnostics.
            raise CommandError("voiceprint_recovery_request_unavailable") from None
        self.stdout.write(
            json.dumps(
                {"status": "created", "request_seconds": recovery.REQUEST_SECONDS}
            )
        )
