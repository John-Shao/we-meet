"""Verify the independent latest head, replay offline and commit its primary mirror."""

import json

from django.core.management.base import BaseCommand, CommandError

from core.services import voiceprint_journal as journal
from core.services import voiceprint_journal_runtime as runtime
from core.services import voiceprint_recovery as recovery


class Command(BaseCommand):
    def add_arguments(self, parser):
        for name in ("config", "request", "bundle", "receipt"):
            parser.add_argument("--" + name, required=True)

    def handle(self, *args, **options):
        try:
            configuration = journal.load_configuration(options["config"], "reader")
            result = runtime.restore(
                configuration,
                recovery.read_private(options["request"], 4096),
                recovery.read_private(options["bundle"]),
            )
            recovery.write_private(options["receipt"], result)
        except Exception:  # noqa: BLE001 -- Private SQL/configuration errors never enter CLI diagnostics.
            raise CommandError("voiceprint_journal_restore_unavailable") from None
        self.stdout.write(json.dumps(result, sort_keys=True))
