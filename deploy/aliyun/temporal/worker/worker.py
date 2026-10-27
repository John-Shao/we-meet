"""Temporal worker for the Work R0a RunWorkflow (D3).

Every activity goes through a ``work.*`` SECURITY DEFINER domain command; the
worker holds no table-level DML grants and never writes ``work`` tables
directly.  ``WORK_DATABASE_URL`` is required and must point at a login user
allowed to ``SET ROLE work_worker``.
"""

import asyncio
import hashlib
import json
import logging
import os
import tempfile
import uuid
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import asyncpg
from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError
from temporalio.worker import Worker

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

TASK_QUEUE = "work-r0a-run"
CONSUMER_ID = os.environ.get("WORK_WORKER_CONSUMER_ID", "temporal-worker")
DB_ROLE = "work_worker"
SYSTEM_SUBJECT = "system"
CONTENT_PREFIX = "content://"
DEFAULT_CONTENT_ROOT = Path(tempfile.gettempdir()) / "we-meet-work-content"
POLICY_EPOCH = 1
LOGICAL_KEY = "model:1"
DEFAULT_MODEL = os.environ.get("WORK_DEFAULT_MODEL", "qwen-max")

# Domain codes that describe a rejected request or a settled state: retrying
# them cannot change the outcome, so Temporal must not burn attempts on them.
NON_RETRYABLE_CODES = frozenset(
    {
        "approval_required",
        "artifact_read_only",
        "invalid_decision_source",
        "invalid_policy_epoch",
        "invalid_reason_code",
        "invalid_request",
        "invalid_run_outcome",
        "operation_has_active_reservation",
        "operation_key_conflict",
        "operation_not_authorizable",
        "operation_not_dispatching",
        "operation_not_found",
        "operation_not_reservable",
        "org_execution_unavailable",
        "provider_not_configured",
        "quota_exhausted",
        "run_cancel_requested",
        "run_cap_exceeded",
        "run_has_unresolved_operation",
        "run_not_current",
        "run_not_found",
        "run_not_queued",
        "scope_unavailable",
        "settlement_revision_not_monotonic",
    }
)

_db_pool: Optional[asyncpg.Pool] = None


def _database_url() -> str:
    url = os.environ.get("WORK_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "WORK_DATABASE_URL is required; it must be a login user that can "
            f"SET ROLE {DB_ROLE} (the Work roles themselves are NOLOGIN)"
        )
    return url


async def get_db_pool() -> asyncpg.Pool:
    global _db_pool
    if _db_pool is None:
        _db_pool = await asyncpg.create_pool(_database_url(), min_size=2, max_size=10)
        logger.info("database pool created")
    return _db_pool


def _domain_code(error: Exception) -> str:
    return str(error).split(":", 1)[0].strip()


def _as_application_error(error: Exception) -> ApplicationError:
    code = _domain_code(error)
    return ApplicationError(
        code, type=code, non_retryable=code in NON_RETRYABLE_CODES
    )


@asynccontextmanager
async def tenant_tx(org_id: str, subject_id: str = SYSTEM_SUBJECT):
    """Open a transaction as ``work_worker`` with the tenant GUCs set.

    The seven Work roles are NOLOGIN, so the connection authenticates as an
    application login user and switches role for the transaction, mirroring
    ``work.api.context.role_cursor``.  ``set_config(..., true)`` is
    transaction-local, which is what makes RLS and the domain commands see the
    tenant at all.
    """
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SELECT set_config('role', $1, true)", DB_ROLE)
            await conn.execute("SELECT set_config('app.org_id', $1, true)", org_id)
            await conn.execute(
                "SELECT set_config('app.subject_id', $1, true)", subject_id
            )
            try:
                yield conn
            except asyncpg.PostgresError as error:
                raise _as_application_error(error) from error


def _content_root() -> Path:
    return Path(os.environ.get("WORK_CONTENT_ROOT") or DEFAULT_CONTENT_ROOT)


