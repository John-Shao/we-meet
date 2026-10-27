"""E1 migration gates: Django wiring, roles, schema ownership and rollback."""

import os
import subprocess
import sys

from django.apps import apps
from django.db import connection

import psycopg
import pytest

from work.tests.support import BACKEND_DIR, SMOKE_SQL, run_psql

WORK_ROLES = {
    "work_owner",
    "work_api",
    "work_worker",
    "work_ledger",
    "work_migrator",
    "work_ops",
    "work_directory",
}


def _scalar(dsn: str, sql: str):
    with psycopg.connect(dsn) as conn:
        return conn.execute(sql).fetchone()[0]


def _manage(env: dict, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "manage.py", *args],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


def test_work_app_is_registered():
    assert apps.is_installed("work")


@pytest.mark.django_db
def test_work_roles_exist_and_cannot_login():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY(%s)",
            [list(WORK_ROLES)],
        )
        rows = cursor.fetchall()
    assert {name for name, _ in rows} == WORK_ROLES
    assert not any(can_login for _, can_login in rows)


@pytest.mark.django_db
def test_migrated_schema_is_owned_by_work_owner():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'work'"
        )
        assert cursor.fetchone()[0] == "work_owner"
        cursor.execute("SHOW search_path")
        assert "work" in cursor.fetchone()[0]
        cursor.execute(
            "SELECT to_regprocedure("
            "'work.reserve_quota(text,text,text,uuid,bigint)') IS NOT NULL"
        )
        assert cursor.fetchone()[0] is True
        cursor.execute(
            "SELECT prosecdef FROM pg_proc "
            "WHERE oid = 'work.reserve_quota(text,text,text,uuid,bigint)'::regprocedure"
        )
        assert cursor.fetchone()[0] is True


@pytest.mark.django_db(transaction=True)
def test_migrated_schema_passes_the_smoke(work_db_settings):
    result = run_psql(SMOKE_SQL, work_db_settings["NAME"], work_db_settings)
    assert result.returncode == 0, result.stderr[-4000:]
    rows = [line for line in result.stdout.splitlines() if line.endswith("|t")]
    assert len(rows) == 148, f"expected 148 smoke assertions, got {len(rows)}"


def test_migration_rolls_back_and_reapplies(scratch_database):
    _, dsn = scratch_database("migrate")
    env = os.environ.copy()
    env.update(
        {
            "DATABASE_URL": dsn,
            "DJANGO_SETTINGS_MODULE": "meet.settings",
            "DJANGO_CONFIGURATION": "Test",
            "DJANGO_SECRET_KEY": "work-r0a-tests",
        }
    )

    applied = _manage(env, "migrate", "work")
    assert applied.returncode == 0, applied.stderr[-4000:]
    assert _scalar(dsn, "SELECT to_regclass('work.task') IS NOT NULL") is True

    rolled_back = _manage(env, "migrate", "work", "zero")
    assert rolled_back.returncode == 0, rolled_back.stderr[-4000:]
    assert _scalar(dsn, "SELECT to_regclass('work.task') IS NULL") is True
    assert (
        _scalar(
            dsn,
            "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'work\\_%'",
        )
        == 7
    )

    reapplied = _manage(env, "migrate", "work")
    assert reapplied.returncode == 0, reapplied.stderr[-4000:]
    assert _scalar(dsn, "SELECT to_regclass('work.task') IS NOT NULL") is True
