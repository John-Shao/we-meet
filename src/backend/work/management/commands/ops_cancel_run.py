"""D-07 A on-call cancellation: ticket and reason are mandatory."""

import os
import re

from django.core.management.base import BaseCommand, CommandError
from django.db import connection

import psycopg

from work.api.context import fetch_one, role_cursor

TICKET_RE = re.compile(r"^[A-Z][A-Z0-9]+-[0-9]+$")


class Command(BaseCommand):
    help = "Cancel an in-flight Work run as work_ops (internal command, not an API)."

    def add_arguments(self, parser):
        parser.add_argument("--org-id", required=True)
        parser.add_argument("--run-id", required=True)
        parser.add_argument("--ticket", required=True)
        parser.add_argument("--reason", required=True)
        parser.add_argument("--actor", default="ops:oncall")

    def handle(self, *args, **options):
        org_id = options["org_id"]
        run_id = options["run_id"]
        ticket = options["ticket"]
        reason = options["reason"]
        actor = options["actor"]
        if not TICKET_RE.fullmatch(ticket):
            raise CommandError("ticket must look like OPS-1024")
        if len(reason.strip()) < 4:
            raise CommandError("reason must be at least 4 characters")

        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT state FROM work.run WHERE id = %s AND org_id = %s",
                [run_id, org_id],
            )
            row = cursor.fetchone()
        if row is None:
            raise CommandError("run not found")
        if row[0] in ("succeeded", "failed", "canceled", "cancel_requested"):
            self.stdout.write(f"run={run_id} already terminal or cancel requested")
            return

        if os.environ.get("WORK_OPS_DB_HOST"):
            audit_id = self._with_ops_connection(org_id, run_id, actor, ticket, reason)
        else:
            with role_cursor(org_id, "work_ops", actor) as cursor:
                cursor.execute(
                    "SELECT work.ops_cancel_run(%s, %s, %s, %s, %s)",
                    [org_id, run_id, actor, ticket, reason],
                )
            with connection.cursor() as cursor:
                audit_id = self._audit_id(cursor, org_id, run_id)
        if audit_id:
            self.stdout.write(f"run={run_id} audit_event={audit_id}")
        else:
            self.stdout.write(f"run={run_id} already terminal or cancel requested")

    @staticmethod
    def _audit_id(cursor, org_id, run_id):
        cursor.execute(
            "SELECT id FROM work.audit_event WHERE org_id = %s "
            "AND action = 'run.cancel_requested_by_ops' AND target_id = %s "
            "ORDER BY created_at DESC LIMIT 1",
            [org_id, str(run_id)],
        )
        row = fetch_one(cursor)
        return row["id"] if row else None

    def _with_ops_connection(self, org_id, run_id, actor, ticket, reason):
        missing = [
            name
            for name in (
                "WORK_OPS_DB_NAME",
                "WORK_OPS_DB_USER",
                "WORK_OPS_DB_PASSWORD",
            )
            if not os.environ.get(name)
        ]
        if missing:
            raise CommandError(
                "WORK_OPS_DB_HOST is set but missing " + ", ".join(missing)
            )
        conninfo = psycopg.conninfo.make_conninfo(
            dbname=os.environ["WORK_OPS_DB_NAME"],
            user=os.environ["WORK_OPS_DB_USER"],
            password=os.environ["WORK_OPS_DB_PASSWORD"],
            host=os.environ["WORK_OPS_DB_HOST"],
            port=os.environ.get("WORK_OPS_DB_PORT", "5432"),
        )
        with psycopg.connect(conninfo) as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT set_config('app.org_id', %s, true)", [org_id])
                cursor.execute("SELECT set_config('app.subject_id', %s, true)", [actor])
                cursor.execute(
                    "SELECT work.ops_cancel_run(%s, %s, %s, %s, %s)",
                    [org_id, run_id, actor, ticket, reason],
                )
                try:
                    audit_id = self._audit_id(cursor, org_id, run_id)
                except psycopg.Error:
                    audit_id = None
            conn.commit()
        return audit_id