def _store_content(org_id: str, body: str) -> dict:
    """Write model output to the Content Store root the API also reads.

    Mirrors ``work.content.mock.local_filesystem`` so the published
    ``content_ref`` actually resolves.
    """
    data = body.encode("utf-8")
    name = f"{uuid.uuid4().hex}.md"
    path = _content_root() / org_id / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {
        "content_ref": f"{CONTENT_PREFIX}{org_id}/{name}",
        "content_hash": f"sha256:{hashlib.sha256(data).hexdigest()}",
        "bytes": len(data),
    }


def _read_content(org_id: str, ref: str) -> bytes:
    if not ref.startswith(CONTENT_PREFIX):
        raise ApplicationError(
            "content_ref_invalid", type="content_ref_invalid", non_retryable=True
        )
    owner, _, name = ref[len(CONTENT_PREFIX) :].partition("/")
    root = (_content_root() / org_id).resolve()
    path = (root / name).resolve()
    if owner != org_id or not name or not path.is_relative_to(root):
        raise ApplicationError(
            "content_ref_invalid", type="content_ref_invalid", non_retryable=True
        )
    return path.read_bytes()


def _request_hash(*parts) -> str:
    value = "|".join(str(part) for part in parts)
    return f"sha256:{hashlib.sha256(value.encode()).hexdigest()}"


# ============================================================================
# Activities (16, per the D3 contract)
# ============================================================================


@activity.defn
async def prepare_run_activity(run_id: str, org_id: str) -> dict:
    logger.info("prepare_run run_id=%s", run_id)
    async with tenant_tx(org_id) as conn:
        row = await conn.fetchrow(
            """
            SELECT r.id, r.task_id, r.state, r.fence,
                   t.snapshot_id, t.permission_mode, t.owner_subject_id,
                   s.model_route, i.content_ref AS input_ref
            FROM work.run r
            JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
            JOIN work.input_object i ON i.id = t.input_id AND i.org_id = t.org_id
            LEFT JOIN work.capability_snapshot s
                   ON s.id = t.snapshot_id AND s.org_id = t.org_id
            WHERE r.id = $1 AND r.org_id = $2
            """,
            run_id,
            org_id,
        )
    if row is None:
        raise ApplicationError("run_not_found", type="run_not_found", non_retryable=True)
    model_route = row["model_route"]
    if isinstance(model_route, str):
        model_route = json.loads(model_route)
    return {
        "run_id": str(row["id"]),
        "task_id": str(row["task_id"]),
        "org_id": org_id,
        "state": row["state"],
        "fence": row["fence"],
        "snapshot_id": str(row["snapshot_id"]) if row["snapshot_id"] else None,
        "permission_mode": row["permission_mode"],
        "owner_subject_id": row["owner_subject_id"],
        "model": (model_route or {}).get("model") or DEFAULT_MODEL,
        "input_ref": row["input_ref"],
    }


@activity.defn
async def acquire_run_activity(run_id: str, org_id: str) -> dict:
    logger.info("acquire_run run_id=%s", run_id)
    async with tenant_tx(org_id) as conn:
        row = await conn.fetchrow(
            "SELECT * FROM work.acquire_run($1, $2)", run_id, org_id
        )
    return {
        "run_id": str(row["id"]),
        "state": row["state"],
        "fence": row["fence"],
        "control_revision": row["control_revision"],
    }


@activity.defn
async def create_model_operation_activity(
    run_id: str, org_id: str, logical_key: str, request_hash: str
) -> str:
    logger.info("create_model_operation run_id=%s key=%s", run_id, logical_key)
    async with tenant_tx(org_id) as conn:
        return str(
            await conn.fetchval(
                "SELECT work.create_operation($1, $2, $3, 'model', $4)",
                run_id,
                org_id,
                logical_key,
                request_hash,
            )
        )


