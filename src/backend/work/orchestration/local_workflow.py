"""Local R0a Run slice: Work SQL activities + faux model gateway (E4/E5 mock).

This is not Temporal. It proves the activity ordering and state machine against
PostgreSQL; E4 swaps the runner for Temporal while keeping the same contracts.
"""

import hashlib
import json
from dataclasses import dataclass
from datetime import date

from work.api import content_store
from work.api.context import fetch_one, role_cursor
from work.orchestration.contracts.run_workflow import (
    ArtifactDraft,
    ModelUsage,
    PreparedRun,
)
from work.runtime.mock.model_gateway import FauxModelGateway


@dataclass(frozen=True, slots=True)
class LocalRunResult:
    run_id: str
    task_id: str
    artifact_id: str
    version_no: int
    settled_tokens: int


def _request_hash(*parts) -> str:
    value = "|".join(str(part) for part in parts)
    return f"sha256:{hashlib.sha256(value.encode()).hexdigest()}"


def prepare_run(run_id: str, org_id: str) -> PreparedRun:
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT r.id, r.task_id, r.org_id, r.state, r.fence, t.snapshot_id, "
            "t.permission_mode FROM work.run r JOIN work.task t "
            "ON t.id = r.task_id AND t.org_id = r.org_id "
            "WHERE r.id = %s AND r.org_id = %s",
            [run_id, org_id],
        )
        row = fetch_one(cursor)
    if row is None:
        raise ValueError("run_not_found")
    if row["state"] != "queued":
        raise ValueError("run_not_queued")
    return PreparedRun(
        run_id=str(row["id"]),
        task_id=str(row["task_id"]),
        org_id=org_id,
        snapshot_id=str(row["snapshot_id"]),
        fence=row["fence"],
        permission_mode=row["permission_mode"],
    )


def acquire_run(run_id: str, org_id: str) -> PreparedRun:
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute("SELECT * FROM work.acquire_run(%s, %s)", [run_id, org_id])
        row = fetch_one(cursor)
        cursor.execute(
            "SELECT t.snapshot_id, t.permission_mode FROM work.task t "
            "JOIN work.run r ON r.task_id = t.id AND r.org_id = t.org_id "
            "WHERE r.id = %s AND r.org_id = %s",
            [run_id, org_id],
        )
        task = fetch_one(cursor)
    return PreparedRun(
        run_id=str(row["id"]),
        task_id=str(row["task_id"]),
        org_id=org_id,
        snapshot_id=str(task["snapshot_id"]),
        fence=row["fence"],
        permission_mode=task["permission_mode"],
    )


def create_model_operation(
    run_id: str, org_id: str, logical_key: str, request_hash: str
) -> str:
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT work.create_operation(%s, %s, %s, 'model', %s)",
            [run_id, org_id, logical_key, request_hash],
        )
        return str(cursor.fetchone()[0])


def authorize_operation(operation_id: str, org_id: str, policy_epoch: int) -> None:
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT work.authorize_operation(%s, %s, %s)",
            [org_id, operation_id, policy_epoch],
        )


def reserve_quota(
    org_id: str, account_key: str, period_id: str, operation_id: str, amount_tokens: int
) -> dict:
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT work.reserve_quota(%s, %s, %s, %s, %s)",
            [org_id, account_key, period_id, operation_id, amount_tokens],
        )
        return {"reservation_id": str(cursor.fetchone()[0])}


def claim_dispatch(
    operation_id: str, org_id: str, consumer_id: str, fence: int
) -> str | None:
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT work.claim_dispatch(%s, %s, %s, %s)",
            [operation_id, org_id, consumer_id, fence],
        )
        row = cursor.fetchone()
        return str(row[0]) if row and row[0] else None


def finish_operation(
    operation_id: str,
    org_id: str,
    outcome: str,
    provider_request_id: str | None,
    receipt_ref: str | None,
) -> None:
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT work.finish_operation(%s, %s, %s, %s, %s)",
            [org_id, operation_id, outcome, provider_request_id, receipt_ref],
        )


def settle_quota(
    reservation_id: str,
    amount_tokens: int,
    usage: dict,
    settlement_revision: int,
) -> None:
    with role_cursor(usage["org_id"], "work_worker") as cursor:
        cursor.execute(
            "SELECT work.settle_quota(%s, %s, %s::jsonb, %s)",
            [
                reservation_id,
                amount_tokens,
                json.dumps(usage["payload"], ensure_ascii=False),
                settlement_revision,
            ],
        )


