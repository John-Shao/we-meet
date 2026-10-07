"""Real DB/API cohort isolation, revocation, and agent outbox boundaries."""

import uuid
from unittest.mock import patch

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory

from work import agent_runs, local_runs, rollout
from work.agent_client import AgentBoundaryError, AgentClient
from work.models import WorkDevice, WorkRun, WorkTask
from work.services import MaterialError

from . import test_agent_runs as cloud
from . import test_local_runs as local
from . import test_remote_runs as remote
from . import test_reviews as review
from .test_materials import client, upload, work_settings
from .test_runs import model_settings, submit, task_input

pytestmark = pytest.mark.django_db
ROOT = "/api/v1.0/work/"


@pytest.fixture(autouse=True)
def cohort_settings(settings, client, work_settings):
    settings.WORK_AGENT_ROLLOUT_MODE = "allowlist"
    settings.WORK_AGENT_ALLOWED_USER_IDS = [str(client.work_user.pk)]
    settings.WORK_LOCAL_AGENT_ENABLED = True
    settings.WORK_REMOTE_AGENT_ENABLED = True
    settings.WORK_AGENT_ENABLED = True
    settings.WORK_AGENT_URL = "http://127.0.0.1:8881"
    settings.WORK_AGENT_TOKEN = "offline-cohort-fixture-token"
    settings.WORK_AGENT_MODEL = "deepseek-flash"
    settings.WORK_AGENT_TOKEN_BUDGET = 80000
    settings.WORK_REVIEW_ENABLED = True
    settings.WORK_REVIEW_URL = "http://127.0.0.1:8882"
    settings.WORK_REVIEW_TOKEN = "offline-cohort-review-token"
    settings.WORK_REVIEW_MODEL = "deepseek-flash"
    settings.WORK_REVIEW_TOKEN_BUDGET = 20000
    settings.WORK_DAILY_TOKEN_BUDGET = 1000000
    settings.WORK_MAX_OUTPUT_TOKENS = 4096


def capabilities(api):
    response = api.get(ROOT + "capabilities/")
    assert response.status_code == 200
    return response.data


@pytest.mark.parametrize(
    ("mode", "identifiers"),
    [
        ("closed", None),
        ("typo", None),
        ("", None),
        ("allowlist", []),
        ("allowlist", "wrong-type"),
        ("allowlist", ["bad-uuid"]),
        ("allowlist", [None]),
        ("allowlist", [str(uuid.uuid4())] * 101),
    ],
)
def test_closed_unknown_or_invalid_cohort_denies_new_features(
    client, settings, mode, identifiers
):
    settings.WORK_AGENT_ROLLOUT_MODE = mode
    settings.WORK_AGENT_ALLOWED_USER_IDS = identifiers
    value = capabilities(client)
    for feature in (
        "agent_enabled",
        "review_enabled",
        "local_agent_enabled",
        "remote_agent_enabled",
    ):
        assert value[feature] is False
    assert "office_agent" not in value["skills"]
    assert value["agent_model"] == value["review_model"] == ""
    assert upload(client).status_code == 201
    assert value["communication_enabled"] is True


def test_cohort_capabilities_differ_for_two_users_without_exposing_ids(client):
    value = capabilities(client)
    outsider = APIClient()
    outsider.force_authenticate(UserFactory())
    other = capabilities(outsider)
    for feature in (
        "agent_enabled",
        "review_enabled",
        "local_agent_enabled",
        "remote_agent_enabled",
    ):
        assert value[feature] is True
        assert other[feature] is False
    assert str(client.work_user.pk) not in str(value)
    assert upload(outsider).status_code == 201


def test_invalid_entry_closes_whole_cohort_even_with_valid_member(client, settings):
    settings.WORK_AGENT_ALLOWED_USER_IDS.append("bad-uuid")
    assert not rollout.allows(client.work_user)


def test_all_mode_still_requires_active_real_identity(client, settings):
    settings.WORK_AGENT_ROLLOUT_MODE = "all"
    user = client.work_user
    assert rollout.allows(user)
    user.is_active = False
    assert not rollout.allows(user)
    user.is_active = True
    user.sub = ""
    assert not rollout.allows(user)
    assert not rollout.allows(None)


def test_cohort_never_overrides_global_switches(client, settings):
    settings.WORK_AGENT_ENABLED = False
    settings.WORK_REVIEW_ENABLED = False
    settings.WORK_LOCAL_AGENT_ENABLED = False
    value = capabilities(client)
    assert not any(
        value[k]
        for k in (
            "agent_enabled",
            "review_enabled",
            "local_agent_enabled",
            "remote_agent_enabled",
        )
    )


