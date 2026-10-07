"""Actual PostgreSQL/API coordination, fencing and explicit file sharing."""

import hashlib
import uuid
from datetime import timedelta

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.models import AIUsageRecord

from work import agent_runs, local_runs
from work.models import WorkRun

from .test_materials import client, work_settings
from .test_runs import task_input

pytestmark = pytest.mark.django_db
ROOT = "/api/v1.0/work/"


@pytest.fixture(autouse=True)
def local_settings(settings):
    settings.WORK_LOCAL_AGENT_ENABLED = True
    settings.WORK_AGENT_ENABLED = False
    settings.WORK_AGENT_MODEL = "deepseek-flash"
    settings.WORK_AGENT_TOKEN_BUDGET = 80000
    settings.WORK_AGENT_MAX_CALLS = 6
    settings.WORK_MAX_OUTPUT_TOKENS = 4096
    settings.WORK_DAILY_TOKEN_BUDGET = 1000000


def device(client):
    identifier = str(uuid.uuid4())
    response = client.post(
        ROOT + "local/devices/",
        {"device_id": identifier, "name": "test desktop"},
        format="json",
    )
    assert response.status_code == 200, response.data
    return identifier


def admit(client, sources=None):
    body = {
        "device_id": device(client),
        "run_id": str(uuid.uuid4()),
        "goal": "Combine authorized cloud context with local files",
        "model": "deepseek-flash",
        "workspace_label": "selected folder",
        "sources": sources or [],
    }
    response = client.post(ROOT + "local/tasks/", body, format="json")
    assert response.status_code == 201, response.data
    claim = client.post(
        ROOT + f"local/runs/{body['run_id']}/claim/",
        {"device_id": body["device_id"]},
        format="json",
    )
    assert claim.status_code == 200, claim.data
    return body, response.data, claim.data


def report_for(body, claim, state="succeeded", seq=1):
    text = "# Shared local result\n"
    return {
        "device_id": body["device_id"],
        "ticket": claim["ticket"],
        "seq": seq,
        "state": state,
        "deployment": {
            "contract": "work-local/v1",
            "engine": "dsh",
            "model": "deepseek-flash",
            "runtime_version": "independently-pinned",
            "adapter_version": "0.2.0",
        },
        "metering": {
            "calls": 1,
            "complete": True,
            "usage": {
                "input_tokens": 100,
                "output_tokens": 20,
                "cache_read_tokens": 30,
                "cache_write_tokens": 0,
            },
        },
        "error_code": "",
        "artifacts": [
            {
                "name": "report.md",
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
                "bytes": len(text.encode()),
            }
        ]
        if state == "succeeded"
        else [],
    }


def post_report(client, body, report):
    return client.post(
        ROOT + f"local/runs/{body['run_id']}/report/", report, format="json"
    )


def test_unified_task_and_stable_claim_without_cloud_execution(client):
    body, admitted, claim = admit(client)
    repeated = client.post(ROOT + "local/tasks/", body, format="json")
    assert repeated.status_code == 200 and repeated.data == admitted
    assert (
        client.post(
            ROOT + f"local/runs/{body['run_id']}/claim/",
            {"device_id": body["device_id"]},
            format="json",
        ).data["ticket"]
        == claim["ticket"]
    )
    assert admitted["run"]["execution_target"] == "local"
    assert admitted["run"]["usage_origin"] == "device_reported"
    assert agent_runs.process_agent_runs() == 0
    detail = client.get(ROOT + f"tasks/{admitted['task']['id']}/")
    assert "ticket" not in str(detail.data) and "selected folder" in str(detail.data)
    response = client.post(
        ROOT + "local/tasks/", {**body, "goal": "changed"}, format="json"
    )
    assert response.status_code == 409
    assert (
        client.post(
            ROOT + f"tasks/{admitted['task']['id']}/retry/",
            {},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        ).status_code
        == 409
    )


