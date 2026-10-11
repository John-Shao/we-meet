"""Publish one frozen offline baseline and bind the primary checkpoint."""

import json

from django.core.management.base import BaseCommand, CommandError

from core.services import voiceprint_journal_runtime as runtime


class Command(BaseCommand):
    def add_arguments(self, parser):
        parser.add_argument("--config", required=True)

    def handle(self, *args, **options):
        try:
            result = runtime.initialize(options["config"])
        except Exception:  # noqa: BLE001 -- Fixed errors; no private SQL or configuration diagnostics.
            raise CommandError(
                "voiceprint_journal_initialization_unavailable"
            ) from None
        self.stdout.write(json.dumps(result, sort_keys=True))
