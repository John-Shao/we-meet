"""Real Work DB/API behavior across the independent HTTP job boundary."""

import json
import os
import sys
import time
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.models import AIUsageRecord

from work import agent_runs, runs
from work.agent_client import AgentBoundaryError, AgentClient
from work.models import WorkArtifactVersion, WorkRun

from .test_materials import client, work_settings
from .test_runs import ROOT, submit, task_input

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def agent_settings(settings):
    settings.WORK_AGENT_ENABLED = True
    settings.WORK_AGENT_URL = "http://127.0.0.1:8881"
    settings.WORK_AGENT_TOKEN = "offline-business-test-token-123456"
    settings.WORK_AGENT_MODEL = "deepseek-flash"
    settings.WORK_AGENT_TOKEN_BUDGET = 80000
    settings.WORK_AGENT_TIMEOUT = 30
    settings.WORK_AGENT_MAX_CALLS = 6
    settings.WORK_MAX_OUTPUT_TOKENS = 3000
    settings.WORK_DAILY_TOKEN_BUDGET = 200000


def new_run(client):
    data = {**task_input(client), "kind": "office_agent", "recipient": ""}
    response = submit(client, data)
    assert response.status_code == 201, response.data
    return WorkRun.objects.get(pk=response.data["runs"][0]["id"])


def response(run, state="succeeded", complete=True):
    import hashlib  # noqa: PLC0415 -- test data

    text = "# Report\nLaunch is under review."
    usage = {
        "input_tokens": 10,
        "output_tokens": 5,
        "cache_read_tokens": 20,
        "cache_write_tokens": 0,
    }
    return {
        "contract": "work-agent/v1",
        "run_id": str(run.pk),
        "state": state,
        "error_code": "",
        "events": [],
        "deployment": {
            "contract": "work-agent/v1",
            "engine": "dsh",
            "model": run.model,
            "features": list(agent_runs.REQUIRED_FEATURES),
            "limits_ceiling": run.agent_payload["limits"],
        },
        "result": {
            "summary": "Draft",
            "usage": usage,
            "elapsed_ms": 20,
            "artifacts": [
                {
                    "name": "report.md",
                    "text": text,
                    "sha256": hashlib.sha256(text.encode()).hexdigest(),
                }
            ],
        }
        if state == "succeeded"
        else None,
        "metering": {
            "calls": 1,
            "complete": complete,
            "usage": usage if complete else None,
        },
    }


def ready_to_poll(run):
    run.call_started_at = timezone.now()
    run.save()


def test_import_usage_download_auth_and_delete_source(client):
    run = new_run(client)
    with patch.object(AgentClient, "get", return_value=response(run)):
        assert agent_runs.process_agent_runs() == 1
        assert agent_runs.process_agent_runs() == 0
    run.refresh_from_db()
    assert run.status == "succeeded" and run.agent_done
    assert (run.input_tokens, run.output_tokens) == (30, 5)
    assert run.reserved_tokens == 35
    assert (
        AIUsageRecord.objects.filter(ref_type="work_run", ref_id=str(run.pk)).count()
        == 1
    )
    base = ROOT + f"runs/{run.pk}/"
    files = client.get(base + "files/")
    assert files.data[0]["name"] == "report.md"
    assert (
        client.get(base + "file-download/?name=report.md").content
        == run.files.get().text.encode()
    )
    other = APIClient()
    other.force_authenticate(UserFactory())
    assert other.get(base + "files/").status_code == 404
    assert (
        client.post(
            base + "artifact/", {"base_version": 1, "body": "Edited"}, format="json"
        ).status_code
        == 200
    )
    assert run.files.get().text.startswith("# Report")
    assert (
        client.delete(ROOT + f"materials/{run.task.sources[0]['id']}/").status_code
        == 204
    )
    assert client.get(base + "files/").status_code == 409
    assert client.get(base + "file-download/?name=report.md").status_code == 409


def test_cancel_wins_delivery_but_usage_retained(client):
    run = new_run(client)
    ready_to_poll(run)

    def raced_get(_id):
        assert (
            client.post(ROOT + f"runs/{run.pk}/cancel/", {}, format="json").status_code
            == 200
        )
        return response(run)

    with patch.object(AgentClient, "get", side_effect=raced_get):
        agent_runs.process_agent_runs()
    run.refresh_from_db()
    assert run.status == "canceled" and run.input_tokens == 30
    assert not run.files.exists() and not run.versions.exists()


