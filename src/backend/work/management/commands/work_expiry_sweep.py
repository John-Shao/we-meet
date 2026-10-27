"""Run one per-org expiry sweep."""

from django.core.management.base import BaseCommand

from work.jobs.expiry_sweep import run_once


class Command(BaseCommand):
    help = "Expire input objects and audit exports, and queue content shreds."

    def handle(self, *args, **options):
        result = run_once()
        self.stdout.write(
            f"expiry sweep: inputs={result['inputs']} exports={result['exports']} "
            f"shreds={result['shreds']}"
        )
