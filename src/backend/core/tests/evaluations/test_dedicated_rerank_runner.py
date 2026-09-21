"""Protect paid runs and persist failed receipts without silently changing models."""

import json
import sys
from types import SimpleNamespace

import pytest
import requests

from core.tests.evaluations import run_dedicated_rerank as runner
from core.tests.evaluations.dedicated_rerank import MODEL

PLAN = [
    {
        "id": "case",
        "question": "test",
        "candidates": [{"id": "a", "title": "T", "text": "source"}],
    }
]


def configure(tmp_path, monkeypatch):
    plan, output = tmp_path / "plan.json", tmp_path / "out.json"
    plan.write_text(json.dumps(PLAN), encoding="utf-8")
    monkeypatch.setattr(
        sys, "argv", ["runner", "--plan", str(plan), "--output", str(output)]
    )
    monkeypatch.setenv("MIAOJI_EVAL_API_KEY", "test-only")
    monkeypatch.setattr(runner, "build_plan", lambda: PLAN)
    return output


@pytest.mark.parametrize("kind", ["valid", "bad_index", "http_error"])
def test_response_receipt(tmp_path, monkeypatch, kind):
    output = configure(tmp_path, monkeypatch)
    calls = []

    def post(url, **kwargs):
        calls.append(kwargs["json"])

        def status():
            if kind == "http_error":
                raise requests.HTTPError("test HTTP error")

        return SimpleNamespace(
            status_code=403 if kind == "http_error" else 200,
            raise_for_status=status,
            json=lambda: {
                "model": MODEL,
                "usage": {"total_tokens": 8},
                "results": [
                    {"index": 9 if kind == "bad_index" else 0, "relevance_score": 0.8}
                ],
            },
        )

    monkeypatch.setattr(runner.requests, "post", post)
    if kind == "valid":
        assert runner.main() == 0
    else:
        with pytest.raises((ValueError, requests.HTTPError)):
            runner.main()
    data = json.loads(output.read_text(encoding="utf-8"))
    assert len(calls) == len(data["cases"]) == 1
    assert data["complete"] == (kind == "valid")
    assert bool(data["cases"][0].get("invalid_response")) == (kind != "valid")


def test_no_overwrite(tmp_path, monkeypatch):
    output = configure(tmp_path, monkeypatch)
    output.write_text("keep", encoding="utf-8")
    monkeypatch.setattr(
        runner.requests, "post", lambda *a, **k: pytest.fail("unexpected call")
    )
    with pytest.raises(FileExistsError):
        runner.main()
    assert output.read_text(encoding="utf-8") == "keep"


def test_no_changed_plan(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    monkeypatch.setattr(runner, "build_plan", lambda: [])
    monkeypatch.setattr(
        runner.requests, "post", lambda *a, **k: pytest.fail("unexpected call")
    )
    with pytest.raises(ValueError):
        runner.main()
