"""Read projections over work tables, always executed as work_api + tenant GUC."""

import json

from work.api.content_store import get
from work.api.context import fetch_one
from work.api.presenters import as_dict

SUMMARY_SELECT = """
SELECT ts.org_id, ts.task_id, ts.owner_subject_id, ts.title, ts.task_state,
       ts.permission_mode, ts.active_run_id, ts.latest_run_id, ts.revision,
       ts.created_at, ts.updated_at, ts.display_state, ts.pending_acceptance,
       ts.blocking_operations, ts.reserved_tokens, ts.settled_tokens,
       ts.latest_artifact_id, ts.latest_artifact_version, ts.latest_artifact_hash,
       r.attempt_no, r.state AS run_state, r.wait_reason, r.terminal_reason,
       r.control_revision, r.runtime_version,
       r.created_at AS run_created_at, r.updated_at AS run_updated_at
FROM work.task_summary ts
LEFT JOIN work.run r ON r.id = ts.latest_run_id AND r.org_id = ts.org_id
"""


def summary_for_task(cursor, org_id: str, task_id: str, owner: str | None = None):
    sql = SUMMARY_SELECT + " WHERE ts.org_id = %s AND ts.task_id = %s"
    params = [org_id, task_id]
    if owner is not None:
        sql += " AND ts.owner_subject_id = %s"
        params.append(owner)
    cursor.execute(sql, params)
    return fetch_one(cursor)


def task_row(cursor, org_id: str, task_id: str, owner: str):
    cursor.execute(
        "SELECT * FROM work.task WHERE org_id = %s AND id = %s "
        "AND owner_subject_id = %s AND deleted_at IS NULL",
        [org_id, task_id, owner],
    )
    return fetch_one(cursor)


def input_row(cursor, org_id: str, subject_id: str, input_id: str):
    cursor.execute(
        "SELECT * FROM work.input_object WHERE org_id = %s AND id = %s "
        "AND subject_id = %s AND status = 'active'",
        [org_id, input_id, subject_id],
    )
    return fetch_one(cursor)


def input_payload(row) -> dict:
    return json.loads(get(row["org_id"], row["content_ref"]).decode("utf-8"))


def snapshot_manifest(cursor, org_id: str, snapshot_id):
    if snapshot_id is None:
        return {}
    cursor.execute(
        "SELECT manifest FROM work.capability_snapshot WHERE org_id = %s AND id = %s",
        [org_id, snapshot_id],
    )
    row = fetch_one(cursor)
    return as_dict(row["manifest"]) if row else {}


def run_row(cursor, org_id: str, run_id: str, owner: str):
    cursor.execute(
        "SELECT r.* FROM work.run r JOIN work.task t "
        "ON t.id = r.task_id AND t.org_id = r.org_id "
        "WHERE r.org_id = %s AND r.id = %s AND t.owner_subject_id = %s",
        [org_id, run_id, owner],
    )
    return fetch_one(cursor)
