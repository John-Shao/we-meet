"""Provider responses never bypass local provenance checks or overwrite a run."""

import json
import sys
from types import SimpleNamespace

import pytest

from core.tests.evaluations import run_structured_rerank as runner

PLAN = [
    {
        "id": "control",
        "question": "Question",
        "candidates": [
            {"id": "a", "title": "Title", "text": "source evidence"},
        ],
    }
]


def configure(tmp_path, monkeypatch):
    plan = tmp_path / "plan.json"
    output = tmp_path / "draws.json"
    plan.write_text(json.dumps(PLAN), encoding="utf-8")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "runner",
            "--plan",
            str(plan),
            "--output",
            str(output),
            "--model",
            "qwen3.8-flash",
            "--base-url",
            "https://provider.invalid/v1",
        ],
    )
    monkeypatch.setenv("MIAOJI_EVAL_API_KEY", "test-only")
    monkeypatch.setattr(runner, "build_plan", lambda: PLAN)
    return output


@pytest.mark.parametrize(
    "raw,finish,invalid",
    [
        (
            '{"decision":"evidence","selected":[{"id":"a","evidence":"source"}]}',
            "stop",
            False,
        ),
        (
            '{"decision":"evidence","selected":[{"id":"a","evidence":"invented"}]}',
            "stop",
            True,
        ),
        ('{"decision":"no_evidence","selected":[]}', "length", True),
        ('["a"]', "stop", True),
    ],
)
def test_provider_response_is_validated(tmp_path, monkeypatch, raw, finish, invalid):
    output = configure(tmp_path, monkeypatch)
    requests = []

    def post(url, **kwargs):
        requests.append(kwargs["json"])
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {
                "model": "qwen3.8-flash",
                "usage": {"total_tokens": 1},
                "choices": [{"finish_reason": finish, "message": {"content": raw}}],
            },
        )

    monkeypatch.setattr(runner.requests, "post", post)
    assert runner.main() == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["complete"] and len(report["cases"]) == len(requests) == 2
    assert all(r["response_format"]["json_schema"]["strict"] for r in requests)
    assert all("max_tokens" not in r for r in requests)
    for row in report["cases"]:
        assert row["raw"] == raw
        assert bool(row.get("invalid_output")) == invalid
        assert row["decision"] == ("invalid" if invalid else "evidence")
        if invalid:
            assert row["selected"] == []


def test_existing_draws_not_overwritten(tmp_path, monkeypatch):
    output = configure(tmp_path, monkeypatch)
    output.write_text("existing evidence", encoding="utf-8")
    monkeypatch.setattr(
        runner.requests, "post", lambda *a, **k: pytest.fail("unexpected request")
    )
    with pytest.raises(FileExistsError):
        runner.main()
    assert output.read_text(encoding="utf-8") == "existing evidence"


def test_changed_plan_rejected_before_provider_request(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    monkeypatch.setattr(runner, "build_plan", lambda: [])
    monkeypatch.setattr(
        runner.requests, "post", lambda *a, **k: pytest.fail("unexpected request")
    )
    with pytest.raises(ValueError, match="frozen"):
        runner.main()
