"""Real DB review opt-in, authorization, budgets and uncertain delivery."""

import hashlib
import json
import sys
import time
import uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.models import AIUsageRecord

from work import agent_runs, review_runs
from work.agent_client import AgentBoundaryError, AgentClient
from work.models import WorkReview

from .test_agent_runs import agent_settings, new_run, response
from .test_materials import client, work_settings
from .test_runs import ROOT

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def review_settings(settings):
    settings.WORK_REVIEW_ENABLED = True
    settings.WORK_REVIEW_URL = "http://127.0.0.1:8882"
    settings.WORK_REVIEW_TOKEN = "review-test-only-token-123456789"
    settings.WORK_REVIEW_MODEL = "deepseek-flash"
    settings.WORK_REVIEW_TOKEN_BUDGET = 20000


def completed(client):
    run = new_run(client)
    with patch.object(AgentClient, "get", return_value=response(run)):
        agent_runs.process_agent_runs()
    run.refresh_from_db()
    return run


def submit_review(client, run, *, key=None, files=None):
    return client.post(
        ROOT + f"runs/{run.pk}/reviews/",
        {"files": files or list(run.files.values("name", "sha256"))},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()),
    )


def reviewed(review, state="succeeded", invalid=False):
    value = response(review, state)
    value["deployment"]["engine"] = "pi"
    value["deployment"]["features"].append("readonly_review_v1")
    if state == "succeeded":
        file, text = next(
            (name, text)
            for name, text in review.agent_payload["files"].items()
            if name.startswith("result-")
        )
        report = {
            "verdict": "needs_changes",
            "summary": "Check launch status",
            "findings": [
                {
                    "severity": "warning",
                    "message": "Status remains under review",
                    "evidence": [
                        {
                            "file": file,
                            "sha256": hashlib.sha256(text.encode()).hexdigest(),
                            "quote": "Fabricated"
                            if invalid
                            else "Launch is under review.",
                        }
                    ],
                }
            ],
            "missing_information": [],
        }
        text = json.dumps(report)
        value["result"]["artifacts"] = [
            {
                "name": "pi-review.json",
                "text": text,
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
            }
        ]
    return value


def test_review_freezes_selection_is_idempotent_and_preserves_source(client, settings):
    run = completed(client)
    key = uuid.uuid4()
    admitted = submit_review(client, run, key=key)
    assert admitted.status_code == 202
    assert submit_review(client, run, key=key).data["id"] == admitted.data["id"]
    review = WorkReview.objects.get(pk=admitted.data["id"])
    assert review.agent_payload["operation"] == "review"
    assert review.agent_payload["limits"]["max_model_calls"] == 1
    assert "agent_payload" not in admitted.data and "base_url" not in admitted.data
    with patch.object(AgentClient, "get", return_value=reviewed(review)):
        assert review_runs.process_reviews() == 1
        assert review_runs.process_reviews() == 0
    review.refresh_from_db()
    run.refresh_from_db()
    assert run.status == "succeeded" and run.files.get().text.startswith("# Report")
    assert run.task.runs.count() == 1
    assert review.report["verdict"] == "needs_changes"
    assert review.reserved_tokens == 35
    assert (
        AIUsageRecord.objects.filter(
            ref_type="work_review", ref_id=str(review.pk)
        ).count()
        == 1
    )
    settings.WORK_REVIEW_ENABLED = False
    assert (
        client.get(ROOT + f"runs/{run.pk}/reviews/").data[0]["report"] == review.report
    )


def test_review_ownership_selection_and_budget(client, settings):
    run = completed(client)
    other = APIClient()
    other.force_authenticate(UserFactory())
    assert submit_review(other, run).status_code == 404
    assert (
        submit_review(
            client, run, files=[{"name": "unsynced.md", "sha256": "a" * 64}]
        ).status_code
        == 409
    )
    settings.WORK_DAILY_TOKEN_BUDGET = 100
    assert submit_review(client, run).data["code"] == "budget_exceeded"
    assert WorkReview.objects.count() == 0
    settings.WORK_DAILY_TOKEN_BUDGET = 21000
    assert submit_review(client, run).status_code == 202
    # The same owner ledger also protects new execution and communication tasks.
    assert agent_runs.runs.daily_reserved(run.task.owner_id) == 20035


def test_review_requires_success_and_independent_configuration(client, settings):
    run = new_run(client)
    assert (
        submit_review(
            client, run, files=[{"name": "report.md", "sha256": "a" * 64}]
        ).data["code"]
        == "review_requires_success"
    )
    run = completed(client)
    settings.WORK_REVIEW_ENABLED = False
    assert submit_review(client, run).data["code"] == "review_unavailable"


