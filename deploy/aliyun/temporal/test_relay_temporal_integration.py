#!/usr/bin/env python
"""
Integration test: outbox relay → Temporal workflow.

This script verifies that the outbox relay can dispatch start_workflow events
to Temporal and start workflows.

Usage:
    python test_relay_temporal_integration.py

Prerequisites:
    - PostgreSQL with work schema (staging or local)
    - Temporal server running
    - Django settings configured
"""
import os
import sys
import django
import uuid
import logging

# Setup Django
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "meet.settings")
sys.path.insert(0, "/app/src/backend")
django.setup()

from django.conf import settings
from work.api.context import role_cursor
from work.jobs.outbox_relay import run_once

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


def create_test_task_and_run():
    """Create a test task and run, returning (org_id, task_id, run_id, workflow_id)."""
    org_id = "test-org-001"
    subject_id = "test-user-001"
    task_id = str(uuid.uuid4())
    run_id = str(uuid.uuid4())
    workflow_id = f"run:{run_id}"
    
    logger.info(f"Creating test task: org={org_id}, task={task_id}, run={run_id}")
    
    # Insert test task
    with role_cursor(org_id, "work_api") as cursor:
        cursor.execute("""
            INSERT INTO work.task (id, org_id, owner_subject_id, title, permission_mode, revision)
            VALUES (%s, %s, %s, 'Test task for relay integration', 'auto', 1)
            ON CONFLICT (id) DO NOTHING
        """, [task_id, org_id, subject_id])
    
    # Insert test run
    with role_cursor(org_id, "work_api") as cursor:
        cursor.execute("""
            INSERT INTO work.run (id, org_id, task_id, state, active_operation_id)
            VALUES (%s, %s, %s, 'queued', NULL)
            ON CONFLICT (id) DO NOTHING
        """, [run_id, org_id, task_id])
    
    # Insert start_workflow event into outbox
    with role_cursor(org_id, "work_api") as cursor:
        cursor.execute("""
            INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
            VALUES (%s, 'run', %s, gen_random_uuid(), %s)
        """, [
            org_id,
            run_id,
            json.dumps({
                "kind": "start_workflow",
                "run_id": run_id,
                "workflow_id": workflow_id,
            })
        ])
    
    logger.info(f"Created outbox event for workflow {workflow_id}")
    return org_id, task_id, run_id, workflow_id


def verify_workflow_started(workflow_id: str) -> bool:
    """Check if workflow was started in Temporal."""
    import asyncio
    from work.orchestration.temporal_client import get_temporal_client
    
    tc = get_temporal_client()
    try:
        status = asyncio.run(tc.get_workflow_status(workflow_id))
        logger.info(f"Workflow {workflow_id} status: {status}")
        return True
    except Exception as e:
        logger.error(f"Failed to query workflow: {e}")
        return False


def main():
    logger.info("=" * 60)
    logger.info("Outbox Relay → Temporal Integration Test")
    logger.info("=" * 60)
    
    # Check Temporal connection
    logger.info("\n1. Checking Temporal connection...")
    from work.orchestration.temporal_client import get_temporal_client
    tc = get_temporal_client()
    try:
        asyncio.run(tc.connect())
        logger.info("✓ Temporal connection OK")
    except Exception as e:
        logger.error(f"✗ Temporal connection failed: {e}")
        sys.exit(1)
    
    # Create test data
    logger.info("\n2. Creating test task and run...")
    org_id, task_id, run_id, workflow_id = create_test_task_and_run()
    logger.info(f"✓ Test data created: workflow_id={workflow_id}")
    
    # Run relay
    logger.info("\n3. Running outbox relay...")
    result = run_once(relay_id="test-relay", limit=10)
    logger.info(f"✓ Relay result: {result}")
    
    if result["failed"] > 0:
        logger.error(f"✗ Relay failed {result['failed']} events")
        sys.exit(1)
    
    # Verify workflow started
    logger.info("\n4. Verifying workflow started in Temporal...")
    import time
    time.sleep(2)  # Give Temporal time to process
    
    if verify_workflow_started(workflow_id):
        logger.info("✓ Workflow started successfully")
    else:
        logger.error("✗ Workflow not found in Temporal")
        sys.exit(1)
    
    logger.info("\n" + "=" * 60)
    logger.info("✓ ALL TESTS PASSED")
    logger.info("=" * 60)
    logger.info("\nOutbox relay → Temporal integration is working:")
    logger.info("  - Outbox event created")
    logger.info("  - Relay claimed and delivered event")
    logger.info("  - Temporal workflow started")


if __name__ == "__main__":
    import json
    import asyncio
    main()
