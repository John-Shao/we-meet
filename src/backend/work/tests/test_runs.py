"""Real DB ledger tests; model responses are explicit fixtures, not live validation."""

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch

from django.db import close_old_connections
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.models import AIUsageRecord

from work import runs, services
from work.executor import validate_result
from work.models import WorkArtifactVersion, WorkMaterial, WorkRun, WorkTask

from .test_materials import (
    client,
    upload,
    work_settings,
)

pytestmark = pytest.mark.django_db
ROOT = "/api/v1.0/work/"


@pytest.fixture(autouse=True)
def model_settings(settings):
    settings.WORK_COMMUNICATION_ENABLED = True
    settings.WORK_MODEL = "test-model"
    settings.WORK_MODEL_BASE_URL = "https://model.example.invalid/v1"
    settings.WORK_MODEL_API_KEY = "unit-test-only"
    settings.WORK_DAILY_TOKEN_BUDGET = 100000
    settings.WORK_MAX_OUTPUT_TOKENS = 3000


def task_input(client):
    response = upload(client, data=b"Launch is under review.\nBudget not confirmed.")
    services.process_materials()
    item = WorkMaterial.objects.get(pk=response.data["id"])
    return {
        "recipient": "Project owner",
        "goal": "Clarify launch requirements",
        "background": "Tomorrow",
        "sources": [
            {
                "id": str(item.pk),
                "checksum": item.checksum,
                "parser_version": item.parser_version,
                "generation": item.generation,
            }
        ],
    }


def submit(client, data=None, key=None):
    return client.post(
        ROOT + "tasks/",
        data or task_input(client),
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()),
    )


def result_for(run):
    return json.dumps(
        {
            "facts": [
                {
                    "text": "Launch still under review",
                    "source_id": run.task.sources[0]["id"],
                    "line": 1,
                    "quote": "Launch is under review.",
                }
            ],
            "agenda": ["Clarify priorities"],
            "questions": ["What is the target date?"],
            "talking_points": ["Suggest confirming the scope"],
            "missing_information": ["Budget"],
        }
    )


def generate(run, prompt, sink):
    assert "Launch is under review." in prompt
    sink(model_code=run.model, input_tokens=100, output_tokens=40)
    return result_for(run)


def completed(client):
    response = submit(client)
    assert response.status_code == 201, response.data
    with patch("work.runs.CommunicationExecutor.generate", side_effect=generate):
        assert runs.process_runs() == 1
    run = WorkRun.objects.get(pk=response.data["runs"][0]["id"])
    assert run.status == "succeeded", run.error_code
    return run


def test_create_replay_and_changed_payload(client):
    data, key = task_input(client), uuid.uuid4()
    first, again = submit(client, data, key), submit(client, data, key)
    assert first.status_code == 201 and again.status_code == 200
    assert first.data["id"] == again.data["id"]
    assert WorkRun.objects.count() == 1
    data["goal"] = "Changed"
    assert submit(client, data, key).status_code == 409


def test_generation_usage_events_edit_history_adopt_download(client):
    run = completed(client)
    assert (
        AIUsageRecord.objects.filter(ref_type="work_run", ref_id=str(run.pk)).count()
        == 1
    )
    assert run.input_tokens == 100
    base = ROOT + f"runs/{run.pk}/"
    events = client.get(base + "events/?after=2")
    assert [row["type"] for row in events.data["events"]] == [
        "model_started",
        "succeeded",
    ]
    assert events.data["next_after"] == 4
    artifact = client.get(base + "artifact/")
    assert artifact.status_code == 200 and artifact["Cache-Control"] == "no-store"
    assert artifact.data["citations"][0]["quote"] == "Launch is under review."
    edit = {"base_version": 1, "body": "# Edited\nReview before use"}
    assert client.post(base + "artifact/", edit, format="json").data["version"] == 2
    assert client.post(base + "artifact/", edit, format="json").status_code == 409
    assert (
        client.get(base + "artifact/?version=1").data["body"] == artifact.data["body"]
    )
    assert (
        client.post(base + "adopt/", {"version": 1}, format="json").status_code == 409
    )
    for _ in range(2):
        assert client.post(base + "adopt/", {"version": 2}, format="json").data[
            "adopted_at"
        ]
    assert run.events.filter(type="artifact_adopted").count() == 1
    download = client.get(base + "download/?version=2")
    assert download.content.decode() == edit["body"]
    assert download["Content-Disposition"].startswith("attachment;")


def test_cross_account_denies_all_objects(client):
    run = completed(client)
    client.force_authenticate(user=UserFactory())
    assert client.get(ROOT + "tasks/").data["count"] == 0
    for path in (
        f"tasks/{run.task_id}/",
        f"runs/{run.pk}/events/",
        f"runs/{run.pk}/artifact/",
        f"runs/{run.pk}/download/?version=1",
    ):
        assert client.get(ROOT + path).status_code == 404
    assert client.post(ROOT + f"runs/{run.pk}/cancel/").status_code == 404
    assert (
        client.post(
            ROOT + f"runs/{run.pk}/adopt/", {"version": 1}, format="json"
        ).status_code
        == 404
    )


