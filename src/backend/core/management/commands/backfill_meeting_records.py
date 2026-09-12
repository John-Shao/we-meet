"""Project resolved meeting materials; report unresolved rows without guessing."""

import json

from django.core.management.base import BaseCommand, CommandError
from django.db.models import F

from core import models
from core.services.meeting_records import (
    RecordConflict,
    ensure_online_record,
    sessions_with_materials,
)


class Command(BaseCommand):
    """Dry-run by default; explicit --apply creates idempotent record rows."""

    help = "Inspect meeting-record backfill; --apply writes only new record identities."

    def add_arguments(self, parser):
        """Require an explicit switch for writes."""
        parser.add_argument("--apply", action="store_true")

    def handle(self, *args, **options):
        """Keep old artifacts intact, including their unresolved session fields."""
        candidates = sessions_with_materials().order_by("id")
        report = {
            "apply": options["apply"],
            "eligible_sessions": candidates.count(),
            "existing_records": candidates.filter(record__isnull=False).count(),
            "created": 0,
            "conflicts": 0,
            "unresolved": {
                model.__name__: model.objects.filter(session__isnull=True).count()
                for model in [models.Transcript, models.Recording, models.Summary]
            },
            "mismatched_room": {
                model.__name__: model.objects.filter(session__isnull=False)
                .exclude(room_id=F("session__room_id"))
                .count()
                for model in [models.Transcript, models.Recording, models.Summary]
            },
        }
        if options["apply"]:
            for session in candidates.iterator(chunk_size=200):
                try:
                    _, created = ensure_online_record(session)
                    report["created"] += int(created)
                except RecordConflict:
                    report["conflicts"] += 1
        self.stdout.write(json.dumps(report, sort_keys=True))
        if report["conflicts"]:
            raise CommandError(
                "Record provenance conflicts require review; see the report."
            )
