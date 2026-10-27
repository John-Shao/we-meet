"""E4/E5 contract tests: orchestration, jobs, content store, usage, gateway."""

import pytest

from work.content.contracts.content_store import ContentStoreError
from work.content.mock.local_filesystem import LocalFilesystemContentStore
from work.jobs.contracts import JOB_CONTRACTS
from work.orchestration.contracts.activities import ACTIVITY_NAMES, policy_for
from work.orchestration.contracts.run_workflow import (
    ACTIVITY_POLICIES,
    RunWorkflowInput,
    workflow_id_for_run,
)
from work.orchestration.mock.temporal_mock import TemporalMock
from work.runtime.contracts.usage_reconcile import (
    normalize_usage,
    reconcile_period,
    settle_operation,
)
from work.runtime.contracts.work_adapter import RunContext
from work.runtime.mock.model_gateway import FauxModelGateway
from work.runtime.mock.work_adapter import MockWorkAdapter


def test_run_workflow_contract_is_complete():
    assert len(ACTIVITY_NAMES) == 16
    assert set(ACTIVITY_POLICIES) == {str(name) for name in ACTIVITY_NAMES}
    assert policy_for("invokeModel").maximum_attempts == 1
    assert workflow_id_for_run("run-1") == "run:run-1"
    request = RunWorkflowInput(run_id="r", task_id="t", org_id="o")
    handle = TemporalMock().execute(request, lambda h: h.history.append("started"))
    assert handle.status.state == "active"
    assert handle.history == ["started"]


def test_six_background_job_contracts():
    assert set(JOB_CONTRACTS) == {
        "outbox_relay",
        "content_shredder",
        "directory_sync",
        "audit_export",
        "expiry_sweep",
        "dead_letter_ops",
    }
    for contract in JOB_CONTRACTS.values():
        assert contract.data_layer
        assert contract.stop_behavior
        assert contract.resume_behavior
        assert contract.idempotency_key


def test_content_store_isolated_by_org(tmp_path):
    store = LocalFilesystemContentStore(tmp_path)
    stored = store.put("org-a", b"hello", suffix=".md")
    assert stored.ref.startswith("content://org-a/")
    assert stored.bytes == 5
    assert store.get("org-a", stored.ref) == b"hello"
    with pytest.raises(ContentStoreError):
        store.get("org-b", stored.ref)
    with pytest.raises(ContentStoreError):
        store.get("org-a", "content://org-a/../escape")
    store.delete("org-a", stored.ref)
    with pytest.raises(ContentStoreError):
        store.get("org-a", stored.ref)


def test_usage_normalization_and_settlement_are_token_only():
    usage = {
        "prompt_tokens": 80,
        "completion_tokens": 110,
        "completion_tokens_details": {"reasoning_tokens": 77},
    }
    normalized = normalize_usage(usage)
    assert normalized.total == 190
    assert normalize_usage({"total_tokens": 5}) is None
    settled = settle_operation(reserved_tokens=1000, provider_usage=usage)
    assert settled["action"] == "settle"
    assert settled["settle_tokens"] == 190
    assert settled["flags"] == []
    unknown = settle_operation(reserved_tokens=1000, provider_usage=None)
    assert unknown["action"] == "hold_unknown"
    assert unknown["flags"] == ["usage_missing"]


def test_period_reconciliation_tolerance():
    ledger = [{"provider_request_id": "a", "amount_tokens": 5000}]
    assert reconcile_period(ledger=ledger, invoice=ledger)["status"] == "matched"
    small = reconcile_period(
        ledger=ledger,
        invoice=[{"provider_request_id": "a", "amount_tokens": 5050}],
    )
    assert small["status"] == "within_tolerance"
    assert small["allowed_tokens"] == 100
    large = reconcile_period(
        ledger=ledger,
        invoice=[{"provider_request_id": "b", "amount_tokens": 1}],
    )
    assert large["status"] == "adjustment_required"
    assert large["missing_in_ledger"] == ["b"]


def test_mock_work_adapter_returns_a_checkpoint(tmp_path, monkeypatch):
    monkeypatch.setenv("WORK_CONTENT_ROOT", str(tmp_path / "content"))
    adapter = MockWorkAdapter()
    checkpoints = adapter.run(
        RunContext(
            run_id="run-1",
            task_id="task-1",
            org_id="org-1",
            snapshot_ref="snapshot-1",
            permission_mode="ask_each",
            input_ref="input-1",
        )
    )
    assert len(checkpoints) == 1
    assert checkpoints[0].step_no == 1
    assert checkpoints[0].content_hash.startswith("sha256:")
    adapter.restore(
        RunContext(
            run_id="run-1",
            task_id="task-1",
            org_id="org-1",
            snapshot_ref="snapshot-1",
            permission_mode="ask_each",
            input_ref="input-1",
        ),
        checkpoints[0],
    )


def test_faux_model_gateway_is_deterministic():
    gateway = FauxModelGateway(content="# Same\n")
    provider = gateway.resolve_provider_context("org-a")
    request = type("Request", (), {"operation_id": "op-1"})()
    first = gateway.invoke(request, provider)
    second = gateway.invoke(request, provider)
    assert first.content_hash == second.content_hash
    assert first.provider_request_id == "faux-op-1"