def test_report_ledger_then_explicit_idempotent_file_sync(client):
    body, _, claim = admit(client)
    report = report_for(body, claim)
    response = post_report(client, body, report)
    assert response.status_code == 200, response.data
    assert post_report(client, body, report).status_code == 200
    run = WorkRun.objects.get(pk=body["run_id"])
    assert (
        run.status == "succeeded"
        and run.input_tokens == 130
        and run.output_tokens == 20
    )
    assert not run.files.exists() and not run.versions.exists()
    assert (
        run.reserved_tokens == 80000
        and not AIUsageRecord.objects.filter(ref_id=str(run.pk)).exists()
    )
    assert post_report(client, body, {**report, "state": "failed"}).status_code == 409
    text = "# Shared local result\n"
    file = {
        "name": "report.md",
        "text": text,
        "sha256": report["artifacts"][0]["sha256"],
    }
    payload = {
        "device_id": body["device_id"],
        "ticket": claim["ticket"],
        "files": [file],
    }
    url = ROOT + f"local/runs/{run.pk}/sync/"
    assert client.post(url, payload, format="json").status_code == 200
    assert client.post(url, payload, format="json").status_code == 200
    assert run.files.count() == 1 and run.versions.count() == 1
    assert run.events.filter(type="local_files_synced").count() == 1
    assert (
        client.get(ROOT + f"runs/{run.pk}/file-download/?name=report.md").content
        == text.encode()
    )
    assert (
        client.post(
            url, {**payload, "files": [{**file, "text": "changed"}]}, format="json"
        ).status_code
        == 409
    )


def test_cancel_wins_late_completion_and_keeps_device_usage(client):
    body, _, claim = admit(client)
    url = ROOT + f"runs/{body['run_id']}/cancel/"
    assert client.post(url, {}, format="json").status_code == 200
    response = post_report(client, body, report_for(body, claim))
    assert response.data["cancel"] is True and response.data["status"] == "canceled"
    run = WorkRun.objects.get(pk=body["run_id"])
    assert not run.artifact_manifest and not run.files.exists()
    assert run.input_tokens == 130


def test_expired_device_is_unknown_and_can_only_reconcile(client):
    body, _, claim = admit(client)
    assert (
        post_report(client, body, report_for(body, claim, "running")).status_code == 200
    )
    WorkRun.objects.filter(pk=body["run_id"]).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )
    local_runs.expire_runs()
    run = WorkRun.objects.get(pk=body["run_id"])
    assert run.status == "disconnected"
    assert agent_runs.process_agent_runs() == 0
    response = post_report(client, body, report_for(body, claim, "running", 2))
    assert response.status_code == 200
    run.refresh_from_db()
    assert run.status == "running" and not run.error_code


def test_owner_ticket_and_unknown_fields_are_rejected(client):
    body, admitted, claim = admit(client)
    other = APIClient()
    other.force_authenticate(UserFactory())
    assert other.get(ROOT + f"tasks/{admitted['task']['id']}/").status_code == 404
    assert post_report(other, body, report_for(body, claim)).status_code == 404
    assert (
        post_report(
            client, body, {**report_for(body, claim), "ticket": "0" * 64}
        ).status_code
        == 403
    )
    assert (
        client.post(
            ROOT + "local/tasks/", {**body, "workspace": "C:\\private"}, format="json"
        ).status_code
        == 400
    )
    assert (
        post_report(
            client,
            body,
            {**report_for(body, claim), "file_text": "must not be uploaded"},
        ).status_code
        == 400
    )


def test_gap_and_usage_regression_do_not_mutate_ledger(client):
    body, _, claim = admit(client)
    report = report_for(body, claim, "running")
    assert post_report(client, body, {**report, "seq": 2}).status_code == 409
    assert post_report(client, body, report).status_code == 200
    assert (
        post_report(
            client,
            body,
            {
                **report,
                "seq": 2,
                "metering": {"calls": 0, "complete": True, "usage": None},
            },
        ).status_code
        == 409
    )
    run = WorkRun.objects.get(pk=body["run_id"])
    assert run.local_report_seq == 1 and run.agent_metering["calls"] == 1


def test_context_snapshot_and_source_revocation(client):
    sources = task_input(client)["sources"]
    body, _, claim = admit(client, sources)
    assert (
        claim["files"]
        and claim["files"][0]["sha256"]
        == hashlib.sha256(claim["files"][0]["text"].encode()).hexdigest()
    )
    assert client.delete(ROOT + f"materials/{sources[0]['id']}/").status_code == 204
    response = post_report(client, body, report_for(body, claim, "running"))
    assert response.status_code == 200 and response.data["cancel"] is True
    assert WorkRun.objects.get(pk=body["run_id"]).status == "failed"


def test_disabled_coordination_cannot_admit_but_cancels_existing(client, settings):
    body, _, claim = admit(client)
    settings.WORK_LOCAL_AGENT_ENABLED = False
    assert (
        client.post(
            ROOT + "local/tasks/", {**body, "run_id": str(uuid.uuid4())}, format="json"
        ).status_code
        == 503
    )
    response = post_report(client, body, report_for(body, claim, "running"))
    assert response.status_code == 200 and response.data["cancel"] is True
