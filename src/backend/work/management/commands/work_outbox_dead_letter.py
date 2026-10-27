"""Operator requeue/skip for a dead-lettered outbox event (ticket required)."""

from django.core.management.base import BaseCommand, CommandError

from work.api.context import role_cursor


class Command(BaseCommand):
    help = "Requeue or skip a dead-lettered Work outbox event as work_ops."

    def add_arguments(self, parser):
        parser.add_argument("--org-id", required=True)
        parser.add_argument("--event-id", required=True)
        parser.add_argument("--action", choices=["requeue", "skip"], required=True)
        parser.add_argument("--reason", required=True)
        parser.add_argument("--actor", default="ops:oncall")

    def handle(self, *args, **options):
        reason = options["reason"].strip()
        if len(reason) < 4:
            raise CommandError("reason must be at least 4 characters")
        org_id = options["org_id"]
        actor = options["actor"]
        function = (
            "work.requeue_outbox_dead_letter"
            if options["action"] == "requeue"
            else "work.skip_outbox_dead_letter"
        )
        with role_cursor(org_id, "work_ops", actor) as cursor:
            cursor.execute(
                f"SELECT {function}(%s, %s, %s)",
                [options["event_id"], actor, reason],
            )
        self.stdout.write(
            f"event={options['event_id']} action={options['action']} by={actor}"
        )
