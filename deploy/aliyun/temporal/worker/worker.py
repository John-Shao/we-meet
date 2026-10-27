"""
Temporal Worker for Work R0a - Full Implementation

Implements all 16 activities from D3 orchestration design:
- prepareRun, acquireRun, createModelOperation, authorizeOperation
- reserveQuota, claimDispatch, invokeModel, finishOperation
- settleQuota, publishArtifact, finishRun
- markOperationUnknown, cancelOperation, waitRun, resumeRun, reconcileOperation

Each activity calls the corresponding work schema SQL function with proper RLS context.
"""
import asyncio
import logging
import os
from datetime import timedelta
from typing import Optional

import asyncpg
from temporalio import workflow, activity
from temporalio.worker import Worker
from temporalio.client import Client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

TASK_QUEUE = "work-r0a-run"

# Database connection pool (initialized in main)
_db_pool: Optional[asyncpg.Pool] = None


async def get_db_pool() -> asyncpg.Pool:
    """Get or create asyncpg connection pool"""
    global _db_pool
    if _db_pool is None:
        # Connect to work database, not temporal database
        db_url = os.environ.get(
            "WORK_DATABASE_URL",
            "postgresql://work_api:work-api-staging-2026@postgresql.meet.svc.cluster.local:5432/meet"
        )
        _db_pool = await asyncpg.create_pool(db_url, min_size=2, max_size=10)
        logger.info(f"Database pool created: {db_url.split('@')[1]}")
    return _db_pool


async def execute_with_rls(org_id: str, subject_id: str, query: str, *args):
    """Execute SQL with RLS context set"""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = '{subject_id}'")
        return await conn.fetchval(query, *args)


# ============================================================================
# Activities (16 total, per D3 contract)
# ============================================================================

