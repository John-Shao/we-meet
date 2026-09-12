"""Operator entry point for opt-in versioned final summaries."""

from uuid import UUID

from django.core.management.base import BaseCommand, CommandError

from core import models
from core.services.meeting_records import RecordConflict, retry_job
from core.services.meeting_summary_versions import (
    prepare_summary_job,
    recover_summary_job,
)
from core.tasks.summary_versions import generate_record_summary


class Command(BaseCommand):
    """Create/reuse a job, then deliver the current attempt explicitly."""

    def add_arguments(self, parser):
        parser.add_argument("record_id", type=UUID)
        parser.add_argument("--regenerate", action="store_true")
        parser.add_argument("--retry", action="store_true")
        parser.add_argument("--recover-running", action="store_true")

    def handle(self, *args, **options):
        if (options["retry"] or options["recover_running"]) and options["regenerate"]:
            raise CommandError("Choose retry or regenerate, not both.")
        try:
            job = prepare_summary_job(
                options["record_id"], regenerate=options["regenerate"]
            )
            if options["recover_running"]:
                recover_summary_job(job.pk)
            if options["retry"] or options["recover_running"]:
                job = retry_job(job.pk)
        except RecordConflict as exc:
            raise CommandError(str(exc)) from exc
        except models.MeetingRecord.DoesNotExist as exc:
            raise CommandError("Meeting record does not exist.") from exc
        if job.status == "queued":
            generate_record_summary.apply_async(args=[str(job.pk), job.attempt])
        self.stdout.write(str(job.pk))
        job.refresh_from_db()
        if job.status in {"failed", "canceled"}:
            raise CommandError(job.error_code or "Summary job did not succeed.")
