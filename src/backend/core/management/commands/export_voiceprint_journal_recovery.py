"""Issue a request-bound recovery bundle from the independent authority."""

import json

from django.core.management.base import BaseCommand, CommandError

from core.services import voiceprint_journal as journal
from core.services import voiceprint_recovery as recovery


class Command(BaseCommand):
    # The primary database can be completely unavailable during this export.
    requires_system_checks = []

    def add_arguments(self, parser):
        parser.add_argument("--config", required=True)
        parser.add_argument("--request", required=True)
        parser.add_argument("--output", required=True)

    def handle(self, *args, **options):
        try:
            configuration = journal.load_configuration(options["config"], "writer")
            exported = journal.Journal(configuration).export_recovery(
                recovery.read_private(options["request"], 4096)
            )
            recovery.write_private(options["output"], exported)
        except Exception:  # noqa: BLE001 -- Private SQL, paths and key errors never enter diagnostics.
            raise CommandError("voiceprint_journal_export_unavailable") from None
        self.stdout.write(
            json.dumps(
                {
                    "status": "exported",
                    "encrypted": True,
                    "signed": True,
                    "authority_bound": True,
                }
            )
        )
