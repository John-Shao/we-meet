"""Resume bounded private derivative cleanup, even when matching is disabled."""

from django.core.management.base import BaseCommand

from core.services import recording_import_inputs as service
from core.services.capture_storage import audio_storage


class Command(BaseCommand):
    help = "Erase expired/private import input versions in bounded batches."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=20)

    def handle(self, *args, **options):
        limit = options["limit"]
        if not 1 <= limit <= 100:
            raise ValueError("Invalid cleanup batch size.")
        rows = [
            service.purge(identifier, audio_storage())
            for identifier in service.due(limit)
        ]
        self.stdout.write(
            f"completed={sum(row.status == 'deleted' for row in rows)} pending={sum(row.status != 'deleted' for row in rows)}"
        )
