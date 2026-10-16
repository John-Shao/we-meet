"""Run bilingual tests against a fresh database on the local validation container."""

# Django imports require the disposable environment to be configured first.
# ruff: noqa: PLC0415

import json
import os
import shutil
import subprocess
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

import psycopg
from psycopg import sql


@contextmanager
def isolated_backend():
    """Never reuse a developer or production database for regression tests."""
    backend = Path(__file__).resolve().parents[1] / "src/backend"
    inspection = json.loads(
        subprocess.check_output(  # noqa: S603 -- fixed local Docker inspection
            [shutil.which("docker") or "docker", "inspect", "meet-import-validation"],
            text=True,
        )
    )[0]
    if inspection["NetworkSettings"]["Ports"].get("5432/tcp") != [
        {"HostIp": "127.0.0.1", "HostPort": "55440"}
    ]:
        raise RuntimeError("Expected dedicated loopback validation PostgreSQL")
    container_env = dict(
        item.split("=", 1) for item in inspection["Config"]["Env"] if "=" in item
    )
    user = quote(container_env.get("POSTGRES_USER", "postgres"), safe="")
    password = quote(container_env.get("POSTGRES_PASSWORD", ""), safe="")
    prefix = f"postgresql://{user}:{password}@127.0.0.1:55440/"
    database = "bilingual_validation_" + uuid.uuid4().hex
    with psycopg.connect(prefix + "postgres", autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
        try:
            os.environ.update(
                DJANGO_SETTINGS_MODULE="meet.settings",
                DJANGO_CONFIGURATION="Test",
                DJANGO_SECRET_KEY="bilingual-local-tests-only",  # noqa: S106 -- fixture
                DATABASE_URL=prefix + database,
                AWS_S3_ENDPOINT_URL="http://localhost:9000",
                AWS_S3_ACCESS_KEY_ID="test",
                AWS_S3_SECRET_ACCESS_KEY="test",  # noqa: S106 -- unused fixture
                AWS_S3_REGION_NAME="local",
                REDIS_URL="redis://127.0.0.1:56379/12",
                OIDC_OP_JWKS_ENDPOINT="http://localhost:9999/unused-test-jwks",
            )
            os.chdir(backend)
            sys.path.insert(0, str(backend))
            from configurations import importer

            importer.install()
            import django

            django.setup()
            yield backend
        finally:
            from django.db import connections

            connections.close_all()
            admin.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    sql.Identifier(database)
                )
            )


def main():
    """Run the fixed regression selection in a disposable database."""
    with isolated_backend():
        from django.core.management import call_command

        if "--write-migration" in sys.argv:
            call_command("makemigrations", "core", name="bilingual_session")
            return 0
        call_command("makemigrations", "core", check=True, dry_run=True)
        import pytest

        return pytest.main(
            [
                "core/tests/test_assistant_translation.py",
                "core/tests/test_assistant_translation_config.py",
                "core/tests/test_assistant_translation_direct.py",
                "core/tests/test_bilingual_sessions.py",
                "-q",
                "--tb=short",
            ]
        )


if __name__ == "__main__":
    raise SystemExit(main())
