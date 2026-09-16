"""Close rooms that were created but never joined and never scheduled.

Operational companion to the beat entry ``close-abandoned-rooms``: the same four
safe conditions, runnable by hand. ``--dry-run`` answers "how many, and which"
without touching anything, which is what you want before running it against a
live database.
"""

from datetime import timedelta
from logging import getLogger

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from core import models

logger = getLogger(__name__)


class Command(BaseCommand):
    help = "Close rooms nobody ever joined and that were never scheduled."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only report what would be closed.",
        )
        parser.add_argument(
            "--seconds",
            type=int,
            default=None,
            help=(
                "Grace period in seconds. Defaults to ROOM_ABANDONED_AFTER_SECONDS "
                f"(currently {settings.ROOM_ABANDONED_AFTER_SECONDS}). Lower it to "
                "clean rooms that are newer than the regular window."
            ),
        )

    def handle(self, *args, **options):
        seconds = options["seconds"]
        if seconds is None:
            seconds = settings.ROOM_ABANDONED_AFTER_SECONDS
        if seconds < 0:
            self.stderr.write("--seconds must not be negative.")
            return

        cutoff = timezone.now() - timedelta(seconds=seconds)
        abandoned = models.Room.objects.filter(
            ended_at__isnull=True,
            scheduled_at__isnull=True,
            meeting_sessions__isnull=True,
            created_at__lte=cutoff,
        )
        rows = list(abandoned.values_list("id", "name", "created_at").distinct())
        for room_id, name, created_at in rows:
            self.stdout.write(
                f"  {room_id}  {created_at.isoformat()}  {name or '(untitled)'}"
            )

        if options["dry_run"]:
            self.stdout.write(
                self.style.WARNING(
                    f"[dry-run] {len(rows)} room(s) older than "
                    f"{seconds}s would be closed; nothing changed."
                )
            )
            return

        closed = models.Room.objects.filter(
            id__in=[room_id for room_id, _name, _created in rows]
        ).update(ended_at=timezone.now())
        logger.info("room.abandoned_closed count=%s cutoff=%s", closed, cutoff)
        self.stdout.write(
            self.style.SUCCESS(
                f"Closed {closed} room(s) older than {seconds}s "
                f"(cutoff {cutoff.isoformat()})."
            )
        )
