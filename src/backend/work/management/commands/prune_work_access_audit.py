"""Drain the Work access-audit retention backlog.

The hourly beat task deletes at most ``WORK_ACCESS_AUDIT_PRUNE_BATCH`` rows per
tick. The first deployment after enabling retention usually faces a much larger
backlog, and a single long delete would be one transaction with no checkpoint.
Run this command instead; each batch is independent, so an interruption only
costs the batch in flight.

    python manage.py prune_work_access_audit --dry-run --batches 20
    python manage.py prune_work_access_audit --batches 20
"""

from django.conf import settings
from django.core.management.base import BaseCommand

from work.tasks import prune_access_audit_rows


class Command(BaseCommand):
    help = "Delete Work access-audit rows past the retention window."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report the whole backlog without deleting anything.",
        )
        parser.add_argument(
            "--batches",
            type=int,
            default=1,
            help="Stop after this many deleting batches (default 1).",
        )

    def handle(self, *args, **options):
        batches = max(1, options["batches"])
        # The setting wins when it is on: the rollout procedure is "dry-run a
        # week, then flip the switch", and a flag must not skip that gate.
        dry_run = bool(
            options["dry_run"] or settings.WORK_ACCESS_AUDIT_RETENTION_DRY_RUN
        )
        deleted = 0
        for index in range(batches):
            result = prune_access_audit_rows(dry_run=dry_run)
            deleted += result["deleted"]
            self.stdout.write(
                f"batch {index + 1}: deleted={result['deleted']} "
                f"has_more={result['has_more']}"
            )
            if not result["has_more"]:
                break

        verb = "would delete" if dry_run else "deleted"
        self.stdout.write(self.style.SUCCESS(f"{verb} {deleted} row(s)"))
