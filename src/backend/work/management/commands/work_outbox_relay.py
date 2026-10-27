"""Run one outbox relay pass."""

from django.core.management.base import BaseCommand

from work.jobs.outbox_relay import run_once


class Command(BaseCommand):
    help = "Claim and deliver pending Work outbox events."

    def add_arguments(self, parser):
        parser.add_argument("--relay-id", default=None)
        parser.add_argument("--limit", type=int, default=20)

    def handle(self, *args, **options):
        result = run_once(options.get("relay_id"), limit=options["limit"])
        self.stdout.write(
            f"outbox relay {result['relay_id']}: claimed={result['claimed']} "
            f"delivered={result['delivered']} failed={result['failed']}"
        )