@activity.defn
async def authorize_operation_activity(
    operation_id: str, org_id: str, policy_epoch: int
) -> None:
    logger.info("authorize_operation operation_id=%s", operation_id)
    try:
        async with tenant_tx(org_id) as conn:
            await conn.execute(
                "SELECT work.authorize_operation($1, $2, $3)",
                org_id,
                operation_id,
                policy_epoch,
            )
    except ApplicationError as error:
        if error.type != "operation_not_authorizable":
            raise
        # Activity retry after a lost result: already authorized is success.
        async with tenant_tx(org_id) as conn:
            state = await conn.fetchval(
                "SELECT state FROM work.operation WHERE id = $1 AND org_id = $2",
                operation_id,
                org_id,
            )
        if state != "authorized":
            raise


@activity.defn
async def reserve_quota_activity(operation_id: str, org_id: str) -> dict:
    logger.info("reserve_quota operation_id=%s", operation_id)
    async with tenant_tx(org_id) as conn:
        quota = await conn.fetchrow(
            """
            SELECT qa.account_key, qa.period_id, p.run_cap_tokens
            FROM work.quota_account qa
            JOIN work.org_policy p ON p.org_id = qa.org_id
            WHERE qa.org_id = $1 AND qa.account_key = 'default'
            ORDER BY qa.period_id DESC
            LIMIT 1
            """,
            org_id,
        )
        if quota is None:
            raise ApplicationError(
                "quota_account_missing",
                type="quota_account_missing",
                non_retryable=True,
            )
        amount_tokens = int(quota["run_cap_tokens"])
        reservation_id = await conn.fetchval(
            "SELECT work.reserve_quota($1, $2, $3, $4, $5)",
            org_id,
            quota["account_key"],
            quota["period_id"],
            operation_id,
            amount_tokens,
        )
    return {
        "reservation_id": str(reservation_id),
        "amount_tokens": amount_tokens,
        "account_key": quota["account_key"],
        "period_id": quota["period_id"],
    }


@activity.defn
async def claim_dispatch_activity(
    operation_id: str, org_id: str, fence: int
) -> dict:
    """Claim the single dispatch slot; a lost claim returns no permit.

    The Run state is read in the same transaction so the workflow can tell a
    cancellation apart from another worker having taken over.
    """
    logger.info("claim_dispatch operation_id=%s fence=%s", operation_id, fence)
    async with tenant_tx(org_id) as conn:
        dispatch_attempt_id = await conn.fetchval(
            "SELECT work.claim_dispatch($1, $2, $3, $4)",
            operation_id,
            org_id,
            CONSUMER_ID,
            fence,
        )
        run_state = await conn.fetchval(
            "SELECT r.state FROM work.run r "
            "JOIN work.operation o ON o.run_id = r.id AND o.org_id = r.org_id "
            "WHERE o.id = $1 AND o.org_id = $2",
            operation_id,
            org_id,
        )
    return {
        "dispatch_attempt_id": (
            str(dispatch_attempt_id) if dispatch_attempt_id else None
        ),
        "fence": fence,
        "run_state": run_state,
    }


