"""Manual entry point for session-scoped summary generation."""

import logging

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Count

from core.models import MeetingSession, Room
from core.services.meeting_summary import MeetingSummaryService

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Generate or refresh summary artifacts for a meeting session."

    def add_arguments(self, parser):
        parser.add_argument(
            "target",
            nargs="?",
            help="Session UUID, or a Room UUID/slug to use its latest session.",
        )
        parser.add_argument(
            "--all",
            action="store_true",
            help="Regenerate every session that has transcripts.",
        )

    def handle(self, *args, **options):
        service = MeetingSummaryService()
        if options["all"]:
            return self._handle_all(service)
        if not options["target"]:
            raise CommandError("Either <target> or --all is required")
        return self._handle_one(service, options["target"])

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

    def _handle_one(self, service: MeetingSummaryService, ref: str):
        session = self._resolve_session(ref)
        summary = service.generate(session)
        self.stdout.write(
            self.style.SUCCESS(
                f"session={session.id} room={session.room_id} "
                f"status={summary.status} transcripts={summary.transcripts_count}"
            )
        )
        if summary.error_message:
            self.stdout.write(self.style.WARNING(summary.error_message))

    def _handle_all(self, service: MeetingSummaryService):
        sessions = (
            MeetingSession.objects.annotate(t_count=Count("transcripts"))
            .filter(t_count__gt=0)
            .select_related("room")
            .order_by("-started_at")
        )
        count = sessions.count()
        self.stdout.write(f"Regenerating summaries for {count} session(s)...")
        ok = 0
        for session in sessions:
            try:
                summary = service.generate(session)
                if summary.status == "success":
                    ok += 1
                self.stdout.write(f"  {session.id} -> {summary.status}")
            except Exception as exc:
                logger.exception("generate_summary failed for %s", session.id)
                self.stdout.write(self.style.ERROR(f"  {session.id} -> {exc}"))
        self.stdout.write(self.style.SUCCESS(f"Done: {ok}/{count} succeeded"))
