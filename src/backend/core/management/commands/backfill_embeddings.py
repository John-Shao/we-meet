"""Manual entry point for the Sprint 2.4 embedding pipeline.

Re-runs ``embed_meeting_transcripts`` synchronously (not via Celery) so
historical meetings get TranscriptChunks. Useful after first deploy of
Sprint 2.4 (no chunks exist yet for past meetings) and as a recovery
tool when embedding tasks failed silently.

Usage:
    python manage.py backfill_embeddings <room_id>           # single room
    python manage.py backfill_embeddings --all               # every room with a Summary
    python manage.py backfill_embeddings --all --dry-run     # just count
"""

import logging

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Count

from core.models import Room

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Backfill TranscriptChunk embeddings for finished meetings."

    def add_arguments(self, parser):
        parser.add_argument(
            "room",
            nargs="?",
            help="Room UUID or slug. Omit when using --all.",
        )
        parser.add_argument(
            "--all",
            action="store_true",
            help="Embed every Room that has a successful Summary.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Count target rooms without calling the embedding API.",
        )

    def handle(self, *args, **options):
        # Imported here to avoid a hard import-time dependency on the
        # task module / Celery during management command parsing.
        from core.tasks.embeddings import embed_meeting_transcripts

        if options["all"]:
            return self._handle_all(
                embed_meeting_transcripts, dry_run=options["dry_run"]
            )
        if not options["room"]:
            raise CommandError("Either <room> or --all is required")
        return self._handle_one(embed_meeting_transcripts, options["room"])

    def _resolve_room(self, ref: str) -> Room:
        try:
            room = (
                Room.objects.filter(id=ref).first()
                or Room.objects.filter(slug=ref).first()
            )
        except (ValueError, Room.DoesNotExist):
            room = None
        if room is None:
            raise CommandError(f"Room not found: {ref}")
        return room

    def _handle_one(self, task_fn, ref: str):
        room = self._resolve_room(ref)
        # Call the task body directly — Celery tasks are plain callables,
        # this runs sync without going through the broker. Works in both
        # CELERY_ENABLED and sync-fallback environments.
        result = task_fn(str(room.id))
        self.stdout.write(
            self.style.SUCCESS(f"room={room.id} chunks={result}")
        )

    def _handle_all(self, task_fn, *, dry_run: bool):
        rooms = (
            Room.objects.annotate(t_count=Count("transcripts"))
            .filter(t_count__gt=0, summary__status="success")
            .order_by("-updated_at")
        )
        count = rooms.count()
        if dry_run:
            self.stdout.write(
                self.style.NOTICE(
                    f"Dry-run: would embed {count} room(s) with successful summaries."
                )
            )
            return

        self.stdout.write(f"Embedding {count} room(s)…")
        ok = 0
        for room in rooms:
            try:
                # Call the task body directly — Celery tasks are plain callables,
                # this runs sync without going through the broker. Works in both
                # CELERY_ENABLED and sync-fallback environments.
                result = task_fn(str(room.id))
                ok += 1
                self.stdout.write(f"  {room.id} → {result} chunks")
            except Exception as exc:  # noqa: BLE001
                logger.exception("backfill failed for %s", room.id)
                self.stdout.write(self.style.ERROR(f"  {room.id} → {exc}"))
        self.stdout.write(self.style.SUCCESS(f"Done: {ok}/{count} succeeded"))
