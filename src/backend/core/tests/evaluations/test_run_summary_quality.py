"""The paid evaluator must gate calls and preserve safe failure evidence."""

import json
from unittest.mock import Mock

import pytest

from core.tests.evaluations.run_summary_quality import (
    ObservedClient,
    failure_report,
    main,
)


def test_execution_and_overwrite_guards_precede_django(monkeypatch, tmp_path):
    target = tmp_path / "first.json"
    args = [
        "evaluate",
        "--inputs",
        "absent.json",
        "--output",
        str(target),
        "--label",
        "test",
    ]
    monkeypatch.setattr("sys.argv", args)
    with pytest.raises(SystemExit) as stopped:
        main()
    assert stopped.value.code == 2
    assert not target.exists()
    target.write_text("first result", encoding="utf-8")
    monkeypatch.setattr("sys.argv", [*args, "--execute"])
    with pytest.raises(SystemExit):
        main()
    assert target.read_text(encoding="utf-8") == "first result"


def test_failure_evidence_never_contains_provider_body():
    error = ValueError("PRIVATE signed URL or token")
    error.status_code = 401
    row = {}
    failure_report(error, row)
    assert row["http_status"] == 401
    assert row["failure_stage"] == "provider_or_setup"
    assert "PRIVATE" not in json.dumps(row)
    row["raw_output"] = "own synthetic response"
    failure_report(error, row)
    assert row["failure_stage"] == "validation"


def test_raw_outputs_remain_bound_to_their_own_case():
    first, second = {}, {}
    client = Mock()
    client.chat.side_effect = ['{"overview":"first"}', '{"overview":"second"}']
    a, b = ObservedClient(client, first), ObservedClient(client, second)
    a.chat(system="first prompt", user="synthetic text")
    b.chat(system="second prompt", user="synthetic text")
    assert json.loads(first["raw_output"])["overview"] == "first"
    assert json.loads(second["raw_output"])["overview"] == "second"
    assert first["prompt_sha256"] != second["prompt_sha256"]