def test_deleted_source_denies_delivery_and_execution(client):
    run = completed(client)
    client.delete(ROOT + f"materials/{run.task.sources[0]['id']}/")
    for suffix in ("artifact/", "download/?version=1"):
        assert client.get(ROOT + f"runs/{run.pk}/{suffix}").status_code == 409
    response = client.post(
        ROOT + f"tasks/{run.task_id}/retry/",
        {},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 409


def test_budget_oversize_selection_and_missing_model_fail_before_task_creation(
    client, settings
):
    data = task_input(client)
    settings.WORK_DAILY_TOKEN_BUDGET = 1
    assert submit(client, data).status_code == 429
    assert not WorkTask.objects.exists()
    settings.WORK_DAILY_TOKEN_BUDGET = 100000
    settings.WORK_MODEL_API_KEY = ""
    assert submit(client, data).status_code == 503
    settings.WORK_MODEL_API_KEY = "test"
    WorkMaterial.objects.update(text="x" * 12001)
    assert submit(client, data).status_code == 413
    assert not WorkTask.objects.exists()


def test_cancel_during_call_keeps_usage_and_discards_late_result(client):
    response = submit(client)
    run = WorkRun.objects.get(pk=response.data["runs"][0]["id"])

    def cancel_during_generate(run, prompt, sink):
        client.post(ROOT + f"runs/{run.pk}/cancel/", {}, format="json")
        return generate(run, prompt, sink)

    with patch(
        "work.runs.CommunicationExecutor.generate", side_effect=cancel_during_generate
    ):
        runs.process_runs()
    run.refresh_from_db()
    assert run.status == "canceled" and run.input_tokens == 100
    assert not WorkArtifactVersion.objects.exists()


def test_expired_provider_claim_never_replays_and_explicit_retry_is_deduped(client):
    submit(client)
    old = runs.claim_run()
    WorkRun.objects.filter(pk=old.pk).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )
    with patch("work.runs.CommunicationExecutor.generate") as model:
        runs.process_runs()
        model.assert_not_called()
    old.refresh_from_db()
    assert old.status == "failed" and old.error_code == "execution_unknown"
    key = str(uuid.uuid4())
    for _ in range(2):
        response = client.post(
            ROOT + f"tasks/{old.task_id}/retry/",
            {},
            format="json",
            HTTP_IDEMPOTENCY_KEY=key,
        )
        assert response.status_code == 202
    assert WorkRun.objects.count() == 2
    assert WorkRun.objects.filter(status="queued").count() == 1


@pytest.mark.parametrize("failure", ["quote", "source", "line", "schema"])
def test_invalid_citations_or_schema_never_publish(client, failure):
    submit(client)
    run = WorkRun.objects.first()
    result = json.loads(result_for(run))
    if failure == "quote":
        result["facts"][0]["quote"] = "Approved promise"
    elif failure == "source":
        result["facts"][0]["source_id"] = str(uuid.uuid4())
    elif failure == "line":
        result["facts"][0]["line"] = 100
    else:
        result["secret"] = "unknown field"
    with patch(
        "work.runs.CommunicationExecutor.generate", return_value=json.dumps(result)
    ):
        runs.process_runs()
    run.refresh_from_db()
    assert run.status == "failed" and not run.versions.exists()


def test_revocation_during_generation_prevents_artifact(client):
    submit(client)

    def revoke(run, prompt, sink):
        UserFactory._meta.model.objects.filter(pk=run.task.owner_id).update(
            is_active=False
        )
        return generate(run, prompt, sink)

    with patch("work.runs.CommunicationExecutor.generate", side_effect=revoke):
        runs.process_runs()
    assert WorkRun.objects.get().error_code == "access_revoked"
    assert not WorkArtifactVersion.objects.exists()


def test_provider_failure_sanitized_and_no_automatic_retry(client):
    submit(client)
    with patch(
        "work.runs.CommunicationExecutor.generate",
        side_effect=RuntimeError("private-provider-secret"),
    ) as model:
        runs.process_runs()
        runs.process_runs()
        assert model.call_count == 1
    run = WorkRun.objects.get()
    assert run.error_code == "execution_unknown" and run.input_tokens is None


@pytest.mark.django_db(transaction=True)
def test_concurrent_submit_reserves_once(client):
    data = task_input(client)
    owner, key = client.work_user, uuid.uuid4()

    def create():
        close_old_connections()
        try:
            return runs.create_task(owner, data, key)[0].pk
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(lambda _: create(), range(2)))
    assert ids[0] == ids[1] and WorkRun.objects.count() == 1


def test_model_disabled_keeps_read_edit_cancel(client, settings):
    run = completed(client)
    settings.WORK_COMMUNICATION_ENABLED = False
    assert client.get(ROOT + f"runs/{run.pk}/artifact/").status_code == 200
    assert (
        client.post(
            ROOT + f"runs/{run.pk}/artifact/",
            {"base_version": 1, "body": "edit"},
            format="json",
        ).status_code
        == 200
    )
    assert client.get(ROOT + "capabilities/").data["communication_enabled"] is False
