"""Row → OpenAPI-shaped dictionaries. No user content in errors or events."""

import json


def iso(value):
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else value


def as_dict(value):
    if value is None or isinstance(value, dict):
        return value
    return json.loads(value)


def run_view(row) -> dict:
    return {
        "id": str(row["run_id"] if "run_id" in row else row["id"]),
        "task_id": str(row["task_id"]),
        "attempt_no": row["attempt_no"],
        "state": row["state"],
        "wait_reason": row.get("wait_reason"),
        "terminal_reason": row.get("terminal_reason"),
        "control_revision": row["control_revision"],
        "runtime_version": row["runtime_version"],
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


def _latest_run(row):
    if not row.get("latest_run_id"):
        return None
    return {
        "id": str(row["latest_run_id"]),
        "task_id": str(row["task_id"]),
        "attempt_no": row.get("attempt_no"),
        "state": row.get("run_state"),
        "wait_reason": row.get("wait_reason"),
        "terminal_reason": row.get("terminal_reason"),
        "control_revision": row.get("control_revision"),
        "runtime_version": row.get("runtime_version"),
        "created_at": iso(row.get("run_created_at")),
        "updated_at": iso(row.get("run_updated_at")),
    }


def task_summary(row) -> dict:
    artifact = None
    if row.get("latest_artifact_id"):
        artifact = {
            "artifact_id": str(row["latest_artifact_id"]),
            "version_no": row["latest_artifact_version"],
            "content_hash": row["latest_artifact_hash"],
        }
    return {
        "task_id": str(row["task_id"]),
        "title": row["title"],
        "display_state": row["display_state"],
        "task_state": row["task_state"],
        "permission_mode": row["permission_mode"],
        "active_run_id": str(row["active_run_id"])
        if row.get("active_run_id")
        else None,
        "latest_run_id": str(row["latest_run_id"])
        if row.get("latest_run_id")
        else None,
        "latest_run": _latest_run(row),
        "latest_artifact": artifact,
        "revision": row["revision"],
        "pending_acceptance": bool(row["pending_acceptance"]),
        "blocking_operations": int(row["blocking_operations"] or 0),
        "quota": {
            "reserved_tokens": int(row["reserved_tokens"] or 0),
            "settled_tokens": int(row["settled_tokens"] or 0),
        },
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


def operation_view(row) -> dict:
    return {
        "id": str(row["id"]),
        "run_id": str(row["run_id"]),
        "logical_key": row["logical_key"],
        "kind": row["kind"],
        "state": row["state"],
        "request_hash": row["request_hash"],
        "provider_request_id": row.get("provider_request_id"),
        "receipt_ref": row.get("receipt_ref"),
        "revision": row["revision"],
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


def artifact_version_view(row, content_url: str) -> dict:
    return {
        "artifact_id": str(row["artifact_id"]),
        "version_no": row["version_no"],
        "logical_name": row["logical_name"],
        "media_type": row["media_type"],
        "bytes": row["bytes"],
        "content_hash": row["content_hash"],
        "state": row["state"],
        "content_url": content_url,
        "created_at": iso(row["created_at"]),
        "published_at": iso(row["published_at"]),
    }


def credential_view(row) -> dict:
    return {
        "credential_id": str(row["credential_id"]),
        "provider": row["provider"],
        "mode": row["mode"],
        "fingerprint": row["fingerprint"],
        "key_version": row["key_version"],
        "state": row["state"],
        "created_at": iso(row["created_at"]),
        "rotated_at": iso(row.get("rotated_at")),
    }
