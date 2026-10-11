"""Verify the current independent packet before replaying an offline restore."""

import json

from django.core.management.base import BaseCommand, CommandError

from core.services import voiceprint_recovery as recovery


class Command(BaseCommand):
    def add_arguments(self, parser):
        parser.add_argument("--config", required=True)
        parser.add_argument("--request", required=True)
        parser.add_argument("--bundle", required=True)
        parser.add_argument("--receipt", required=True)

    def handle(self, *args, **options):
        try:
            config = recovery.configuration(options["config"], "reader")
            result = recovery.restore_snapshot(
                config,
                recovery.read_private(options["request"], 4096),
                recovery.read_private(options["bundle"]),
            )
            recovery.write_private(options["receipt"], result)
        except Exception:  # noqa: BLE001 -- Private SQL/configuration errors never enter CLI diagnostics.
            raise CommandError("voiceprint_recovery_restore_unavailable") from None
        self.stdout.write(json.dumps(result, sort_keys=True))
