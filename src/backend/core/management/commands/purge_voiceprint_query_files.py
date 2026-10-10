"""Recover expired private query files left by abruptly terminated workers."""

import json

from django.core.management.base import BaseCommand, CommandError

from core.services.voiceprint_media_process import MediaError
from core.services.voiceprint_query_files import purge


class Command(BaseCommand):
    help = "Remove expired private voiceprint query directories with a bounded scan."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=100)

    def handle(self, *args, **options):
        try:
            result = purge(limit=options["limit"])
        except (MediaError, OSError):
            raise CommandError("voiceprint_query_cleanup_unavailable") from None
        self.stdout.write(json.dumps(result, sort_keys=True))
