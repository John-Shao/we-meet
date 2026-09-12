"""Recover pending public summary dispatches without creating new attempts."""

from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q
from django.utils import timezone

from core import models
from core.services.meeting_summary_requests import (
    dispatch_summary_request,
    requests_enabled,
)


class Command(BaseCommand):
    """Run periodically while the public summary rollout is enabled."""

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=100)

    def handle(self, *args, **options):
        if not requests_enabled() or not 1 <= options["limit"] <= 1000:
            raise CommandError("Enable summary requests and supply limit 1..1000.")
        rows = (
            models.MeetingSummaryRequest.objects.filter(dispatch_state="pending")
            .filter(
                Q(dispatch_attempted_at__isnull=True)
                | Q(dispatch_attempted_at__lt=timezone.now() - timedelta(seconds=30))
            )
            .order_by("created_at")
            .values_list("pk", flat=True)[: options["limit"]]
        )
        sent = sum(dispatch_summary_request(pk) for pk in list(rows))
        self.stdout.write(f"Dispatched {sent} pending summary requests.")