def publish_artifact(  # noqa: PLR0913
    org_id: str,
    task_id: str,
    run_id: str,
    content_ref: str,
    content_hash: str,
    size: int,
    provenance: dict,
) -> ArtifactDraft:
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT * FROM work.publish_artifact(%s, %s, %s, 'draft.md', %s, %s, %s, "
            "'text/markdown', %s::jsonb)",
            [
                org_id,
                task_id,
                run_id,
                content_ref,
                content_hash,
                size,
                json.dumps(provenance, ensure_ascii=False),
            ],
        )
        artifact_id, version_no = cursor.fetchone()
    return ArtifactDraft(
        artifact_id=str(artifact_id),
        version_no=version_no,
        content_ref=content_ref,
        content_hash=content_hash,
        bytes=size,
    )


def finish_run(
    run_id: str, org_id: str, outcome: str, reason: str | None = None
) -> None:
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT work.finish_run(%s, %s, %s, %s)",
            [run_id, org_id, outcome, reason],
        )


def run_local_workflow(
    run_id: str, org_id: str, *, gateway=None, consumer_id="local-worker"
) -> LocalRunResult:
    gateway = gateway or FauxModelGateway()
    prepared = prepare_run(run_id, org_id)
    acquired = acquire_run(run_id, org_id)
    request_hash = _request_hash(run_id, "model.main")
    operation_id = create_model_operation(run_id, org_id, "model.main", request_hash)
    authorize_operation(operation_id, org_id, 1)

    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT qa.account_key, qa.period_id, op.run_cap_tokens "
            "FROM work.quota_account qa JOIN work.org_policy op "
            "ON op.org_id = qa.org_id "
            "WHERE qa.org_id = %s AND qa.account_key = 'default' "
            "ORDER BY qa.period_id DESC LIMIT 1",
            [org_id],
        )
        quota = fetch_one(cursor)
        cursor.execute(
            "SELECT owner_subject_id FROM work.task WHERE id = %s AND org_id = %s",
            [prepared.task_id, org_id],
        )
        subject = cursor.fetchone()[0]
    if quota is None:
        raise ValueError("quota_account_missing")
    reservation = reserve_quota(
        org_id,
        quota["account_key"],
        quota["period_id"],
        operation_id,
        int(quota["run_cap_tokens"]),
    )
    dispatch_attempt = claim_dispatch(operation_id, org_id, consumer_id, acquired.fence)
    if dispatch_attempt is None:
        raise ValueError("dispatch_not_claimed")

    provider = gateway.resolve_provider_context(org_id)
    result = gateway.invoke(
        type("Request", (), {"operation_id": operation_id})(), provider
    )
    usage = result.usage
    finish_operation(
        operation_id,
        org_id,
        "succeeded",
        result.provider_request_id,
        result.content_ref,
    )
    # Usage is recorded before settlement: record_usage treats an existing
    # revision-1 settle as "already accounted" and would otherwise skip the row.
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT work.record_usage(%s, %s, %s, %s, %s, %s, %s, %s, %s, 1)",
            [
                org_id,
                subject,
                operation_id,
                provider.provider,
                provider.model,
                date.today(),
                usage.input_tokens,
                usage.output_tokens,
                usage.cached_input_tokens or 0,
            ],
        )
    settle_quota(
        reservation["reservation_id"],
        usage.input_tokens + usage.output_tokens,
        {
            "org_id": org_id,
            "payload": {
                "provider": provider.provider,
                "model": provider.model,
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "cached_input_tokens": usage.cached_input_tokens or 0,
            },
        },
        1,
    )
    artifact = publish_artifact(
        org_id,
        prepared.task_id,
        run_id,
        result.content_ref,
        result.content_hash,
        result.bytes,
        {"provider": provider.provider, "model": provider.model},
    )
    finish_run(run_id, org_id, "succeeded")
    return LocalRunResult(
        run_id=run_id,
        task_id=prepared.task_id,
        artifact_id=artifact.artifact_id,
        version_no=artifact.version_no,
        settled_tokens=usage.input_tokens + usage.output_tokens,
    )
