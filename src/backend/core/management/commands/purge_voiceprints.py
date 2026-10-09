"""Bounded physical cleanup for already-revoked voiceprint generations."""

import json

from django.core.management.base import BaseCommand, CommandError
from django.db.models import F

from core import models
from core.services.voiceprint_consent import purge_deleted


class Command(BaseCommand):
    help = "Purge revoked voiceprint data; retain generation tombstones and receipts."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=100)

    def handle(self, *args, **options):
        limit = options["limit"]
        if not 1 <= limit <= 1000:
            raise CommandError("Limit must be between 1 and 1000.")
        identifiers = list(
            models.VoiceprintDeletionJob.objects.filter(
                status__in=["queued", "failed"],
                attempts__lt=3,
            )
            .order_by("created_at", "id")
            .values_list("pk", flat=True)[:limit]
        )
        counts = {"succeeded": 0, "failed": 0}
        for identifier in identifiers:
            try:
                purge_deleted(identifier)
                counts["succeeded"] += 1
            except Exception:  # noqa: BLE001 -- Sanitized cleanup receipt, no payload log.
                models.VoiceprintDeletionJob.objects.filter(pk=identifier).exclude(
                    status="succeeded"
                ).update(
                    status="failed",
                    attempts=F("attempts") + 1,
                    error_code="cleanup_unavailable",
                )
                counts["failed"] += 1
        self.stdout.write(json.dumps(counts, sort_keys=True))
