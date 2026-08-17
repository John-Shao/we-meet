"""Manual entry point for session-scoped transcript embeddings."""

import logging

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Count

from core.models import MeetingSession, Room
from core.tasks.embeddings import embed_meeting_transcripts

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Backfill TranscriptChunk embeddings for meeting sessions."

    def add_arguments(self, parser):
        parser.add_argument(
            "target",
            nargs="?",
            help="Session UUID, or a Room UUID/slug to use its latest session.",
        )
        parser.add_argument(
            "--all",
            action="store_true",
            help="Embed every session that has transcripts and a successful summary.",
        )
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        if options["all"]:
            return self._handle_all(
                embed_meeting_transcripts, dry_run=options["dry_run"]
            )
        if not options["target"]:
            raise CommandError("Either <target> or --all is required")
        session = self._resolve_session(options["target"])
        result = embed_meeting_transcripts(str(session.id))
        self.stdout.write(
            self.style.SUCCESS(
                f"session={session.id} room={session.room_id} chunks={result}"
            )
        )

    @staticmethod
    def _resolve_session(ref: str) -> MeetingSession:
        try:
            session = MeetingSession.objects.filter(id=ref).first()
        except ValueError:
            session = None
        if session is not None:
            return session
        try:
            room = (
                Room.objects.filter(id=ref).first()
                or Room.objects.filter(slug=ref).first()
            )
        except ValueError:
            room = None
        if room is None:
            raise CommandError(f"Session or Room not found: {ref}")
        session = (
            room.meeting_sessions.filter(transcripts__isnull=False)
            .distinct()
            .order_by("-started_at")
            .first()
        )
        if session is None:
            raise CommandError(f"Room has no session with transcripts: {ref}")
        return session

    def _handle_all(self, task_fn, *, dry_run: bool):
        sessions = (
            MeetingSession.objects.annotate(t_count=Count("transcripts"))
            .filter(t_count__gt=0, summary__status="success")
            .select_related("room")
            .order_by("-started_at")
        )
        count = sessions.count()
        if dry_run:
            self.stdout.write(
                self.style.NOTICE(
                    f"Dry-run: would embed {count} session(s) with successful summaries."
                )
            )
            return

        self.stdout.write(f"Embedding {count} session(s)...")
        ok = 0
        for session in sessions:
            try:
                result = task_fn(str(session.id))
                ok += 1
                self.stdout.write(f"  {session.id} -> {result} chunks")
            except Exception as exc:
                logger.exception("backfill failed for %s", session.id)
                self.stdout.write(self.style.ERROR(f"  {session.id} -> {exc}"))
        self.stdout.write(self.style.SUCCESS(f"Done: {ok}/{count} succeeded"))
