"""
Temporal Worker for Work R0a
Executes workflows and activities from the work-r0a task queue
"""
import asyncio
import logging
from temporalio import workflow, activity
from temporalio.worker import Worker
from temporalio.client import Client
from datetime import timedelta

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Task queue name (matches D3 design)
TASK_QUEUE = "work-r0a-run"

@activity.defn
async def prepare_run_activity(run_id: str) -> dict:
    """Prepare a run - first activity in the workflow"""
    logger.info(f"Preparing run: {run_id}")
    return {"status": "prepared", "run_id": run_id}

@activity.defn
async def acquire_run_activity(run_id: str) -> dict:
    """Acquire a run - transition to active"""
    logger.info(f"Acquiring run: {run_id}")
    return {"status": "active", "run_id": run_id}

@activity.defn
async def invoke_model_activity(run_id: str, model: str) -> dict:
    """Invoke model - simulate LLM call"""
    logger.info(f"Invoking model {model} for run: {run_id}")
    await asyncio.sleep(1)  # Simulate work
    return {"status": "completed", "run_id": run_id, "model": model, "tokens": 100}

@activity.defn
async def finish_run_activity(run_id: str) -> dict:
    """Finish a run"""
    logger.info(f"Finishing run: {run_id}")
    return {"status": "completed", "run_id": run_id}

@workflow.defn
class RunWorkflow:
    """Main workflow for processing a run"""
    
    @workflow.run
    async def run(self, run_id: str, task_id: str, org_id: str) -> dict:
        logger.info(f"Starting RunWorkflow for run: {run_id}")
        
        # Set workflow timeout
        workflow.info().timeout = timedelta(minutes=30)
        
        # Step 1: Prepare
        prepare_result = await workflow.execute_activity(
            prepare_run_activity,
            run_id,
            start_to_close_timeout=timedelta(minutes=5)
        )
        
        # Step 2: Acquire
        acquire_result = await workflow.execute_activity(
            acquire_run_activity,
            run_id,
            start_to_close_timeout=timedelta(minutes=5)
        )
        
        # Step 3: Invoke model (simplified - R0a allows max 3 operations)
        model_result = await workflow.execute_activity(
            invoke_model_activity,
            args=[run_id, "qwen-max"],
            start_to_close_timeout=timedelta(minutes=15),
            heartbeat_timeout=timedelta(seconds=30)
        )
        
        # Step 4: Finish
        finish_result = await workflow.execute_activity(
            finish_run_activity,
            run_id,
            start_to_close_timeout=timedelta(minutes=5)
        )
        
        logger.info(f"RunWorkflow completed for run: {run_id}")
        return {
            "run_id": run_id,
            "task_id": task_id,
            "org_id": org_id,
            "status": "completed",
            "steps": [prepare_result, acquire_result, model_result, finish_result]
        }

async def main():
    """Main entry point - start the worker"""
    # Connect to Temporal server
    temporal_address = "temporal-server.work-staging.svc.cluster.local:7233"
    namespace = "default"  # Will create work-r0a namespace later
    
    logger.info(f"Connecting to Temporal at {temporal_address}, namespace: {namespace}")
    
    client = await Client.connect(temporal_address, namespace=namespace)
    
    # Start worker
    worker = Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[RunWorkflow],
        activities=[
            prepare_run_activity,
            acquire_run_activity,
            invoke_model_activity,
            finish_run_activity,
        ],
    )
    
    logger.info(f"Worker started, listening on task queue: {TASK_QUEUE}")
    await worker.run()

if __name__ == "__main__":
    asyncio.run(main())
