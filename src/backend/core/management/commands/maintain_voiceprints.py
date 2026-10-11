"""Run bounded voiceprint retention even while feature switches are off."""

import json

from django.core.management.base import BaseCommand, CommandError

from core.services.voiceprint_maintenance import tick


class Command(BaseCommand):
    help = "Clear confirmed audio, purge expired candidates and reclaim quota/origin metadata."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=20)

    def handle(self, *args, **options):
        if not 1 <= options["limit"] <= 100:
            raise CommandError("Limit must be between 1 and 100.")
        self.stdout.write(json.dumps(tick(options["limit"]), sort_keys=True))
