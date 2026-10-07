"""Device-report fixture -> real DB/API -> HTTP reviewer -> evidence delivery."""

import hashlib
import io
import json
import os
import sys
import time
import uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from django.utils import timezone

import pytest

from core.models import AIUsageRecord

from work import agent_runs, review_runs
from work.agent_client import AgentBoundaryError, AgentClient
from work.models import WorkReview, WorkRun

from .test_local_runs import ROOT, admit, local_settings, post_report, report_for
from .test_materials import client, work_settings
from .test_runs import task_input

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize("engine", ["fixture", "pi"])
def test_selected_local_files_to_review_with_lost_admission_ack(  # noqa: PLR0915 -- one cross-boundary acceptance trace
    client, settings, tmp_path, monkeypatch, engine
):
    """No live supplier calls; Pi opt-in uses its real pinned Docker RPC runtime."""
    image = os.environ.get("WORK_AGENT_PI_TEST_IMAGE")
    if engine == "pi" and not image:
        pytest.skip("Pinned Pi Docker opt-in")
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "work-agent"))
    from work_agent.config import Config  # noqa: PLC0415
    from work_agent.server import Gateway  # noqa: PLC0415

    sources = task_input(client)["sources"]
    body, admitted, claim = admit(client, sources)
    report = report_for(body, claim)
    private_text = "private-local-only-canary"
    report["artifacts"].append(
        {
            "name": "private.csv",
            "sha256": hashlib.sha256(private_text.encode()).hexdigest(),
            "bytes": len(private_text.encode()),
        }
    )
    assert post_report(client, body, report).status_code == 200
    run = WorkRun.objects.get(pk=body["run_id"])
    assert run.status == "succeeded" and not run.files.exists()
    assert agent_runs.process_agent_runs() == 0  # Never cloud-replay a device run.
    assert client.get(ROOT + f"runs/{run.pk}/files/").data == []

    settings.WORK_REVIEW_ENABLED = True
    settings.WORK_REVIEW_MODEL = "qwen3.8-flash" if engine == "pi" else "deepseek-flash"
    settings.WORK_AGENT_TEST_FIXTURE = engine == "fixture"
    monkeypatch.setenv("DASHSCOPE_API_KEY", "offline-only-not-a-supplier-key")
    gateway = Gateway(
        Config(
            engine,
            tmp_path / "reviewer",
            "offline-flow-gateway-token-123456",
            model=settings.WORK_REVIEW_MODEL,
            execution="docker" if engine == "pi" else "fixture",
            provider="qwen" if engine == "pi" else "deepseek",
            image=image or "unused",
        )
    )
    requests = []
    text = "# Shared local result\n"
    selected = {
        "name": "report.md",
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
    }
    model_report = {
        "verdict": "needs_changes",
        "summary": "Synthetic review of the selected local result",
        "findings": [
            {
                "severity": "warning",
                "message": "Synthetic finding with exact source evidence",
                "evidence": [
                    {
                        "file": "result-01.md",
                        "sha256": selected["sha256"],
                        "quote": "Shared local result",
                    }
                ],
            }
        ],
        "missing_information": [],
    }

    def provider(encoded, timeout):
        payload = json.loads(encoded)
        assert (
            private_text not in encoded.decode()
            and "private.csv" not in encoded.decode()
        )
        assert payload["response_format"]["type"] == "json_schema"
        assert payload["response_format"]["json_schema"]["strict"] is True
        assert not payload.get("tools") and payload["enable_thinking"] is False
        requests.append(payload)
        chunks = [
            {
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "content": json.dumps(model_report),
                        },
                        "finish_reason": None,
                    }
                ]
            },
            {
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 30,
                    "total_tokens": 130,
                    "prompt_tokens_details": {"cached_tokens": 80},
                },
            },
        ]
        return io.BytesIO(
            b"".join(
                b"data: " + json.dumps(chunk).encode() + b"\n\n" for chunk in chunks
            )
            + b"data: [DONE]\n\n"
        )

    if engine == "pi":
        gateway.broker.provider = provider
    gateway.start()
    try:
        settings.WORK_REVIEW_URL = gateway.url
        settings.WORK_REVIEW_TOKEN = gateway.config.token
        review_url = ROOT + f"runs/{run.pk}/reviews/"
        key = str(uuid.uuid4())

        def start(selection):
            return client.post(
                review_url,
                {"files": selection},
                format="json",
                HTTP_IDEMPOTENCY_KEY=key,
            )

        assert start([selected]).data["code"] == "review_file_unavailable"
        assert WorkReview.objects.count() == 0
        sync = {
            "device_id": body["device_id"],
            "ticket": claim["ticket"],
            "files": [{**selected, "text": text}],
        }
        sync_url = ROOT + f"local/runs/{run.pk}/sync/"
        assert client.post(sync_url, sync, format="json").status_code == 200
        assert client.post(sync_url, sync, format="json").status_code == 200
        assert list(run.files.values_list("name", flat=True)) == ["report.md"]
        assert run.events.filter(type="local_files_synced").count() == 1
        assert (
            start(
                [{"name": "private.csv", "sha256": report["artifacts"][1]["sha256"]}]
            ).status_code
            == 409
        )
        assert start([{**selected, "sha256": "f" * 64}]).status_code == 409
        created = start([selected])
        assert created.status_code == 202
        assert start([selected]).data["id"] == created.data["id"]
        review = WorkReview.objects.get(pk=created.data["id"])
        assert private_text not in json.dumps(review.agent_payload)
        assert "private.csv" not in json.dumps(review.agent_payload)

        real_submit = AgentClient.submit
        admissions = []

        def lose_ack(self, identifier, **payload):
            admissions.append(str(identifier))
            real_submit(self, identifier, **payload)
            raise AgentBoundaryError("agent_transport_unknown")

        with patch.object(AgentClient, "submit", lose_ack):
            review_runs.process_reviews()
        review.refresh_from_db()
        assert review.call_started_at and review.status == "queued"
        review.lease_until = timezone.now() - timedelta(seconds=1)
        review.save(update_fields=["lease_until"])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            review_runs.process_reviews()
            review.refresh_from_db()
            if review.agent_done:
                break
            time.sleep(0.1)
        assert review.status == "succeeded" and review.agent_done
        assert admissions == [str(review.pk)]
        assert WorkReview.objects.count() == 1
        assert len(requests) == (1 if engine == "pi" else 0)
        history = client.get(review_url)
        assert history.status_code == 200
        assert history.data[0]["report"] == review.report
        if engine == "pi":
            assert review.report == model_report
            assert review.input_tokens == 100 and review.output_tokens == 30
            assert review.reserved_tokens == 130
            assert (
                AIUsageRecord.objects.filter(
                    ref_type="work_review", ref_id=str(review.pk)
                ).count()
                == 1
            )
        run.refresh_from_db()
        assert run.status == "succeeded" and run.task.runs.count() == 1
        assert run.files.get().text == text
        assert not AIUsageRecord.objects.filter(
            ref_type="work_run", ref_id=str(run.pk)
        ).exists()
        assert admitted["task"]["id"] == str(run.task_id)
        assert client.delete(ROOT + f"materials/{sources[0]['id']}/").status_code == 204
        assert client.get(review_url).status_code == 409
    finally:
        gateway.close()