def test_source_revocation_during_execution_cancels_remote(client):
    run = new_run(client)
    ready_to_poll(run)
    client.delete(ROOT + f"materials/{run.task.sources[0]['id']}/")
    with patch.object(
        AgentClient, "cancel", return_value=response(run, "cancelled")
    ) as cancel:
        agent_runs.process_agent_runs()
    cancel.assert_called_once_with(run.pk)
    run.refresh_from_db()
    assert run.status == "failed" and run.error_code == "source_unavailable"
    assert run.input_tokens == 30 and not run.files.exists()


def test_pre_admission_cancel_never_submits(client):
    run = new_run(client)
    client.post(ROOT + f"runs/{run.pk}/cancel/", {}, format="json")
    with patch.object(AgentClient, "submit") as submit_agent:
        agent_runs.process_agent_runs()
    submit_agent.assert_not_called()
    run.refresh_from_db()
    assert run.agent_done


def test_lost_response_recovers_same_uuid_without_resubmit(client):
    run = new_run(client)
    ready_to_poll(run)
    with patch.object(
        AgentClient, "get", side_effect=AgentBoundaryError("agent_transport_unknown")
    ):
        agent_runs.process_agent_runs()
    run.refresh_from_db()
    assert run.status == "queued" and not run.agent_done
    run.lease_until = timezone.now() - timedelta(seconds=1)
    run.save()
    with (
        patch.object(AgentClient, "get", return_value=response(run)),
        patch.object(AgentClient, "submit") as submit_agent,
    ):
        agent_runs.process_agent_runs()
    submit_agent.assert_not_called()
    run.refresh_from_db()
    assert run.status == "succeeded"


def test_lost_admission_ack_is_not_a_second_paid_job(client):
    run = new_run(client)
    caps = {
        "contract": "work-agent/v1",
        "engine": "dsh",
        "model": run.model,
        "features": list(agent_runs.REQUIRED_FEATURES),
        "limits_ceiling": run.agent_payload["limits"],
    }
    with (
        patch.object(
            AgentClient, "get", side_effect=AgentBoundaryError("agent_http_404")
        ),
        patch.object(AgentClient, "capabilities", return_value=caps),
        patch.object(
            AgentClient,
            "submit",
            side_effect=AgentBoundaryError("agent_transport_unknown"),
        ) as post,
    ):
        agent_runs.process_agent_runs()
    post.assert_called_once_with(run.pk, **run.agent_payload)
    run.refresh_from_db()
    assert run.call_started_at is not None and run.agent_deployment == caps
    run.lease_until = None
    run.save()
    with (
        patch.object(AgentClient, "get", return_value=response(run)),
        patch.object(AgentClient, "submit") as retry,
    ):
        agent_runs.process_agent_runs()
    retry.assert_not_called()
    run.refresh_from_db()
    assert run.status == "succeeded"


def test_incompatible_gateway_is_rejected_before_admission(client):
    run = new_run(client)
    with (
        patch.object(
            AgentClient, "get", side_effect=AgentBoundaryError("agent_http_404")
        ),
        patch.object(
            AgentClient,
            "capabilities",
            return_value={
                "contract": "work-agent/v1",
                "features": [],
                "limits_ceiling": {},
                "model": run.model,
            },
        ),
        patch.object(AgentClient, "submit") as post,
    ):
        agent_runs.process_agent_runs()
    post.assert_not_called()
    run.refresh_from_db()
    assert run.error_code == "agent_contract_mismatch"


def test_unknown_usage_keeps_reservation_and_no_fake_record(client):
    run = new_run(client)
    with patch.object(AgentClient, "get", return_value=response(run, complete=False)):
        agent_runs.process_agent_runs()
    run.refresh_from_db()
    assert run.status == "succeeded" and not run.agent_done and run.input_tokens is None
    assert run.reserved_tokens == 80000 and run.usage_record_id is None
    with patch.object(AgentClient, "cancel", return_value=response(run)):
        agent_runs.process_agent_runs()
    run.refresh_from_db()
    assert run.agent_done and run.input_tokens == 30
    assert WorkArtifactVersion.objects.filter(run=run).count() == 1


def test_fixed_executor_never_claims_agent_and_budget_admission(client, settings):
    run = new_run(client)
    assert runs.claim_run() is None
    settings.WORK_DAILY_TOKEN_BUDGET = 80000
    second = submit(
        client, {**task_input(client), "kind": "office_agent", "recipient": ""}
    )
    assert second.status_code == 429 and second.data["code"] == "budget_exceeded"
    assert WorkRun.objects.count() == 1
    assert run.agent_payload["files"]


