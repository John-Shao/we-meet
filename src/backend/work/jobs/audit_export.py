"""Audit export worker (E2: local Content Store mock; E5 swaps the store)."""

import csv
import io
import json
import logging
import uuid
from datetime import datetime

from core.models import Organization

from work.api import content_store
from work.api.context import fetch_all, role_cursor
from work.api.presenters import as_dict

logger = logging.getLogger(__name__)

CSV_COLUMNS = [
    "id",
    "actor_subject_id",
    "action",
    "target_type",
    "target_id",
    "metadata",
    "created_at",
]


def _rows(cursor, org_id, range_from, range_to):
    cursor.execute(
        "SELECT id, actor_subject_id, action, target_type, target_id, metadata, "
        "created_at FROM work.audit_event WHERE org_id = %s "
        "AND created_at >= %s AND created_at < %s ORDER BY created_at, id",
        [org_id, range_from, range_to],
    )
    return fetch_all(cursor)


def _render(rows, fmt):
    if fmt == "json":
        return (
            json.dumps(
                [
                    {
                        **row,
                        "id": str(row["id"]),
                        "created_at": row["created_at"].isoformat(),
                    }
                    for row in rows
                ],
                ensure_ascii=False,
            ).encode("utf-8"),
            "application/json",
            ".json",
        )
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=CSV_COLUMNS)
    writer.writeheader()
    for row in rows:
        writer.writerow(
            {
                **row,
                "id": str(row["id"]),
                "metadata": json.dumps(row["metadata"], ensure_ascii=False),
                "created_at": row["created_at"].isoformat(),
            }
        )
    return buffer.getvalue().encode("utf-8"), "text/csv", ".csv"


def run_once(worker_id: str | None = None) -> dict:
    worker_id = worker_id or f"export-worker-{uuid.uuid4().hex[:8]}"
    completed = 0
    failed = 0
    for org in Organization.objects.all().order_by("id"):
        org_id = str(org.id)
        with role_cursor(org_id, "work_worker") as cursor:
            cursor.execute(
                "SELECT export_id FROM work.list_pending_audit_exports(%s)",
                [org_id],
            )
            queued = [row[0] for row in cursor.fetchall()]
        for export_id in queued:
            try:
                with role_cursor(org_id, "work_worker") as cursor:
                    cursor.execute(
                        "SELECT work.claim_audit_export(%s, %s, 600)",
                        [export_id, worker_id],
                    )
                    claimed = as_dict(cursor.fetchone()[0])
                if not claimed:
                    continue
                with role_cursor(org_id, "work_worker") as cursor:
                    rows = _rows(
                        cursor,
                        org_id,
                        datetime.fromisoformat(
                            claimed["range_from"].replace("Z", "+00:00")
                        ),
                        datetime.fromisoformat(
                            claimed["range_to"].replace("Z", "+00:00")
                        ),
                    )
                body, _, suffix = _render(rows, claimed["format"])
                ref, content_hash, size = content_store.put(org_id, body, suffix=suffix)
                with role_cursor(org_id, "work_worker") as cursor:
                    cursor.execute(
                        "SELECT work.complete_audit_export("
                        "%s, %s, %s, %s, %s, %s, 86400)",
                        [
                            export_id,
                            worker_id,
                            ref,
                            content_hash,
                            size,
                            len(rows),
                        ],
                    )
                completed += 1
            except Exception as error:
                logger.exception(
                    "work audit export failed org_id=%s export_id=%s",
                    org_id,
                    export_id,
                )
                failed += 1
                try:
                    with role_cursor(org_id, "work_worker") as cursor:
                        cursor.execute(
                            "SELECT work.fail_audit_export(%s, %s, %s)",
                            [export_id, worker_id, "export_failed"],
                        )
                except Exception:
                    logger.exception(
                        "work audit export fail transition failed export_id=%s",
                        export_id,
                    )
    return {"worker_id": worker_id, "completed": completed, "failed": failed}
