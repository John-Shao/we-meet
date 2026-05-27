"""Manual entry point for the Sprint 2.2.a summary pipeline.

Run against an existing room (UUID or slug) to (re)generate its Summary
and ActionItem rows. Useful for ops, smoke testing, and bulk back-fills
before the room-finished webhook hook is wired (Sprint 2.2.b).

Usage:
    python manage.py generate_summary <room_id_or_slug>
    python manage.py generate_summary --all       # all rooms with transcripts
"""

import logging

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Count

from core.models import Room
from core.services.meeting_summary import MeetingSummaryService

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Generate (or refresh) the Summary + ActionItems for a meeting."

    def add_arguments(self, parser):
        parser.add_argument(
            "room",
            nargs="?",
            help="Room UUID or slug. Omit when using --all.",
        )
        parser.add_argument(
            "--all",
            action="store_true",
            help="Regenerate summaries for every Room that has transcripts.",
        )

    def handle(self, *args, **options):
        service = MeetingSummaryService()
        if options["all"]:
            return self._handle_all(service)
        if not options["room"]:
            raise CommandError("Either <room> or --all is required")
        return self._handle_one(service, options["room"])

    def _handle_one(self, service: MeetingSummaryService, ref: str):
        try:
            room = (
                Room.objects.filter(id=ref).first()
                or Room.objects.filter(slug=ref).first()
            )
        except (ValueError, Room.DoesNotExist):
            room = None
        if room is None:
            raise CommandError(f"Room not found: {ref}")

        summary = service.generate(room)
        self.stdout.write(
            self.style.SUCCESS(
                f"room={room.id} status={summary.status} "
                f"transcripts={summary.transcripts_count}"
            )
        )
        if summary.error_message:
            self.stdout.write(self.style.WARNING(summary.error_message))

    def _handle_all(self, service: MeetingSummaryService):
        rooms = (
            Room.objects.annotate(t_count=Count("transcripts"))
            .filter(t_count__gt=0)
            .order_by("-updated_at")
        )
        count = rooms.count()
        self.stdout.write(f"Regenerating summaries for {count} room(s)…")
        ok = 0
        for room in rooms:
            try:
                summary = service.generate(room)
                if summary.status == "success":
                    ok += 1
                self.stdout.write(
                    f"  {room.id} → {summary.status}"
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("generate_summary failed for %s", room.id)
                self.stdout.write(self.style.ERROR(f"  {room.id} → {exc}"))
        self.stdout.write(self.style.SUCCESS(f"Done: {ok}/{count} succeeded"))
