"""
Real Temporal client for Work R0a orchestration.

Replaces the mock/local workflow runner with actual Temporal server connection.
Connects to self-hosted Temporal and executes RunWorkflow.
"""

import asyncio
import logging
from datetime import timedelta
from typing import Optional

from django.conf import settings

from temporalio import client, workflow
from temporalio.client import Client, WorkflowExecutionStatus, WorkflowHandle

logger = logging.getLogger(__name__)

# Task queue name (matches D3 design)
TASK_QUEUE = "work-r0a-run"


class TemporalClient:
    """
    Wrapper around Temporal client for Work R0a workflows.

    Provides methods to start, cancel, and query workflows.
    Connects to self-hosted Temporal server.
    """

    def __init__(
        self,
        target: str,
        namespace: str = "default",
        api_key: Optional[str] = None,
        tls: bool = False,
    ):
        """
        Initialize Temporal client.

        Args:
            target: Temporal server address (host:port)
            namespace: Temporal namespace (default: "default")
            api_key: Optional API key for authentication
            tls: Whether to use TLS (default: False for internal network)
        """
        self.target = target
        self.namespace = namespace
        self.api_key = api_key
        self.tls = tls
        self._client: Optional[Client] = None

    async def connect(self) -> Client:
        """
        Connect to Temporal server.

        Returns:
            Temporal Client instance
        """
        if self._client is None:
            logger.info(
                f"Connecting to Temporal at {self.target}, namespace: {self.namespace}"
            )

            # Build connection options
            connect_options = {
                "target_host": self.target,
                "namespace": self.namespace,
            }

            # Add API key if provided
            if self.api_key:
                connect_options["api_key"] = self.api_key

            # Add TLS if enabled
            if self.tls:
                connect_options["tls"] = True

            self._client = await Client.connect(**connect_options)
            logger.info("Connected to Temporal server")

        return self._client

    async def start_workflow(
        self,
        workflow_id: str,
        run_id: str,
        task_id: str,
        org_id: str,
        workflow_type: str = "RunWorkflow",
    ) -> WorkflowHandle:
        """
        Start a new workflow execution.

        Args:
            workflow_id: Unique workflow ID (format: run:<run_id>)
            run_id: Run ID from Work domain
            task_id: Task ID from Work domain
            org_id: Organization ID
            workflow_type: Workflow class name (default: "RunWorkflow")

        Returns:
            WorkflowHandle for the started workflow
        """
        client = await self.connect()

        logger.info(f"Starting workflow {workflow_id} for run {run_id}")

        # Start workflow with REJECT_DUPLICATE policy
        handle = await client.start_workflow(
            workflow_type,
            args=[run_id, task_id, org_id],
            id=workflow_id,
            task_queue=TASK_QUEUE,
            execution_timeout=timedelta(minutes=30),
            run_timeout=timedelta(minutes=30),
            task_timeout=timedelta(seconds=10),
            id_reuse_policy=client.WorkflowIDReusePolicy.REJECT_DUPLICATE,
        )

        logger.info(f"Workflow started: {handle.id}, run_id: {handle.result_run_id}")
        return handle

    async def cancel_workflow(self, workflow_id: str) -> None:
        """
        Cancel a running workflow.

        Args:
            workflow_id: Workflow ID to cancel
        """
        client = await self.connect()

        logger.info(f"Cancelling workflow {workflow_id}")

        handle = client.get_workflow_handle(workflow_id)
        await handle.cancel()

        logger.info(f"Workflow {workflow_id} cancelled")

    async def query_workflow(self, workflow_id: str, query_type: str, *args) -> any:
        """
        Query a workflow for its current state.

        Args:
            workflow_id: Workflow ID to query
            query_type: Query type name
            *args: Query arguments

        Returns:
            Query result
        """
        client = await self.connect()

        handle = client.get_workflow_handle(workflow_id)
        result = await handle.query(query_type, *args)

        return result

    async def get_workflow_status(self, workflow_id: str) -> WorkflowExecutionStatus:
        """
        Get the status of a workflow.

        Args:
            workflow_id: Workflow ID

        Returns:
            Workflow execution status
        """
        client = await self.connect()

        handle = client.get_workflow_handle(workflow_id)
        description = await handle.describe()

        return description.status

    async def signal_workflow(self, workflow_id: str, signal_name: str, *args) -> None:
        """
        Send a signal to a workflow.

        Args:
            workflow_id: Workflow ID
            signal_name: Signal name (e.g., "cancel", "resume", "quotaAvailable")
            *args: Signal arguments
        """
        client = await self.connect()

        logger.info(f"Sending signal {signal_name} to workflow {workflow_id}")

        handle = client.get_workflow_handle(workflow_id)
        await handle.signal(signal_name, *args)

        logger.info(f"Signal {signal_name} sent to workflow {workflow_id}")


# Singleton client instance (initialized from Django settings)
_temporal_client: Optional[TemporalClient] = None


def get_temporal_client() -> TemporalClient:
    """
    Get or create the singleton Temporal client.

    Reads configuration from Django settings:
    - TEMPORAL_ADDRESS: Server address (host:port)
    - TEMPORAL_NAMESPACE: Namespace (default: "default")
    - TEMPORAL_API_KEY: Optional API key
    - TEMPORAL_TLS: Whether to use TLS (default: False)

    Returns:
        TemporalClient instance
    """
    global _temporal_client  # noqa: PLW0603 - module-level Temporal client cache

    if _temporal_client is None:
        target = getattr(
            settings,
            "TEMPORAL_ADDRESS",
            "temporal-server.work-staging.svc.cluster.local:7233",
        )
        namespace = getattr(settings, "TEMPORAL_NAMESPACE", "default")
        api_key = getattr(settings, "TEMPORAL_API_KEY", None)
        tls = getattr(settings, "TEMPORAL_TLS", False)

        _temporal_client = TemporalClient(
            target=target,
            namespace=namespace,
            api_key=api_key,
            tls=tls,
        )

        logger.info(f"Initialized Temporal client: {target}, namespace: {namespace}")

    return _temporal_client
