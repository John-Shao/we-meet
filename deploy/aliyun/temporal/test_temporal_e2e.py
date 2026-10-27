#!/usr/bin/env python
"""
End-to-end validation script for Temporal integration.

Tests:
1. Connect to Temporal server
2. Start a simple workflow
3. Wait for completion
4. Verify result

Usage:
    python test_temporal_e2e.py

Environment:
    TEMPORAL_ADDRESS: Temporal server address (default: temporal-server.work-staging.svc.cluster.local:7233)
    TEMPORAL_NAMESPACE: Temporal namespace (default: default)
"""
import asyncio
import sys
import logging
from datetime import timedelta

from temporalio import workflow, activity
from temporalio.client import Client
from temporalio.worker import Worker

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

TASK_QUEUE = "test-queue-e2e"


@activity.defn
async def test_activity(message: str) -> str:
    logger.info(f"Activity executing with message: {message}")
    await asyncio.sleep(1)
    return f"Processed: {message}"


@workflow.defn
class TestWorkflow:
    @workflow.run
    async def run(self, message: str) -> str:
        logger.info(f"Workflow started with message: {message}")
        result = await workflow.execute_activity(
            test_activity,
            message,
            start_to_close_timeout=timedelta(seconds=10),
        )
        logger.info(f"Workflow completed with result: {result}")
        return result


async def test_temporal_connection():
    logger.info("=" * 60)
    logger.info("Test 1: Connecting to Temporal server...")
    logger.info("=" * 60)

    address = "temporal-server.work-staging.svc.cluster.local:7233"
    namespace = "default"

    try:
        client = await Client.connect(address, namespace=namespace)
        logger.info(f"Connected to Temporal at {address}, namespace: {namespace}")
        logger.info("Connection verified")
        return client
    except Exception as e:
        logger.error(f"Failed to connect to Temporal: {e}")
        return None


async def test_workflow_execution(client):
    logger.info("")
    logger.info("=" * 60)
    logger.info("Test 2: Starting workflow execution...")
    logger.info("=" * 60)

    worker = Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[TestWorkflow],
        activities=[test_activity],
    )

    logger.info(f"Starting worker on task queue: {TASK_QUEUE}")
    worker_task = asyncio.create_task(worker.run())
    await asyncio.sleep(2)

    try:
        workflow_id = "test-workflow-e2e-001"
        logger.info(f"Starting workflow: {workflow_id}")

        handle = await client.start_workflow(
            TestWorkflow,
            args=["Hello from E2E test"],
            id=workflow_id,
            task_queue=TASK_QUEUE,
        )

        logger.info(f"Workflow started: {handle.id}")
        logger.info("Waiting for workflow to complete...")
        result = await handle.result()

        logger.info(f"Workflow completed with result: {result}")

        if result == "Processed: Hello from E2E test":
            logger.info("Result matches expected value")
            return True
        else:
            logger.error(f"Result does not match expected value: {result}")
            return False

    except Exception as e:
        logger.error(f"Workflow execution failed: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        logger.info("Stopping worker...")
        worker_task.cancel()
        try:
            await worker_task
        except asyncio.CancelledError:
            pass
        logger.info("Worker stopped")


async def main():
    logger.info("")
    logger.info("Temporal E2E Validation Tests")
    logger.info("=" * 60)
    logger.info("")

    client = await test_temporal_connection()
    if client is None:
        logger.error("Connection test failed. Aborting.")
        sys.exit(1)

    success = await test_workflow_execution(client)

    logger.info("")
    logger.info("=" * 60)
    if success:
        logger.info("ALL TESTS PASSED")
        logger.info("=" * 60)
        logger.info("")
        logger.info("Temporal integration is working correctly:")
        logger.info("  - Connection to server: OK")
        logger.info("  - Workflow execution: OK")
        logger.info("  - Activity execution: OK")
        logger.info("  - Result verification: OK")
        sys.exit(0)
    else:
        logger.error("SOME TESTS FAILED")
        logger.error("=" * 60)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
