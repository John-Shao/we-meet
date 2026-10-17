"""Export durable counters without account identifiers or speech content."""

import json

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from core.models import BilingualSession
from core.services.bilingual_sessions import USAGE_LIMITS


class Command(BaseCommand):
    """Separate final counters, partial checkpoints and unavailable legacy usage."""

    help = "Export bilingual counters; these are not supplier billing amounts."

    def add_arguments(self, parser):
        parser.add_argument(
            "--since", required=True, help="Timezone-aware ISO timestamp"
        )

    def handle(self, *args, **options):
        since = parse_datetime(options["since"])
        if since is None or timezone.is_naive(since):
            raise CommandError("--since must be a timezone-aware ISO timestamp")
        report = {
            "since": since.isoformat(),
            "not_supplier_billable_usage": True,
            "complete": {"sessions": 0, **dict.fromkeys(USAGE_LIMITS, 0)},
            "partial": {"sessions": 0, **dict.fromkeys(USAGE_LIMITS, 0)},
            "missing_usage_sessions": 0,
            "sessions": [],
        }
        for row in BilingualSession.objects.filter(created_at__gte=since).iterator():
            if not row.usage:
                report["missing_usage_sessions"] += 1
                continue
            bucket = report["complete" if row.usage["complete"] else "partial"]
            bucket["sessions"] += 1
            for key in USAGE_LIMITS:
                bucket[key] += row.usage[key]
            report["sessions"].append(
                {
                    "session_id": str(row.pk),
                    "status": row.status,
                    "usage_updated_at": row.usage_updated_at.isoformat(),
                    **row.usage,
                }
            )
        self.stdout.write(json.dumps(report))
