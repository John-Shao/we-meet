"""Run one audit export worker pass (E2 local Content Store mock)."""

from django.core.management.base import BaseCommand

from work.jobs.audit_export import run_once


class Command(BaseCommand):
    help = "Claim queued audit exports and write them to the Content Store mock."

    def add_arguments(self, parser):
        parser.add_argument("--worker-id", default=None)

    def handle(self, *args, **options):
        result = run_once(options.get("worker_id"))
        self.stdout.write(
            f"audit export worker {result['worker_id']}: "
            f"completed={result['completed']} failed={result['failed']}"
        )
