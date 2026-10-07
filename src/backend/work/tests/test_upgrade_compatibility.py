"""Forward schema migration preserves historical rows and old-image writers."""

import io
import uuid
from unittest.mock import patch

from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.migration import Migration

import pytest

from core.factories import UserFactory

from work import agent_runs
from work.models import WorkArtifactVersion, WorkRun, WorkTask

OLD = ("work", "0002_workmaterial_locations_worktask_workrun_and_more")


@pytest.mark.django_db(transaction=True)
def test_work_upgrade_keeps_history_and_accepts_old_schema_inserts():
    user = UserFactory()
    executor = MigrationExecutor(connection)
    latest = executor.loader.graph.leaf_nodes("work")
    executor.migrate([OLD])
    old_apps = executor.loader.project_state([OLD]).apps
    Task = old_apps.get_model("work", "WorkTask")
    Run = old_apps.get_model("work", "WorkRun")
    Artifact = old_apps.get_model("work", "WorkArtifactVersion")

    def insert_old():
        task = Task.objects.create(
            owner_id=user.pk,
            request_key=uuid.uuid4(),
            recipient="fixture",
            goal="Synthetic legacy goal",
        )
        run = Run.objects.create(
            task=task,
            request_key=uuid.uuid4(),
            status="succeeded",
            model="fixture",
            base_url="https://model.example.invalid/v1",
            reserved_tokens=1000,
            max_output_tokens=300,
            input_tokens=100,
            output_tokens=30,
        )
        return task, run

    try:
        task, run = insert_old()
        artifact = Artifact.objects.create(
            run=run, version=1, body="Synthetic legacy result"
        )
        call_command("migrate_work_upgrade", apply=True, stdout=io.StringIO())
        current = WorkRun.objects.get(pk=run.pk)
        assert current.status == "succeeded"
        assert current.input_tokens == 100 and current.output_tokens == 30
        assert WorkTask.objects.get(pk=task.pk).kind == "communication"
        assert WorkArtifactVersion.objects.get(pk=artifact.pk).body == artifact.body
        assert current.execution_target == "cloud"
        assert current.artifact_manifest == [] and current.agent_payload == {}
        assert (
            agent_runs.claim([]) is None
        )  # Historical communication is never cloud-replayed.
        # Simulate the INSERT columns emitted by the exact production ORM.
        _, inserted = insert_old()
        assert WorkRun.objects.get(pk=inserted.pk).local_report_seq == 0
    finally:
        MigrationExecutor(connection).migrate(latest)


@pytest.mark.django_db(transaction=True)
def test_partial_upgrade_error_rolls_back_ddl_and_migration_records():
    executor = MigrationExecutor(connection)
    latest = executor.loader.graph.leaf_nodes("work")
    executor.migrate([OLD])
    apply = Migration.apply

    def fail_after_schema_expansion(migration, *args, **kwargs):
        if (
            migration.app_label == "work"
            and migration.name == "0006_pi_readonly_review"
        ):
            raise RuntimeError("synthetic migration fault")
        return apply(migration, *args, **kwargs)

    try:
        with patch.object(Migration, "apply", new=fail_after_schema_expansion):
            with pytest.raises(RuntimeError, match="synthetic migration fault"):
                call_command("migrate_work_upgrade", apply=True, stdout=io.StringIO())
        loader = MigrationExecutor(connection).loader
        assert {name for app, name in loader.applied_migrations if app == "work"} == {
            "0001_initial",
            OLD[1],
        }
        with connection.cursor() as cursor:
            columns = connection.introspection.get_table_description(
                cursor, "work_workrun"
            )
            assert "agent_payload" not in {column.name for column in columns}
            assert "work_workdevice" not in connection.introspection.table_names(cursor)
    finally:
        MigrationExecutor(connection).migrate(latest)
