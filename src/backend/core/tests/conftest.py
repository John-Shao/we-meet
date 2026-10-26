"""Fixtures for tests in the Meet core application"""

from unittest import mock

from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

import pytest

USER = "user"
TEAM = "team"
VIA = [USER, TEAM]


@pytest.fixture
def mock_user_get_teams():
    """Mock for the "get_teams" method on the User model."""
    with mock.patch("core.models.User.get_teams") as mock_get_teams:
        yield mock_get_teams


@pytest.fixture
def restore_full_schema():
    """把被倒到旧版本的测试库迁回完整计划。

    迁移测试会把**共享的 worker 库**倒回旧迁移（`transaction=True` 不回滚 DDL）。
    不恢复的话，同一 worker 上后面每个碰 `meet_organization` 的测试都会撞到
    "column does not exist" —— 看着像后端的 bug，实际由执行顺序决定。
    """
    yield
    call_command(
        "flush", "--no-input", reset_sequences=False, database=connection.alias
    )
    # 与 work/tests/test_upgrade_compatibility.py 同一手法：迁回所有叶子节点。
    executor = MigrationExecutor(connection)
    executor.migrate(executor.loader.graph.leaf_nodes())
