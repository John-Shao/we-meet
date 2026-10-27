"""Shared helpers for the Work E1 gates: psql, scratch databases and DSNs."""

import os
import shlex
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote, urlunsplit

import pytest

WORK_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[4]
DESIGN_DIR = REPO_ROOT / "docs" / "plan" / "assets" / "work-r0a-design-2026-10-25"
SMOKE_SQL = DESIGN_DIR / "r0a-schema-smoke.sql"
RACE_SCRIPT = DESIGN_DIR / "r0a-concurrency-smoke.py"
SCHEMA_SQL = WORK_DIR / "sql" / "r0a_schema.sql"
ROLES_SQL = WORK_DIR / "sql" / "r0a_roles.sql"
BACKEND_DIR = REPO_ROOT / "src" / "backend"


def psql_prefix() -> list[str]:
    override = os.environ.get("WORK_PSQL")
    if override:
        return shlex.split(override)
    psql = shutil.which("psql")
    if psql:
        return [psql]
    message = (
        "psql is required for the Work SQL gates; install postgresql-client or "
        "set WORK_PSQL (for example 'docker exec -i work-r0a-pg psql -U postgres')"
    )
    if os.environ.get("CI") or os.environ.get("WORK_PSQL_REQUIRED"):
        pytest.fail(message)
    pytest.skip(message)


def run_psql(
    sql_file: Path, dbname: str, settings: dict
) -> subprocess.CompletedProcess:
    override = os.environ.get("WORK_PSQL")
    command = psql_prefix() + [
        "-X",
        "-q",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
    ]
    env = os.environ.copy()
    if not override:
        for flag, key in (("-h", "HOST"), ("-p", "PORT"), ("-U", "USER")):
            value = settings.get(key)
            if value:
                command += [flag, str(value)]
        if settings.get("PASSWORD"):
            env["PGPASSWORD"] = str(settings["PASSWORD"])
    command += ["-d", dbname]
    with sql_file.open("rb") as source:
        return subprocess.run(
            command,
            stdin=source,
            capture_output=True,
            text=True,
            env=env,
            timeout=600,
            check=False,
        )


def database_dsn(settings: dict, dbname: str) -> str:
    host = str(settings.get("HOST") or "localhost")
    port = str(settings.get("PORT") or 5432)
    user = quote(str(settings.get("USER") or ""), safe="")
    password = quote(str(settings.get("PASSWORD") or ""), safe="")
    credentials = f"{user}:{password}@" if user else ""
    return urlunsplit(
        ("postgresql", f"{credentials}{host}:{port}", f"/{dbname}", "", "")
    )


def admin_dsn(settings: dict) -> str:
    return database_dsn(settings, "postgres")