def test_denied_account_cannot_register_dispatch_or_create_cloud_run(client, settings):
    data = {**task_input(client), "kind": "office_agent", "recipient": ""}
    settings.WORK_AGENT_ALLOWED_USER_IDS = []
    assert submit(client, data).status_code == 503
    assert WorkTask.objects.count() == WorkRun.objects.count() == 0
    device_id = str(uuid.uuid4())
    workspace_id = str(uuid.uuid4())
    bodies = {
        "devices/": {"device_id": device_id, "name": "blocked"},
        "tasks/": {
            "device_id": device_id,
            "run_id": str(uuid.uuid4()),
            "goal": "blocked",
            "model": "deepseek-flash",
            "workspace_label": "blocked",
            "sources": [],
        },
        "workspaces/": {
            "device_id": device_id,
            "workspace_id": workspace_id,
            "label": "blocked",
            "model": "deepseek-flash",
            "enabled": True,
        },
        "remote-tasks/": {
            "run_id": str(uuid.uuid4()),
            "workspace_id": workspace_id,
            "goal": "blocked",
        },
        "inbox/": {"device_id": device_id, "workspace_ids": [workspace_id]},
    }
    for endpoint, body in bodies.items():
        response = client.post(ROOT + "local/" + endpoint, body, format="json")
        assert response.status_code == 503
    with pytest.raises(MaterialError, match="local_coordination_disabled"):
        local_runs.register(client.work_user, uuid.uuid4(), "blocked")
    assert WorkDevice.objects.count() == WorkRun.objects.count() == 0


def test_revocation_blocks_claim_and_report_requests_local_stop(client, settings):
    body, admitted, claim = local.admit(client)
    settings.WORK_AGENT_ALLOWED_USER_IDS = []
    response = client.post(
        ROOT + f"local/runs/{body['run_id']}/claim/",
        {"device_id": body["device_id"]},
        format="json",
    )
    assert response.status_code == 409
    response = local.post_report(client, body, local.report_for(body, claim))
    assert response.status_code == 200 and response.data["cancel"] is True
    run = WorkRun.objects.get(pk=body["run_id"])
    assert run.status == "failed" and run.error_code == "local_coordination_disabled"
    assert run.artifact_manifest == []
    assert client.get(ROOT + f"tasks/{admitted['task']['id']}/").status_code == 200


def test_revocation_blocks_inbox_and_remote_admission_but_keeps_cancel(
    client, settings
):
    workspace = remote.workspace(client)
    body, _ = remote.dispatch(client, workspace)
    settings.WORK_AGENT_ALLOWED_USER_IDS = []
    inbox = {
        "device_id": workspace["device_id"],
        "workspace_ids": [workspace["workspace_id"]],
    }
    assert client.post(ROOT + "local/inbox/", inbox, format="json").status_code == 503
    assert (
        client.post(
            ROOT + "local/remote-tasks/",
            {**body, "run_id": str(uuid.uuid4())},
            format="json",
        ).status_code
        == 503
    )
    assert (
        client.post(
            ROOT + f"runs/{body['run_id']}/cancel/", {}, format="json"
        ).status_code
        == 200
    )
    assert WorkRun.objects.count() == 1


@pytest.mark.parametrize("inflight", [False, True])
def test_revoked_cloud_outbox_never_submits_and_only_drains_known_execution(
    client, settings, inflight
):
    run = cloud.new_run(client)
    if inflight:
        run.call_started_at = timezone.now()
        run.save(update_fields=["call_started_at"])
    settings.WORK_AGENT_ALLOWED_USER_IDS = []
    with (
        patch.object(AgentClient, "get") as get,
        patch.object(AgentClient, "submit") as send,
        patch.object(
            AgentClient, "cancel", return_value=cloud.response(run, "cancelled")
        ) as cancel,
    ):
        agent_runs.process_agent_runs()
    get.assert_not_called()
    send.assert_not_called()
    assert cancel.call_count == int(inflight)
    run.refresh_from_db()
    assert run.status == "failed" and run.error_code == "generation_unavailable"


def test_revocation_during_caps_check_is_rechecked_before_outbox_admission(
    client, settings
):
    run = cloud.new_run(client)

    def caps():
        settings.WORK_AGENT_ALLOWED_USER_IDS = []
        return cloud.response(run)["deployment"]

    with (
        patch.object(
            AgentClient, "get", side_effect=AgentBoundaryError("agent_http_404")
        ),
        patch.object(AgentClient, "capabilities", side_effect=caps),
        patch.object(AgentClient, "submit") as send,
    ):
        agent_runs.process_agent_runs()
    send.assert_not_called()
    run.refresh_from_db()
    assert run.status == "failed" and run.call_started_at is None


def test_revoked_reviewer_never_admits_or_executes_new_review(client, settings):
    run = review.completed(client)
    value = review.submit_review(client, run)
    assert value.status_code == 202
    settings.WORK_AGENT_ALLOWED_USER_IDS = []
    assert review.submit_review(client, run).status_code == 503
    with (
        patch.object(AgentClient, "get") as get,
        patch.object(AgentClient, "submit") as send,
    ):
        from work import review_runs  # noqa: PLC0415

        review_runs.process_reviews()
    get.assert_not_called()
    send.assert_not_called()
    assert client.get(ROOT + f"runs/{run.pk}/reviews/").status_code == 200
