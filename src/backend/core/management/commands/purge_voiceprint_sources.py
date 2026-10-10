"""Recover bounded physical source cleanup and device template rebuilds."""

import json

from django.core.management.base import BaseCommand, CommandError

from core.services.voiceprint_source_removal import tick


class Command(BaseCommand):
    help = "Purge removed voiceprint sources and rebuild surviving confirmed contributions."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=20)

    def handle(self, *args, **options):
        if not 1 <= options["limit"] <= 100:
            raise CommandError("Limit must be between 1 and 100.")
        self.stdout.write(json.dumps(tick(options["limit"]), sort_keys=True))
