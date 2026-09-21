"""A specific empty-recognition reason must not hide partial or lost inputs."""

import uuid

import pytest

from core.tests.services.test_capture_transcription import (
    acknowledge,
    agent,
    claim,
    control,
    enabled,
    final,
    finish,
    request_job,
    running,
    saved,
)

pytestmark = pytest.mark.django_db


def empty_receipt(worker, **overrides):
    """One fully consumed, explicitly empty provider task, not a successful run."""
    return {
        "worker_id": str(worker),
        "provider_finished": False,
        "final_sequence": 0,
        "failure_code": "no_speech_detected",
        "tasks": [
            {
                "task_id": str(uuid.uuid4()),
                "finished": False,
                "input_samples": 16000,
                "billed_seconds": None,
            }
        ],
        **overrides,
    }


def test_reason_is_additive_idempotent_and_never_publishes():
    user, capture, worker, job = running()
    assert job["supports_failure_code"] is True
    acknowledge(job, worker)
    payload = empty_receipt(worker)
    response = agent(f"{job['id']}/finish/", payload)
    assert response.status_code == 200
    assert response.data["status"] == "incomplete"
    assert response.data["error_code"] == "no_speech_detected"
    assert agent(f"{job['id']}/finish/", payload).data == response.data
    changed = {key: value for key, value in payload.items() if key != "failure_code"}
    assert agent(f"{job['id']}/finish/", changed).status_code == 409
    capture.refresh_from_db()
    assert capture.active_transcription_id is None


@pytest.mark.parametrize(
    "problem",
    ["unacknowledged", "samples", "tasks", "partial_text", "unknown_code", "legacy"],
)
def test_reason_requires_complete_input_and_no_published_text(problem):
    user, capture, worker, job = running()
    if problem != "unacknowledged":
        acknowledge(job, worker)
    payload = empty_receipt(worker)
    if problem == "samples":
        payload["tasks"][0]["input_samples"] = 15999
    elif problem == "tasks":
        payload["tasks"] = []
    elif problem == "partial_text":
        assert final(job["id"], worker)[0].status_code == 201
        payload["final_sequence"] = 1
    elif problem == "unknown_code":
        payload["failure_code"] = "PRIVATE provider response"
    elif problem == "legacy":
        payload.pop("failure_code")
    response = agent(f"{job['id']}/finish/", payload)
    if problem == "unknown_code":
        assert response.status_code == 400
    else:
        assert response.status_code == 200
        assert response.data["status"] == "incomplete"
        assert response.data["error_code"] == "provider_or_delivery_incomplete"


def test_empty_retry_preserves_previous_successful_generation():
    user, capture, worker, old = running()
    acknowledge(old, worker)
    assert final(old["id"], worker)[0].status_code == 201
    assert finish(old["id"], worker).data["status"] == "succeeded"
    assert request_job(user, capture, expected=old["id"]).status_code == 201
    worker, new = claim()
    assert control(new["id"], worker, "begin").status_code == 200
    acknowledge(new, worker)
    response = agent(f"{new['id']}/finish/", empty_receipt(worker))
    assert response.data["error_code"] == "no_speech_detected"
    capture.refresh_from_db()
    assert str(capture.active_transcription_id) == old["id"]


def test_incomplete_source_cannot_be_relabelled_as_no_speech():
    user, capture = saved(gaps=True)
    assert request_job(user, capture, allow=True).status_code == 201
    worker, job = claim()
    assert control(job["id"], worker, "begin").status_code == 200
    for index, chunk in enumerate(job["inputs"]["chunks"], 1):
        assert (
            control(
                job["id"], worker, "ack_input", index=index, checksum=chunk["checksum"]
            ).status_code
            == 200
        )
    payload = empty_receipt(worker)
    payload["tasks"] = [
        {
            "task_id": str(uuid.uuid4()),
            "finished": False,
            "input_samples": 16000,
            "billed_seconds": None,
        }
        for _ in range(job["inputs"]["runs"])
    ]
    response = agent(f"{job['id']}/finish/", payload)
    assert response.status_code == 200
    assert response.data["error_code"] == "provider_or_delivery_incomplete"
