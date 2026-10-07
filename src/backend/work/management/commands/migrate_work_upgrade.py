"""Commit the reviewed Work expansion and old-writer defaults together."""

import json

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.db.migrations.executor import MigrationExecutor

BASE = "0002_workmaterial_locations_worktask_workrun_and_more"
TARGET = "0007_old_writer_defaults"
EXPECTED = {
    "0003_workrun_agent_deployment_workrun_agent_done_and_more",
    "0004_workrun_artifact_manifest_workrun_execution_target_and_more",
    "0005_workrun_remote_requested_workworkspace_and_more",
    "0006_pi_readonly_review",
    TARGET,
}


def reviewed_plan(executor):
    executor.loader.check_consistent_history(connection)
    applied = {
        name for app, name in executor.loader.applied_migrations if app == "work"
    }
    if TARGET in applied:
        return []
    if applied != {"0001_initial", BASE}:
        raise CommandError("Work upgrade requires the reviewed 0002 baseline")
    plan = executor.migration_plan([("work", TARGET)])
    if any(reverse or migration.app_label != "work" for migration, reverse in plan):
        raise CommandError("Unexpected reverse or non-Work dependency migration")
    if {migration.name for migration, _ in plan} != EXPECTED:
        raise CommandError("Unexpected Work migration plan")
    return plan


class Command(BaseCommand):
    help = "Plan the Work 0002 to 0007 upgrade; --apply commits all DDL in one PostgreSQL transaction."
    requires_system_checks = []

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true")

    def handle(self, *args, **options):
        if connection.vendor != "postgresql":
            raise CommandError("This reviewed upgrade requires PostgreSQL")
        executor = MigrationExecutor(connection)
        plan = reviewed_plan(executor)
        names = [migration.name for migration, _ in plan]
        if not options["apply"] or not plan:
            self.stdout.write(
                json.dumps(
                    {
                        "phase": "plan" if plan else "already_current",
                        "migrations": names,
                        "database_changed": False,
                    }
                )
            )
            return
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout = '3s'")
                cursor.execute("SET LOCAL statement_timeout = '60s'")
                cursor.execute("SELECT pg_try_advisory_xact_lock(7420196007)")
                if not cursor.fetchone()[0]:
                    raise CommandError("Another Work schema upgrade is active")
            # Recheck after obtaining the lock; never apply a stale plan.
            executor = MigrationExecutor(connection)
            plan = reviewed_plan(executor)
            if plan:
                executor.migrate([("work", TARGET)], plan=plan)
        self.stdout.write(
            json.dumps({"phase": "applied", "migrations": names, "atomic": True})
        )
