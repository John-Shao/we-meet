"""Audit or apply the same reservation policy used by entry and periodic cleanup."""

from django.core.management.base import BaseCommand
from django.utils import timezone

from core import models
from core.services.room_reservations import closing_reason, reconcile_room


class Command(BaseCommand):
    help = "Report expired/cancelled reservations; pass --apply to close them without deleting history."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true")

    def handle(self, *args, **options):
        now = timezone.now()
        count = 0
        rooms = models.Room.objects.filter(ended_at__isnull=True).exclude(
            scheduled_at__isnull=True, reservation_cancelled_at__isnull=True
        )
        for room in rooms.iterator(chunk_size=500):
            reason = closing_reason(room, now)
            if not reason:
                continue
            if options["apply"]:
                current = reconcile_room(room.pk, now=now)
                if not current or not current.ended_at:
                    continue
                reason = current.closure_reason
            count += 1
            self.stdout.write(f"{room.pk} {reason}")
        mode = "closed" if options["apply"] else "would_close"
        self.stdout.write(f"{mode}={count}")
