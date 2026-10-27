"""Run one Host-directory projection pass into the Work schema."""

from django.core.management.base import BaseCommand

from work.jobs.directory_sync import run_once


class Command(BaseCommand):
    help = "Project organizations and memberships into work.org/work.member."

    def handle(self, *args, **options):
        result = run_once()
        self.stdout.write(
            f"directory sync: orgs={result['orgs']} members={result['members']}"
        )