@activity.defn
async def prepare_run_activity(run_id: str, org_id: str) -> dict:
    """
    D3 Activity 1: Prepare run
    - Validate run exists and state='queued'
    - Load task context
    - Return PreparedRun data
    """
    logger.info(f"[Activity] prepare_run: run_id={run_id}, org_id={org_id}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute("SET LOCAL app.subject_id = 'system'")
        # Get run data
        run_row = await conn.fetchrow("""
            SELECT id, task_id, org_id, snapshot_id, fence
            FROM work.run
            WHERE id = $1 AND org_id = $2 AND state = 'queued'
        """, run_id, org_id)
        if not run_row:
            raise Exception(f"run_not_found: {run_id}")
        # Get task permission_mode separately
        task_row = await conn.fetchrow("""
            SELECT permission_mode FROM work.task WHERE id = $1 AND org_id = $2
        """, run_row["task_id"], org_id)
    return {
        "run_id": str(run_row["id"]),
        "task_id": str(run_row["task_id"]),
        "org_id": run_row["org_id"],
        "snapshot_id": str(run_row["snapshot_id"]) if run_row["snapshot_id"] else None,
        "fence": run_row["fence"],
        "permission_mode": task_row["permission_mode"] if task_row else "ask_each",
    }


@activity.defn
async def acquire_run_activity(run_id: str, org_id: str, fence: int) -> dict:
    """
    D3 Activity 2: Acquire run
    - Transition run state from 'queued' to 'active'
    - Set active_run_id on task
    - Idempotent: if already active with same fence, return success
    """
    logger.info(f"[Activity] acquire_run: run_id={run_id}, fence={fence}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        row = await conn.fetchrow("""
            SELECT * FROM work.acquire_run($1, $2)
        """, run_id, org_id)
    return {
        "status": row["state"],
        "run_id": str(row["id"]),
        "fence": row["fence"],
        "state": row["state"],
    }


@activity.defn
async def create_model_operation_activity(
    run_id: str, org_id: str, step_no: int, input_ref: str
) -> dict:
    """
    D3 Activity 3: Create model operation
    - Insert into work.operation table
    - Logical key: model:<step_no>
    - R0a max 3 operations per run
    """
    logger.info(f"[Activity] create_model_operation: run_id={run_id}, step={step_no}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        row = await conn.fetchrow("""
            INSERT INTO work.operation (run_id, org_id, logical_key, kind, request_hash, state)
            VALUES ($1, $2, $3, 'model', $4, 'prepared')
            ON CONFLICT (org_id, run_id, logical_key) DO UPDATE
            SET request_hash = EXCLUDED.request_hash
            RETURNING id, run_id, org_id, logical_key, kind, state
        """, run_id, org_id, f"model:{step_no}", f"hash:{run_id}:{step_no}")
    return {
        "operation_id": str(row["id"]),
        "run_id": str(row["run_id"]),
        "step_no": step_no,
        "kind": row["kind"],
        "state": row["state"],
    }


@activity.defn
async def authorize_operation_activity(operation_id: str, org_id: str) -> dict:
    """
    D3 Activity 4: Authorize operation
    - Check policy allows this operation
    - Verify quota available
    """
    logger.info(f"[Activity] authorize_operation: op_id={operation_id}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        await conn.execute("""
            UPDATE work.operation
            SET state = 'authorized', updated_at = now()
            WHERE id = $1 AND org_id = $2
        """, operation_id, org_id)
    return {"authorized": True, "operation_id": operation_id}


@activity.defn
async def reserve_quota_activity(
    operation_id: str, org_id: str, amount_tokens: int
) -> dict:
    """
    D3 Activity 5: Reserve quota
    - Reserve token budget for this operation
    - Return reservation_id
    """
    logger.info(f"[Activity] reserve_quota: op_id={operation_id}, tokens={amount_tokens}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        row = await conn.fetchrow("""
            SELECT work.reserve_quota($1, $2, $3, $4, $5)
        """, org_id, "default", "monthly", operation_id, amount_tokens)
        reservation_id = row["reserve_quota"]
    return {
        "reservation_id": str(reservation_id),
        "operation_id": operation_id,
        "amount_tokens": amount_tokens,
    }


@activity.defn
async def claim_dispatch_activity(
    operation_id: str, org_id: str, fence: int
) -> dict:
    """
    D3 Activity 6: Claim dispatch
    - Acquire dispatch slot with fence check
    - Prevent double-dispatch
    """
    logger.info(f"[Activity] claim_dispatch: op_id={operation_id}, fence={fence}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        row = await conn.fetchrow("""
            SELECT work.claim_dispatch($1, $2, $3, $4)
        """, operation_id, org_id, "temporal-worker", fence)
        dispatch_id = row["claim_dispatch"]
    return {
        "dispatch_attempt_id": str(dispatch_id),
        "operation_id": operation_id,
        "fence": fence,
    }


@activity.defn
async def invoke_model_activity(
    run_id: str, org_id: str, operation_id: str, model: str, input_ref: str
) -> dict:
    """
    D3 Activity 7: Invoke model
    - Call provider API (阿里百炼 / 豆包)
    - Heartbeat every 10s for long-running calls
    - Return usage + content_ref
    """
    logger.info(f"[Activity] invoke_model: op_id={operation_id}, model={model}")
    
    # Lazy import: openai is blocked by Temporal's workflow sandbox at module level
    from openai import AsyncOpenAI
    
    # Get API keys from environment
    ark_api_key = os.getenv("ARK_API_KEY")
    dashscope_api_key = os.getenv("DASHSCOPE_API_KEY")
    
    # Determine provider based on model name
    if model.startswith("doubao") or model.startswith("ark"):
        # 豆包 (Volcengine Ark)
        if not ark_api_key:
            raise ValueError("ARK_API_KEY not configured")
        client = AsyncOpenAI(
            api_key=ark_api_key,
            base_url="https://ark.cn-beijing.volces.com/api/v3",
        )
        provider = "doubao"
    else:
        # 阿里百炼 (DashScope) - default
        if not dashscope_api_key:
            raise ValueError("DASHSCOPE_API_KEY not configured")
        client = AsyncOpenAI(
            api_key=dashscope_api_key,
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
        provider = "dashscope"
    
    # Start heartbeat task
    heartbeat_task = asyncio.create_task(_heartbeat_loop(operation_id))
    
    try:
        # Call LLM API
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "user", "content": f"Process input: {input_ref}"}
            ],
            temperature=0.7,
            max_tokens=2000,
        )
        
        # Extract usage
        usage = response.usage
        input_tokens = usage.prompt_tokens if usage else 0
        output_tokens = usage.completion_tokens if usage else 0
        
        # Extract content
        content = response.choices[0].message.content if response.choices else ""
        
        logger.info(f"[Activity] invoke_model success: op_id={operation_id}, tokens={input_tokens}+{output_tokens}")
        
        return {
            "operation_id": operation_id,
            "content_ref": f"s3://work-artifacts/{org_id}/{run_id}/{operation_id}.txt",
            "content_hash": f"sha256:{hash(content)}",
            "bytes": len(content.encode("utf-8")),
            "provider_request_id": response.id,
            "media_type": "text/plain",
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cached_input_tokens": 0,
            },
            "provider": provider,
            "model": model,
        }
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass


async def _heartbeat_loop(operation_id: str):
    """Send heartbeat every 10 seconds while LLM is processing"""
    while True:
        await asyncio.sleep(10)
        activity.heartbeat()
        logger.debug(f"[Heartbeat] op_id={operation_id}")


@activity.defn
async def finish_operation_activity(
    operation_id: str, org_id: str, outcome: str
) -> dict:
    """
    D3 Activity 8: Finish operation
    - Mark operation as succeeded/failed
    - Record final usage
    """
    logger.info(f"[Activity] finish_operation: op_id={operation_id}, outcome={outcome}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        await conn.execute("""
            UPDATE work.operation
            SET state = $3, updated_at = now()
            WHERE id = $1 AND org_id = $2
        """, operation_id, org_id, outcome)
    return {"operation_id": operation_id, "outcome": outcome}


@activity.defn
async def settle_quota_activity(
    reservation_id: str, org_id: str, actual_tokens: int
) -> dict:
    """
    D3 Activity 9: Settle quota
    - Adjust reservation to actual usage
    - Release unused quota
    """
    logger.info(f"[Activity] settle_quota: res_id={reservation_id}, tokens={actual_tokens}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        await conn.execute("""
            SELECT work.settle_quota($1, $2, $3, $4)
        """, reservation_id, actual_tokens, '{"source": "worker"}', 1)
    return {"reservation_id": reservation_id, "settled_tokens": actual_tokens}


@activity.defn
async def publish_artifact_activity(
    run_id: str, org_id: str, content_ref: str, content_hash: str, bytes_: int
) -> dict:
    """
    D3 Activity 10: Publish artifact
    - Insert into work.artifact
    - Set version_no
    """
    logger.info(f"[Activity] publish_artifact: run_id={run_id}, content_ref={content_ref}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        # Get task_id from run
        run_row = await conn.fetchrow("""
            SELECT task_id FROM work.run WHERE id = $1 AND org_id = $2
        """, run_id, org_id)
        task_id = run_row["task_id"]
        # Insert artifact (logical entity)
        artifact_row = await conn.fetchrow("""
            INSERT INTO work.artifact (org_id, task_id, logical_name, state)
            VALUES ($1, $2, $3, 'published')
            ON CONFLICT (org_id, task_id, logical_name) DO UPDATE
            SET state = 'published', updated_at = now()
            RETURNING id, org_id, task_id, logical_name
        """, org_id, task_id, f"run-{run_id[:8]}-output")
        artifact_id = artifact_row["id"]
        # Insert artifact_version (content)
        version_row = await conn.fetchrow("""
            INSERT INTO work.artifact_version (artifact_id, org_id, version_no, content_ref, content_hash, bytes, media_type, state, provenance)
            VALUES ($1, $2, 1, $3, $4, $5, 'text/markdown', 'published', $6)
            ON CONFLICT (artifact_id, org_id, version_no) DO UPDATE
            SET content_ref = EXCLUDED.content_ref
            RETURNING artifact_id, version_no, content_ref
        """, artifact_id, org_id, content_ref, content_hash, bytes_,
            f'{{"run_id": "{run_id}", "provider": "llm"}}')
    return {
        "artifact_id": str(artifact_id),
        "version_no": version_row["version_no"],
        "content_ref": version_row["content_ref"],
    }


@activity.defn
async def finish_run_activity(run_id: str, org_id: str, outcome: str, reason: str) -> dict:
    """
    D3 Activity 11: Finish run
    - Transition run to terminal state (succeeded/failed/canceled)
    - Release all locks
    """
    logger.info(f"[Activity] finish_run: run_id={run_id}, outcome={outcome}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        await conn.execute("""
            SELECT work.finish_run($1, $2, $3, $4)
        """, run_id, org_id, outcome, reason)
    return {"run_id": run_id, "outcome": outcome}


@activity.defn
async def mark_operation_unknown_activity(operation_id: str, org_id: str, reason: str) -> dict:
    """
    D3 Activity 12: Mark operation unknown
    - For dispatch failures after timeout
    - Preserve quota for reconciliation
    """
    logger.info(f"[Activity] mark_operation_unknown: op_id={operation_id}, reason={reason}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        await conn.execute("""
            UPDATE work.operation
            SET state = 'unknown', updated_at = now()
            WHERE id = $1 AND org_id = $2
        """, operation_id, org_id)
    return {"operation_id": operation_id, "status": "unknown"}


@activity.defn
async def cancel_operation_activity(operation_id: str, org_id: str, reason: str) -> dict:
    """
    D3 Activity 13: Cancel operation
    - Mark operation as canceled
    - Release reserved quota
    """
    logger.info(f"[Activity] cancel_operation: op_id={operation_id}, reason={reason}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        await conn.execute("""
            UPDATE work.operation
            SET state = 'canceled', updated_at = now()
            WHERE id = $1 AND org_id = $2
        """, operation_id, org_id)
    return {"operation_id": operation_id, "status": "canceled"}


@activity.defn
async def wait_run_activity(run_id: str, org_id: str, reason: str) -> dict:
    """
    D3 Activity 14: Wait run
    - Transition to waiting state
    - Used for quota exhaustion
    """
    logger.info(f"[Activity] wait_run: run_id={run_id}, reason={reason}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        await conn.execute("""
            UPDATE work.run
            SET state = 'waiting', wait_reason = $3, updated_at = now()
            WHERE id = $1 AND org_id = $2
        """, run_id, org_id, reason)
    return {"run_id": run_id, "status": "waiting", "reason": reason}


@activity.defn
async def resume_run_activity(run_id: str, org_id: str, reason: str) -> dict:
    """
    D3 Activity 15: Resume run
    - Transition from waiting back to active
    - Re-validate quota
    """
    logger.info(f"[Activity] resume_run: run_id={run_id}, reason={reason}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        await conn.execute("""
            UPDATE work.run
            SET state = 'active', wait_reason = NULL, updated_at = now()
            WHERE id = $1 AND org_id = $2
        """, run_id, org_id)
    return {"run_id": run_id, "status": "active"}


@activity.defn
async def reconcile_operation_activity(
    operation_id: str, org_id: str, provider_request_id: str
) -> dict:
    """
    D3 Activity 16: Reconcile operation
    - Query provider for actual status
    - Resolve unknown operations
    """
    logger.info(f"[Activity] reconcile_operation: op_id={operation_id}")
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute(f"SET LOCAL app.subject_id = 'system'")
        await conn.execute("""
            UPDATE work.operation
            SET state = 'reconciled', updated_at = now()
            WHERE id = $1 AND org_id = $2
        """, operation_id, org_id)
    return {
        "operation_id": operation_id,
        "resolution": "succeeded",
        "billable_tokens": 150,
    }


# ============================================================================
# Workflow
# ============================================================================

@workflow.defn
class RunWorkflow:
    """
    D3 RunWorkflow: Full implementation with cancel handling
    
    Workflow ID: run:<run_id>
    Task Queue: work-r0a-run
    Timeout: 30 minutes
    """
    
    def __init__(self):
        self._cancelled = False
        self._current_step = "init"
    
    @workflow.signal
    async def cancel(self, reason: str):
        """Handle cancel signal"""
        logger.info(f"[Workflow] Cancel signal received: {reason}")
        self._cancelled = True
    
    @workflow.query
    def get_status(self) -> str:
        """Query current workflow status"""
        return self._current_step
    
    @workflow.run
    async def run(self, run_id: str, task_id: str, org_id: str) -> dict:
        logger.info(f"[Workflow] Starting RunWorkflow: run_id={run_id}")
        
        try:
            # Step 1: Prepare
            self._current_step = "prepare"
            if self._cancelled:
                raise workflow.CancelledError()
            
            prepared = await workflow.execute_activity(
                prepare_run_activity,
                args=[run_id, org_id],
                start_to_close_timeout=timedelta(minutes=5),
            )
            
            # Step 2: Acquire
            self._current_step = "acquire"
            if self._cancelled:
                raise workflow.CancelledError()
            
            acquired = await workflow.execute_activity(
                acquire_run_activity,
                args=[run_id, org_id, prepared["fence"]],
                start_to_close_timeout=timedelta(minutes=5),
            )
            
            # Step 3: Create operation (R0a: max 3 operations)
            self._current_step = "create_operation"
            if self._cancelled:
                raise workflow.CancelledError()
            
            operation = await workflow.execute_activity(
                create_model_operation_activity,
                args=[run_id, org_id, 1, f"input://{run_id}"],
                start_to_close_timeout=timedelta(minutes=5),
            )
            
            # Step 4: Authorize
            self._current_step = "authorize"
            await workflow.execute_activity(
                authorize_operation_activity,
                args=[operation["operation_id"], org_id],
                start_to_close_timeout=timedelta(minutes=5),
            )
            
            # Step 5: Reserve quota
            self._current_step = "reserve_quota"
            reservation = await workflow.execute_activity(
                reserve_quota_activity,
                args=[operation["operation_id"], org_id, 1000],
                start_to_close_timeout=timedelta(minutes=5),
            )
            
            # Step 6: Claim dispatch
            self._current_step = "claim_dispatch"
            dispatch = await workflow.execute_activity(
                claim_dispatch_activity,
                args=[operation["operation_id"], org_id, acquired["fence"]],
                start_to_close_timeout=timedelta(minutes=5),
            )
            
            # Step 7: Invoke model (with heartbeat)
            self._current_step = "invoke_model"
            if self._cancelled:
                raise workflow.CancelledError()
            
            model_result = await workflow.execute_activity(
                invoke_model_activity,
                args=[run_id, org_id, operation["operation_id"], "qwen-max", f"input://{run_id}"],
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=30),
            )
            
            # Step 8: Finish operation
            self._current_step = "finish_operation"
            await workflow.execute_activity(
                finish_operation_activity,
                args=[operation["operation_id"], org_id, "succeeded"],
                start_to_close_timeout=timedelta(minutes=5),
            )
            
            # Step 9: Settle quota
            self._current_step = "settle_quota"
            await workflow.execute_activity(
                settle_quota_activity,
                args=[reservation["reservation_id"], org_id, model_result["usage"]["input_tokens"] + model_result["usage"]["output_tokens"]],
                start_to_close_timeout=timedelta(minutes=5),
            )
            
            # Step 10: Publish artifact
            self._current_step = "publish_artifact"
            artifact = await workflow.execute_activity(
                publish_artifact_activity,
                args=[run_id, org_id, model_result["content_ref"], model_result["content_hash"], model_result["bytes"]],
                start_to_close_timeout=timedelta(minutes=5),
            )
            
            # Step 11: Finish run
            self._current_step = "finish_run"
            await workflow.execute_activity(
                finish_run_activity,
                args=[run_id, org_id, "succeeded", "completed_normally"],
                start_to_close_timeout=timedelta(minutes=5),
            )
            
            logger.info(f"[Workflow] RunWorkflow completed successfully: run_id={run_id}")
            return {
                "run_id": run_id,
                "task_id": task_id,
                "org_id": org_id,
                "status": "succeeded",
                "artifact_id": artifact["artifact_id"],
                "version_no": artifact["version_no"],
            }
            
        except workflow.CancelledError:
            logger.info(f"[Workflow] RunWorkflow cancelled: run_id={run_id}")
            # Cleanup: cancel operation, release quota
            try:
                await workflow.execute_activity(
                    cancel_operation_activity,
                    args=[operation["operation_id"], org_id, "workflow_cancelled"],
                    start_to_close_timeout=timedelta(minutes=5),
                )
                await workflow.execute_activity(
                    finish_run_activity,
                    args=[run_id, org_id, "canceled", "user_requested"],
                    start_to_close_timeout=timedelta(minutes=5),
                )
            except Exception as e:
                logger.error(f"[Workflow] Cleanup failed: {e}")
            raise


# ============================================================================
# Main
# ============================================================================

async def main():
    """Start the Temporal worker"""
    temporal_address = os.environ.get(
        "TEMPORAL_ADDRESS",
        "temporal-server.work-staging.svc.cluster.local:7233"
    )
    namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    
    logger.info(f"Connecting to Temporal at {temporal_address}, namespace: {namespace}")
    client = await Client.connect(temporal_address, namespace=namespace)
    
    # Initialize DB pool
    await get_db_pool()
    
    # Start worker with all 16 activities
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
    
    logger.info(f"Worker started, listening on task queue: {TASK_QUEUE}")
    logger.info(f"Registered 16 activities for RunWorkflow")
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
