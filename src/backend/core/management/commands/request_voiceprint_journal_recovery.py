"""Create an offline recovery request using the journal reader configuration."""

import json

from django.core.management.base import BaseCommand, CommandError

from core.services import voiceprint_journal as journal
from core.services import voiceprint_recovery as recovery


class Command(BaseCommand):
    requires_system_checks = []

    def add_arguments(self, parser):
        parser.add_argument("--config", required=True)
        parser.add_argument("--output", required=True)

    def handle(self, *args, **options):
        try:
            config = journal.load_configuration(options["config"], "reader")
            recovery.write_private(
                options["output"], recovery.request_for(config["deployment_id"])
            )
        except Exception:  # noqa: BLE001 -- No private configuration or path diagnostics.
            raise CommandError("voiceprint_journal_request_unavailable") from None
        self.stdout.write(
            json.dumps(
                {"status": "created", "request_seconds": recovery.REQUEST_SECONDS}
            )
        )
