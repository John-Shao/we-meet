"""Export frozen current recovery metadata, with an independent writer key."""

import json

from django.core.management.base import BaseCommand, CommandError

from core.services import voiceprint_recovery as recovery


class Command(BaseCommand):
    def add_arguments(self, parser):
        parser.add_argument("--config", required=True)
        parser.add_argument("--request", required=True)
        parser.add_argument("--output", required=True)

    def handle(self, *args, **options):
        try:
            config = recovery.configuration(options["config"], "writer")
            request = recovery.read_private(options["request"], 4096)
            recovery.write_private(
                options["output"], recovery.export_snapshot(config, request)
            )
        except Exception:  # noqa: BLE001 -- Private source/configuration errors never enter CLI diagnostics.
            raise CommandError("voiceprint_recovery_export_unavailable") from None
        self.stdout.write(
            json.dumps({"status": "exported", "encrypted": True, "signed": True})
        )
