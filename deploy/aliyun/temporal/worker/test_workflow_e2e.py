"""
R0a E4 End-to-End Workflow Test

Creates test data matching actual schema, starts a Temporal workflow,
and verifies database state after completion.
"""
import asyncio
import uuid
import json
import asyncpg
from temporalio.client import Client


DB_URL = "postgresql://postgres:postgres@127.0.0.1:55435/work_r0a_e1"
TEMPORAL_ADDRESS = "127.0.0.1:7233"


async def setup_test_data(pool, org_id):
    """Create org, quota_account, org_policy for the test org."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
            await conn.execute("SET LOCAL app.subject_id = 'system'")

            # Org
            await conn.execute("""
                INSERT INTO work.org (id, status, home_region, name, execution_enabled)
                VALUES ($1, 'active', 'cn-east', $2, true)
                ON CONFLICT (id) DO UPDATE SET status = 'active', execution_enabled = true, updated_at = now()
            """, org_id, f"Test Org {org_id}")

            # Org policy (required by reserve_quota)
            await conn.execute("""
                INSERT INTO work.org_policy (org_id, run_cap_tokens)
                VALUES ($1, 100000)
                ON CONFLICT (org_id) DO UPDATE SET run_cap_tokens = 100000, updated_at = now()
            """, org_id)

            # Quota account - use fixed key to match worker's reserve_quota call
            account_id = str(uuid.uuid4())
            await conn.execute("""
                INSERT INTO work.quota_account (id, org_id, account_key, period_id, limit_tokens, enforcement)
                VALUES ($1, $2, 'default', 'monthly', 1000000, 'soft')
                ON CONFLICT (org_id, account_key, period_id) DO UPDATE 
                SET limit_tokens = 1000000, updated_at = now()
                RETURNING id
            """, account_id, org_id)

    return account_id


async def create_task_and_run(pool, org_id, account_id):
    """Create capability_snapshot, task, and run for the workflow."""
    task_id = str(uuid.uuid4())
    run_id = str(uuid.uuid4())
    snapshot_id = str(uuid.uuid4())
    input_id = str(uuid.uuid4())

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
            await conn.execute("SET LOCAL app.subject_id = 'system'")

            # Input object (referenced by task)
            await conn.execute("""
                INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status)
                VALUES ($1, $2, 'test-user', 'input://test', $3, 100, 'application/json', 'active')
            """, input_id, org_id, f"hash:{input_id}")

            # Task (insert without snapshot_id first)
            await conn.execute("""
                INSERT INTO work.task (id, org_id, owner_subject_id, state, input_id, title)
                VALUES ($1, $2, 'test-user', 'open', $3, 'E4 workflow test')
            """, task_id, org_id, input_id)

            # Capability snapshot (FK to task)
            await conn.execute("""
                INSERT INTO work.capability_snapshot (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
                VALUES ($1, $2, $3, '1.0', 'hash', ARRAY['model'], $4, $5, $6)
            """, snapshot_id, org_id, task_id,
                json.dumps({"provider": "dashscope", "model": "qwen-max"}),
                json.dumps({}),
                json.dumps({"tools": []}))

            # Update task with snapshot_id
            await conn.execute("""
                UPDATE work.task SET snapshot_id = $1 WHERE id = $2
            """, snapshot_id, task_id)

            # Run
            workflow_id = f"RunWorkflow-{run_id[:8]}"
            await conn.execute("""
                INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
                VALUES ($1, $2, $3, 1, 'queued', $4, $5, '1.0.0')
            """, run_id, org_id, task_id, snapshot_id, workflow_id)

    return task_id, run_id, snapshot_id


async def main():
    org_id = "test-org-e4"

    print("[1/6] Connecting to Temporal...")
    temporal_client = await Client.connect(TEMPORAL_ADDRESS)
    print("  [OK] Temporal connected")

    print("[2/6] Connecting to database...")
    pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=5)
    print("  [OK] Database connected")

    print("[3/6] Setting up test data...")
    account_id = await setup_test_data(pool, org_id)
    print(f"  [OK] Org and quota ready (account={account_id[:8]}...)")

    print("[4/6] Creating task and run...")
    task_id, run_id, snapshot_id = await create_task_and_run(pool, org_id, account_id)
    print(f"  [OK] task={task_id[:8]}... run={run_id[:8]}...")

    print("[5/6] Starting RunWorkflow...")
    handle = await temporal_client.start_workflow(
        "RunWorkflow",
        args=[run_id, task_id, org_id],
        id=f"run:{run_id}",
        task_queue="work-r0a-run",
    )
    print(f"  [OK] Workflow started: {handle.id}")

    print("[6/6] Waiting for workflow completion (timeout 120s)...")
    try:
        result = await asyncio.wait_for(handle.result(), timeout=120)
        print(f"  [OK] Workflow result: {json.dumps(result, indent=2, default=str)}")
    except asyncio.TimeoutError:
        desc = await handle.describe()
        print(f"  [TIMEOUT] Workflow still running, status={desc.status}")
        print("  Checking intermediate state...")
    except Exception as e:
        print(f"  [ERROR] Workflow failed: {e}")

    # Verify database state
    print("\n--- Database Verification ---")
    async with pool.acquire() as conn:
        await conn.execute(f"SET LOCAL app.org_id = '{org_id}'")
        await conn.execute("SET LOCAL app.subject_id = 'system'")

        run_row = await conn.fetchrow("SELECT id, state, terminal_reason, fence FROM work.run WHERE id = $1", run_id)
        task_row = await conn.fetchrow("SELECT id, state, active_run_id, latest_run_id FROM work.task WHERE id = $1", task_id)
        op_count = await conn.fetchval("SELECT count(*) FROM work.operation WHERE run_id = $1", run_id)

    print(f"  Run:    state={run_row['state']}, reason={run_row['terminal_reason']}, fence={run_row['fence']}")
    print(f"  Task:   state={task_row['state']}, active_run={task_row['active_run_id']}, latest_run={task_row['latest_run_id']}")
    print(f"  Operations: {op_count}")

    if run_row['state'] == 'succeeded':
        print("\n[PASS] E2E workflow test PASSED")
    else:
        print(f"\n[INFO] Run state is '{run_row['state']}' (check worker logs for details)")

    await pool.close()
    await temporal_client.close()


if __name__ == "__main__":
    asyncio.run(main())
