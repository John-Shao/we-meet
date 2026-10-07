"""Remote requests remain private, queue offline, and are never cloud jobs."""

import uuid
from datetime import timedelta

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory

from work import agent_runs
from work.models import WorkRun, WorkWorkspace

from .test_local_runs import device, local_settings
from .test_materials import client, work_settings

pytestmark = pytest.mark.django_db
ROOT = "/api/v1.0/work/local/"


@pytest.fixture(autouse=True)
def remote_settings(settings):
    settings.WORK_REMOTE_AGENT_ENABLED = True


def workspace(client):
    body = {
        "device_id": device(client),
        "workspace_id": str(uuid.uuid4()),
        "label": "Desktop project",
        "model": "deepseek-flash",
        "enabled": True,
    }
    response = client.post(ROOT + "workspaces/", body, format="json")
    assert response.status_code == 200, response.data
    return body


def dispatch(client, w):
    body = {
        "run_id": str(uuid.uuid4()),
        "workspace_id": w["workspace_id"],
        "goal": "Read local input and create report",
    }
    response = client.post(ROOT + "remote-tasks/", body, format="json")
    assert response.status_code == 201, response.data
    return body, response.data


def test_offline_idempotent_queue_and_original_device_claim(client):
    w = workspace(client)
    WorkWorkspace.objects.filter(pk=w["workspace_id"]).update(
        last_seen_at=timezone.now() - timedelta(minutes=2)
    )
    assert not client.get(ROOT + "workspaces/").data["workspaces"][0]["online"]
    body, response = dispatch(client, w)
    assert response["run"]["workspace_id"] == w["workspace_id"]
    assert response["run"]["remote_requested"] is True
    assert client.post(ROOT + "remote-tasks/", body, format="json").status_code == 200
    assert WorkRun.objects.count() == 1
    assert agent_runs.claim(set()) is None
    poll = {"device_id": w["device_id"], "workspace_ids": []}
    assert client.post(ROOT + "inbox/", poll, format="json").data["pending"] == []
    poll["workspace_ids"] = [w["workspace_id"]]
    pending = client.post(ROOT + "inbox/", poll, format="json").data["pending"]
    assert pending[0]["run_id"] == body["run_id"]
    assert "ticket" not in pending[0]
    other_device = device(client)
    assert (
        client.post(
            ROOT + f"runs/{body['run_id']}/claim/",
            {"device_id": other_device},
            format="json",
        ).status_code
        == 404
    )
    claim = client.post(
        ROOT + f"runs/{body['run_id']}/claim/",
        {"device_id": w["device_id"]},
        format="json",
    )
    assert claim.status_code == 200
    assert claim.data["workspace_id"] == w["workspace_id"]
    assert client.post(ROOT + "inbox/", poll, format="json").data["pending"] == []


def test_other_account_and_raw_path_cannot_register_or_dispatch(client):
    w = workspace(client)
    other = APIClient()
    other.force_authenticate(user=UserFactory())
    assert other.get(ROOT + "workspaces/").data["workspaces"] == []
    assert other.post(ROOT + "workspaces/", w, format="json").status_code == 404
    assert (
        other.post(
            ROOT + "remote-tasks/",
            {
                "run_id": str(uuid.uuid4()),
                "workspace_id": w["workspace_id"],
                "goal": "steal",
            },
            format="json",
        ).status_code
        == 404
    )
    assert (
        client.post(
            ROOT + "workspaces/", {**w, "path": "C:\\private"}, format="json"
        ).status_code
        == 400
    )
    body, _ = dispatch(client, w)
    assert (
        client.post(
            ROOT + "remote-tasks/", {**body, "goal": "changed"}, format="json"
        ).status_code
        == 409
    )


def test_revocation_cancels_pending_and_prevents_late_claim(client, settings):
    w = workspace(client)
    body, _ = dispatch(client, w)
    w["enabled"] = False
    assert client.post(ROOT + "workspaces/", w, format="json").status_code == 200
    assert WorkRun.objects.get(pk=body["run_id"]).status == "canceled"
    assert client.post(ROOT + "remote-tasks/", body, format="json").status_code == 200
    assert (
        client.post(
            ROOT + f"runs/{body['run_id']}/claim/",
            {"device_id": w["device_id"]},
            format="json",
        ).status_code
        == 409
    )
    settings.WORK_REMOTE_AGENT_ENABLED = False
    assert client.get(ROOT + "workspaces/").status_code == 503
