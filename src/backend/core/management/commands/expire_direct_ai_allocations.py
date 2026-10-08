"""Reclaim stale app leases and report aggregate metadata; no model calls."""

from django.core.management.base import BaseCommand
from django.db.models import Count

from core.models import DirectAIAllocation
from core.services.direct_ai_allocations import expire


class Command(BaseCommand):
    help = "Expire direct AI admission leases. Counts are not supplier billing or verified concurrency."

    def handle(self, *args, **options):
        self.stdout.write(f"expired={expire()}")
        for row in DirectAIAllocation.objects.values("model", "transport", "status").annotate(count=Count("id")).order_by("model", "transport", "status"):
            self.stdout.write(f"{row['model']} {row['transport']} {row['status']} {row['count']}")
