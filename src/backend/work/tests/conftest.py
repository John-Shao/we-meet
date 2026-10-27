"""Fixtures for the Work E1 gates."""

import uuid

from django.db import connection

import psycopg
import pytest

from work.tests.support import ROLES_SQL, admin_dsn, database_dsn


@pytest.fixture(scope="session")
def work_db_settings(django_db_setup):
    return connection.settings_dict.copy()


@pytest.fixture(scope="session")
def scratch_database(work_db_settings):
    created = []
    admin = psycopg.connect(admin_dsn(work_db_settings), autocommit=True)
    admin.execute(ROLES_SQL.read_text(encoding="utf-8"))

    def create(label: str):
        name = f"work_e1_{label}_{uuid.uuid4().hex[:8]}"
        admin.execute(f'CREATE DATABASE "{name}"')
        created.append(name)
        return name, database_dsn(work_db_settings, name)

    yield create

    for name in created:
        admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    admin.close()