def test_actual_http_gateway_and_fixture_process(client, settings, tmp_path):
    settings.WORK_AGENT_TEST_FIXTURE = True
    # No SDK in business: import gateway only in this explicit boundary test.
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "work-agent"))
    from work_agent.config import Config  # noqa: PLC0415
    from work_agent.server import Gateway  # noqa: PLC0415

    gateway = Gateway(
        Config(
            "fixture",
            tmp_path / "gateway",
            settings.WORK_AGENT_TOKEN,
            execution="fixture",
        )
    )
    gateway.start()
    settings.WORK_AGENT_URL = gateway.url
    try:
        run = new_run(client)
        for _ in range(100):
            agent_runs.process_agent_runs()
            run.refresh_from_db()
            if run.status not in runs.ACTIVE:
                break
            time.sleep(0.05)
        assert run.status == "succeeded", run.error_code
        assert run.agent_deployment["engine"] == "fixture"
        assert run.files.get().name == "report.md"
        assert run.input_tokens == 0  # Confirmed zero attempted model calls.
    finally:
        gateway.close()


@pytest.mark.skipif(
    not os.environ.get("WORK_AGENT_LIVE_ENV"), reason="explicit paid validation only"
)
def test_live_deepseek_work_api_to_dsh(client, settings, tmp_path):
    """Synthetic material through the actual business API and isolated dsh."""
    from work import services  # noqa: PLC0415
    from work.models import WorkMaterial  # noqa: PLC0415

    from .test_materials import upload  # noqa: PLC0415

    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "work-agent"))
    from work_agent.config import Config, load_env  # noqa: PLC0415
    from work_agent.server import Gateway  # noqa: PLC0415

    load_env(os.environ["WORK_AGENT_LIVE_ENV"])
    gateway = Gateway(Config("dsh", tmp_path / "gateway", settings.WORK_AGENT_TOKEN))
    gateway.start()
    settings.WORK_AGENT_URL = gateway.url
    settings.WORK_AGENT_TIMEOUT = 180
    started = time.monotonic()
    try:
        uploaded = upload(
            client,
            name="orders.csv",
            data=b"order_id,region,amount,status\nA1,east,100,paid\nA2,south,200,paid\nA1,east,100,paid\nA3,east,50,refunded\n",
        )
        assert uploaded.status_code == 201
        services.process_materials()
        item = WorkMaterial.objects.get(pk=uploaded.data["id"])
        data = {
            "kind": "office_agent",
            "recipient": "",
            "goal": "Deduplicate orders by order_id, include only paid orders, sum amount by region. Write totals.json as a flat object keyed by region and report.md explaining the method. Use only selected materials.",
            "background": "",
            "sources": [
                {
                    "id": str(item.pk),
                    "checksum": item.checksum,
                    "parser_version": item.parser_version,
                    "generation": item.generation,
                }
            ],
        }
        admitted = submit(client, data)
        assert admitted.status_code == 201, admitted.data
        run = WorkRun.objects.get(pk=admitted.data["runs"][0]["id"])
        while time.monotonic() - started < 210:
            agent_runs.process_agent_runs()
            run.refresh_from_db()
            if run.status not in runs.ACTIVE and run.agent_done:
                break
            time.sleep(0.25)
        assert run.status == "succeeded", run.error_code
        assert run.agent_metering["complete"] and run.usage_record_id
        base = ROOT + f"runs/{run.pk}/"
        files = client.get(base + "files/")
        assert files.status_code == 200
        contents = {
            entry["name"]: client.get(
                base + "file-download/?name=" + entry["name"]
            ).content.decode("utf-8")
            for entry in files.data
        }
        assert json.loads(contents["totals.json"]) == {"east": 100, "south": 200}
        assert "report.md" in contents
        record = {
            "path": "Work upload API -> parsed selection -> Work task/outbox -> HTTP v1 -> Docker dsh -> scoped model broker -> DeepSeek -> authorized Work files",
            "engine": "dsh",
            "model": run.model,
            "state": run.status,
            "wall_ms": int((time.monotonic() - started) * 1000),
            "deployment": run.agent_deployment,
            "metering": run.agent_metering,
            "usage_recorded": bool(run.usage_record_id),
            "checks": {"totals": True, "authenticated_download": True},
            "files": contents,
        }
        if os.environ.get("WORK_AGENT_LIVE_RECEIPT"):
            target = Path(os.environ["WORK_AGENT_LIVE_RECEIPT"])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
            )
    finally:
        gateway.close()
