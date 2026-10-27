"""E1 concurrency gate: run the design asset races against the migrated SQL."""

import json
import os
import subprocess
import sys

import pytest

from work.tests.support import RACE_SCRIPT, REPO_ROOT, SCHEMA_SQL

RACE_CHECKS = {
    "export_claim_single_winner",
    "export_lease_takeover",
    "download_token_single_use",
    "projection_monotonic",
    "expiry_sweep_shreds_once",
    "revocation_blocks_new_work",
    "provider_config_one_active",
    "usage_upsert_no_lost_update",
    "overview_matches_ledger",
}


@pytest.mark.django_db(transaction=True)
def test_nine_races_hold_on_the_migrated_schema(scratch_database, tmp_path):
    _, dsn = scratch_database("race")
    env = os.environ.copy()
    env.update(
        {
            "R0A_DATABASE_URL": dsn,
            "R0A_SCHEMA_SQL": str(SCHEMA_SQL),
            "R0A_LOG_FILE": str(tmp_path / "concurrency.json"),
        }
    )
    result = subprocess.run(
        [sys.executable, str(RACE_SCRIPT)],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    assert result.returncode == 0, result.stderr[-4000:]
    report = json.loads(result.stdout)
    assert set(report["gate"]["checks"]) == RACE_CHECKS
    assert report["gate"]["violations"] == []
    assert all(report["gate"]["checks"].values())
