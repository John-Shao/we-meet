"""Recover queued office tasks independently of meeting workers."""

from django.core.management.base import BaseCommand

from work.runs import process_runs


class Command(BaseCommand):
    help = "Process one queued Work run (single model call)."

    def handle(self, *args, **options):
        self.stdout.write(str(process_runs()))