@activity.defn
async def invoke_model_activity(  # noqa: PLR0913
    run_id: str,
    org_id: str,
    operation_id: str,
    model: str,
    input_ref: str,
    dispatch_attempt_id: str,
    fence: int,
    request_hash: str,
) -> dict:
    """Call the provider exactly once and store the output in the Content Store.

    Never retried: the permit, fence and request hash bind this call to one
    dispatch attempt, and a repeat would be a second billable call.
    """
    logger.info(
        "invoke_model operation_id=%s model=%s attempt=%s fence=%s",
        operation_id,
        model,
        dispatch_attempt_id,
        fence,
    )

    # Lazy import: the Temporal workflow sandbox rejects openai at module level.
    from openai import AsyncOpenAI

    if model.startswith(("doubao", "ark")):
        api_key = os.getenv("ARK_API_KEY")
        base_url = "https://ark.cn-beijing.volces.com/api/v3"
        provider = "doubao"
    else:
        api_key = os.getenv("DASHSCOPE_API_KEY")
        base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
        provider = "dashscope"
    if not api_key:
        raise ApplicationError(
            "provider_not_configured",
            type="provider_not_configured",
            non_retryable=True,
        )

    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    payload = json.loads(_read_content(org_id, input_ref).decode("utf-8"))
    goal = payload.get("goal") or ""
    background = payload.get("background") or ""
    prompt = f"{goal}\n\n{background}".strip() if background else goal
    heartbeat = asyncio.create_task(_heartbeat_loop(operation_id))
    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
            max_tokens=2000,
        )
    finally:
        heartbeat.cancel()
        try:
            await heartbeat
        except asyncio.CancelledError:
            pass

    usage = response.usage
    content = response.choices[0].message.content if response.choices else ""
    stored = _store_content(org_id, content or "")
    logger.info(
        "invoke_model done operation_id=%s request_id=%s", operation_id, response.id
    )
    return {
        "operation_id": operation_id,
        "provider": provider,
        "model": model,
        "provider_request_id": response.id,
        "media_type": "text/markdown",
        "usage": {
            "input_tokens": usage.prompt_tokens if usage else 0,
            "output_tokens": usage.completion_tokens if usage else 0,
            "cached_input_tokens": 0,
        },
        **stored,
    }


async def _heartbeat_loop(operation_id: str) -> None:
    while True:
        await asyncio.sleep(10)
        activity.heartbeat()
        logger.debug("heartbeat operation_id=%s", operation_id)


@activity.defn
async def finish_operation_activity(
    operation_id: str,
    org_id: str,
    outcome: str,
    provider_request_id: Optional[str] = None,
    receipt_ref: Optional[str] = None,
) -> None:
    logger.info("finish_operation operation_id=%s outcome=%s", operation_id, outcome)
    async with tenant_tx(org_id) as conn:
        await conn.execute(
            "SELECT work.finish_operation($1, $2, $3, $4, $5)",
            org_id,
            operation_id,
            outcome,
            provider_request_id,
            receipt_ref,
        )


@activity.defn
async def settle_quota_activity(  # noqa: PLR0913
    reservation_id: str,
    org_id: str,
    operation_id: str,
    subject_id: str,
    run_id: str,
    provider: str,
    model: str,
    usage: dict,
    settlement_revision: int = 1,
) -> dict:
    """Record usage, then settle, then re-read the Run in one transaction.

    ``record_usage`` treats an existing settle entry at the same revision as
    "already accounted" and would drop the row, so it must run first.  The Run
    state comes back with the settlement so the workflow can honour a cancel
    that landed while the provider call was in flight.
    """
    logger.info("settle_quota reservation_id=%s", reservation_id)
    input_tokens = int(usage.get("input_tokens") or 0)
    output_tokens = int(usage.get("output_tokens") or 0)
    cached_tokens = int(usage.get("cached_input_tokens") or 0)
    settled_tokens = input_tokens + output_tokens
    payload = {
        "provider": provider,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cached_input_tokens": cached_tokens,
    }
    async with tenant_tx(org_id, subject_id) as conn:
        await conn.execute(
            "SELECT work.record_usage($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)",
            org_id,
            subject_id,
            operation_id,
            provider,
            model,
            date.today(),
            input_tokens,
            output_tokens,
            cached_tokens,
        )
        await conn.execute(
            "SELECT work.settle_quota($1, $2, $3::jsonb, $4)",
            reservation_id,
            settled_tokens,
            json.dumps(payload, ensure_ascii=False),
            settlement_revision,
        )
        run_state = await conn.fetchval(
            "SELECT state FROM work.run WHERE id = $1 AND org_id = $2", run_id, org_id
        )
    return {"settled_tokens": settled_tokens, "run_state": run_state}


