"""Real Work DB/API behavior across the independent HTTP job boundary."""

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

from .support import ROOT, client, submit, task_input, work_settings

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
    response = submit(client, task_input())
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


def test_import_usage_download_and_auth(client):
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


def test_agent_budget_admission(client, settings):
    run = new_run(client)
    settings.WORK_DAILY_TOKEN_BUDGET = 80000
    second = submit(client, task_input())
    assert second.status_code == 429 and second.data["code"] == "budget_exceeded"
    assert WorkRun.objects.count() == 1
    assert run.agent_payload["files"] == {}


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