def test_cancel_wins_review_delivery_and_keeps_usage(client):
    run = completed(client)
    review = WorkReview.objects.get(pk=submit_review(client, run).data["id"])
    review.call_started_at = timezone.now()
    review.save()

    def raced(_id):
        assert (
            client.post(
                ROOT + f"runs/{run.pk}/reviews/{review.pk}/cancel/", {}, format="json"
            ).status_code
            == 200
        )
        return reviewed(review)

    with patch.object(AgentClient, "get", side_effect=raced):
        review_runs.process_reviews()
    review.refresh_from_db()
    assert review.status == "canceled" and not review.report
    assert review.input_tokens == 30
    run.refresh_from_db()
    assert run.status == "succeeded"


def test_source_revocation_cancels_review_and_blocks_read(client):
    run = completed(client)
    review = WorkReview.objects.get(pk=submit_review(client, run).data["id"])
    review.call_started_at = timezone.now()
    review.save()
    client.delete(ROOT + f"materials/{run.task.sources[0]['id']}/")
    with patch.object(
        AgentClient, "cancel", return_value=reviewed(review, "cancelled")
    ) as cancel:
        review_runs.process_reviews()
    cancel.assert_called_once_with(review.pk)
    review.refresh_from_db()
    assert review.status == "failed" and review.error_code == "source_unavailable"
    assert client.get(ROOT + f"runs/{run.pk}/reviews/").status_code == 409


def test_uncertain_review_admission_uses_same_id_and_payload(client):
    run = completed(client)
    review = WorkReview.objects.get(pk=submit_review(client, run).data["id"])
    caps = reviewed(review)["deployment"]
    with (
        patch.object(
            AgentClient, "get", side_effect=AgentBoundaryError("agent_http_404")
        ),
        patch.object(AgentClient, "capabilities", return_value=caps),
        patch.object(
            AgentClient,
            "submit",
            side_effect=AgentBoundaryError("agent_transport_unknown"),
        ) as admit,
    ):
        review_runs.process_reviews()
    admit.assert_called_once_with(review.pk, **review.agent_payload)
    review.refresh_from_db()
    assert review.call_started_at and review.status == "queued"
    review.lease_until = timezone.now() - timedelta(seconds=1)
    review.save()
    with (
        patch.object(AgentClient, "get", return_value=reviewed(review)),
        patch.object(AgentClient, "submit") as admit,
    ):
        review_runs.process_reviews()
    admit.assert_not_called()
    review.refresh_from_db()
    assert review.status == "succeeded"


def test_wrong_engine_fails_before_admission_and_invalid_quotes_fail_delivery(client):
    run = completed(client)
    review = WorkReview.objects.get(pk=submit_review(client, run).data["id"])
    caps = reviewed(review)["deployment"]
    caps["engine"] = "dsh"
    with (
        patch.object(
            AgentClient, "get", side_effect=AgentBoundaryError("agent_http_404")
        ),
        patch.object(AgentClient, "capabilities", return_value=caps),
        patch.object(AgentClient, "submit") as admit,
    ):
        review_runs.process_reviews()
    admit.assert_not_called()
    review.refresh_from_db()
    assert review.status == "failed" and review.error_code == "agent_contract_mismatch"
    review = WorkReview.objects.get(pk=submit_review(client, run).data["id"])
    with patch.object(AgentClient, "get", return_value=reviewed(review, invalid=True)):
        review_runs.process_reviews()
    review.refresh_from_db()
    assert (
        review.status == "failed"
        and review.error_code == "invalid_review_report"
        and not review.report
    )


def test_actual_review_http_process_and_business_import(client, settings, tmp_path):
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "work-agent"))
    from work_agent.config import Config  # noqa: PLC0415
    from work_agent.server import Gateway  # noqa: PLC0415

    run = completed(client)
    gateway = Gateway(
        Config(
            "fixture",
            tmp_path / "gateway",
            "offline-review-test-token-123456",
            execution="fixture",
        )
    )
    gateway.start()
    try:
        settings.WORK_AGENT_TEST_FIXTURE = True
        settings.WORK_REVIEW_URL = gateway.url
        settings.WORK_REVIEW_TOKEN = gateway.config.token
        review = WorkReview.objects.get(pk=submit_review(client, run).data["id"])
        for _ in range(60):
            review_runs.process_reviews()
            review.refresh_from_db()
            if review.agent_done:
                break
            time.sleep(0.05)
        assert review.status == "succeeded" and review.agent_done
        assert review.report["verdict"] == "inconclusive"
        assert review.input_tokens == review.output_tokens == 0
        assert review.agent_deployment["engine"] == "fixture"
    finally:
        gateway.close()