@activity.defn
async def publish_artifact_activity(  # noqa: PLR0913
    org_id: str,
    task_id: str,
    run_id: str,
    content_ref: str,
    content_hash: str,
    size: int,
    provenance: dict,
) -> dict:
    logger.info("publish_artifact run_id=%s", run_id)
    async with tenant_tx(org_id) as conn:
        row = await conn.fetchrow(
            "SELECT * FROM work.publish_artifact("
            "$1, $2, $3, 'draft.md', $4, $5, $6, 'text/markdown', $7::jsonb)",
            org_id,
            task_id,
            run_id,
            content_ref,
            content_hash,
            size,
            json.dumps(provenance, ensure_ascii=False),
        )
    return {
        "artifact_id": str(row["artifact_id"]),
        "version_no": row["version_no"],
        "content_ref": content_ref,
    }


@activity.defn
async def finish_run_activity(
    run_id: str, org_id: str, outcome: str, reason: Optional[str] = None
) -> None:
    logger.info("finish_run run_id=%s outcome=%s", run_id, outcome)
    async with tenant_tx(org_id) as conn:
        await conn.execute(
            "SELECT work.finish_run($1, $2, $3, $4)", run_id, org_id, outcome, reason
        )


@activity.defn
async def mark_operation_unknown_activity(
    operation_id: str, org_id: str, reason: str
) -> None:
    logger.info("mark_operation_unknown operation_id=%s reason=%s", operation_id, reason)
    async with tenant_tx(org_id) as conn:
        await conn.execute(
            "SELECT work.mark_operation_unknown($1, $2, $3)",
            org_id,
            operation_id,
            reason,
        )


@activity.defn
async def cancel_operation_activity(
    operation_id: str, org_id: str, actor_subject_id: str, reason: str
) -> None:
    """Cancel an operation; a dispatched one becomes ``unknown``, not canceled."""
    logger.info("cancel_operation operation_id=%s reason=%s", operation_id, reason)
    async with tenant_tx(org_id, actor_subject_id) as conn:
        await conn.execute(
            "SELECT work.cancel_operation($1, $2, $3, $4)",
            org_id,
            operation_id,
            actor_subject_id,
            reason,
        )


@activity.defn
async def wait_run_activity(run_id: str, org_id: str, reason: str) -> None:
    logger.info("wait_run run_id=%s reason=%s", run_id, reason)
    async with tenant_tx(org_id) as conn:
        await conn.execute(
            "SELECT work.wait_run($1, $2, $3)", org_id, run_id, reason
        )


@activity.defn
async def resume_run_activity(run_id: str, org_id: str) -> None:
    logger.info("resume_run run_id=%s", run_id)
    async with tenant_tx(org_id) as conn:
        await conn.execute("SELECT work.resume_run($1, $2)", org_id, run_id)


@activity.defn
async def reconcile_operation_activity(  # noqa: PLR0913
    operation_id: str,
    org_id: str,
    resolution: str,
    provider_request_id: Optional[str] = None,
    settled_tokens: int = 0,
    evidence_ref: Optional[str] = None,
) -> None:
    logger.info(
        "reconcile_operation operation_id=%s resolution=%s", operation_id, resolution
    )
    async with tenant_tx(org_id) as conn:
        await conn.execute(
            "SELECT work.reconcile_operation($1, $2, $3, $4, $5, $6)",
            org_id,
            operation_id,
            resolution,
            provider_request_id,
            settled_tokens,
            evidence_ref,
        )


# ============================================================================
# Workflow
# ============================================================================

DOMAIN_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=30),
    maximum_attempts=5,
    non_retryable_error_types=sorted(NON_RETRYABLE_CODES),
)
# Dispatch is single-shot: a retry would be a second billable provider call.
DISPATCH_RETRY = RetryPolicy(maximum_attempts=1)
DOMAIN_TIMEOUT = timedelta(minutes=5)
DISPATCH_TIMEOUT = timedelta(minutes=15)


@workflow.defn
class RunWorkflow:
    """D3 RunWorkflow: one model step, with the four cancel checkpoints."""

    def __init__(self) -> None:
        self._cancel_reason: Optional[str] = None
        self._step = "init"

    @workflow.signal
    def cancel(self, reason: str = "user_requested") -> None:
        self._cancel_reason = reason or "user_requested"

    @workflow.query
    def get_status(self) -> dict:
        return {
            "step": self._step,
            "cancel_requested": self._cancel_reason is not None,
        }

    async def _domain(self, fn, *args):
        return await workflow.execute_activity(
            fn,
            args=list(args),
            start_to_close_timeout=DOMAIN_TIMEOUT,
            retry_policy=DOMAIN_RETRY,
        )

    # D3 requires a distinct early return per cancel checkpoint plus the quota
    # and dispatch-lost branches; collapsing them would hide which one fired.
    @workflow.run
    async def run(self, run_id: str, task_id: str, org_id: str) -> dict:  # noqa: PLR0911
        self._step = "prepare"
        prepared = await self._domain(prepare_run_activity, run_id, org_id)
        owner = prepared["owner_subject_id"]

        # Checkpoint 1: cancel landed before start.  acquire_run returns the
        # current row without bumping the fence, so there is nothing to undo.
        self._step = "acquire"
        acquired = await self._domain(acquire_run_activity, run_id, org_id)
        if acquired["state"] != "active":
            if acquired["state"] == "cancel_requested":
                await self._domain(
                    finish_run_activity,
                    run_id,
                    org_id,
                    "canceled",
                    self._cancel_reason or "cancel_requested",
                )
                return {"run_id": run_id, "status": "canceled", "published": False}
            return {"run_id": run_id, "status": acquired["state"], "published": False}

        self._step = "create_operation"
        request_hash = _request_hash(run_id, LOGICAL_KEY)
        operation_id = await self._domain(
            create_model_operation_activity, run_id, org_id, LOGICAL_KEY, request_hash
        )

        self._step = "authorize"
        await self._domain(
            authorize_operation_activity, operation_id, org_id, POLICY_EPOCH
        )

        self._step = "reserve_quota"
        try:
            reservation = await self._domain(
                reserve_quota_activity, operation_id, org_id
            )
        except ApplicationError as error:
            if error.type not in ("quota_exhausted", "run_cap_exceeded"):
                raise
            # Park the Run; the operation stays authorized so a resume reuses
            # the same logical key instead of dispatching a second time.
            await self._domain(wait_run_activity, run_id, org_id, "quota")
            return {"run_id": run_id, "status": "waiting", "wait_reason": "quota"}

        # Checkpoint 2: no permit means a cancel landed or another worker took
        # over.  Either way this workflow must not call the provider.
        self._step = "claim_dispatch"
        claim = await self._domain(
            claim_dispatch_activity, operation_id, org_id, acquired["fence"]
        )
        if claim["dispatch_attempt_id"] is None:
            if claim["run_state"] != "cancel_requested":
                # A newer fence won the dispatch; that owner finishes the Run.
                return {
                    "run_id": run_id,
                    "status": "dispatch_not_won",
                    "published": False,
                }
            await self._domain(
                cancel_operation_activity,
                operation_id,
                org_id,
                owner,
                "cancel_requested",
            )
            await self._domain(
                finish_run_activity,
                run_id,
                org_id,
                "canceled",
                self._cancel_reason or "cancel_requested",
            )
            return {"run_id": run_id, "status": "canceled", "published": False}

        # Checkpoint 3: past the permit, the provider may already have charged
        # us.  Any failure becomes `unknown` for the reconciler, never `failed`.
        self._step = "invoke_model"
        try:
            model_result = await workflow.execute_activity(
                invoke_model_activity,
                args=[
                    run_id,
                    org_id,
                    operation_id,
                    prepared["model"],
                    prepared["input_ref"],
                    claim["dispatch_attempt_id"],
                    claim["fence"],
                    request_hash,
                ],
                start_to_close_timeout=DISPATCH_TIMEOUT,
                heartbeat_timeout=timedelta(seconds=30),
                retry_policy=DISPATCH_RETRY,
            )
        except asyncio.CancelledError:
            await self._unknown(run_id, org_id, operation_id, "workflow_canceled")
            raise
        except Exception:
            await self._unknown(run_id, org_id, operation_id, "dispatch_result_unknown")
            return {
                "run_id": run_id,
                "status": "waiting",
                "wait_reason": "reconcile",
                "published": False,
            }

        self._step = "finish_operation"
        await self._domain(
            finish_operation_activity,
            operation_id,
            org_id,
            "succeeded",
            model_result["provider_request_id"],
            model_result["content_ref"],
        )

        self._step = "settle_quota"
        settled = await self._domain(
            settle_quota_activity,
            reservation["reservation_id"],
            org_id,
            operation_id,
            owner,
            run_id,
            model_result["provider"],
            model_result["model"],
            model_result["usage"],
            1,
        )

        # Checkpoint 4: a cancel that landed during the provider call still
        # gets settled, but the artifact must not be published.
        if settled["run_state"] == "cancel_requested" or self._cancel_reason:
            await self._domain(
                finish_run_activity,
                run_id,
                org_id,
                "canceled",
                self._cancel_reason or "cancel_requested",
            )
            return {
                "run_id": run_id,
                "status": "canceled",
                "published": False,
                "settled_tokens": settled["settled_tokens"],
            }

        self._step = "publish_artifact"
        artifact = await self._domain(
            publish_artifact_activity,
            org_id,
            prepared["task_id"],
            run_id,
            model_result["content_ref"],
            model_result["content_hash"],
            model_result["bytes"],
            {"provider": model_result["provider"], "model": model_result["model"]},
        )

        self._step = "finish_run"
        await self._domain(
            finish_run_activity, run_id, org_id, "succeeded", "completed_normally"
        )
        self._step = "done"
        return {
            "run_id": run_id,
            "task_id": prepared["task_id"],
            "org_id": org_id,
            "status": "succeeded",
            "published": True,
            "artifact_id": artifact["artifact_id"],
            "version_no": artifact["version_no"],
            "settled_tokens": settled["settled_tokens"],
        }

    async def _unknown(
        self, run_id: str, org_id: str, operation_id: str, reason: str
    ) -> None:
        """Park a dispatched operation for the reconciler, keeping the hold."""
        self._step = "mark_unknown"
        await self._domain(
            mark_operation_unknown_activity, operation_id, org_id, reason
        )
        await self._domain(wait_run_activity, run_id, org_id, "reconcile")


# ============================================================================
# Main
# ============================================================================


async def main() -> None:
    temporal_address = os.environ.get(
        "TEMPORAL_ADDRESS", "temporal-server.work-staging.svc.cluster.local:7233"
    )
    namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")

    logger.info("connecting to temporal at %s namespace=%s", temporal_address, namespace)
    client = await Client.connect(temporal_address, namespace=namespace)
    await get_db_pool()

    worker = Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[RunWorkflow],
        activities=[
            prepare_run_activity,
            acquire_run_activity,
            create_model_operation_activity,
            authorize_operation_activity,
            reserve_quota_activity,
            claim_dispatch_activity,
            invoke_model_activity,
            finish_operation_activity,
            settle_quota_activity,
            publish_artifact_activity,
            finish_run_activity,
            mark_operation_unknown_activity,
            cancel_operation_activity,
            wait_run_activity,
            resume_run_activity,
            reconcile_operation_activity,
        ],
    )

    logger.info("worker listening on task queue %s with 16 activities", TASK_QUEUE)
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
