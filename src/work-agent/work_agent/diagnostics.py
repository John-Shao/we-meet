"""Bounded operator diagnostics; no prompts, responses, paths or credentials."""

import json
from pathlib import Path

from .contract import digest

CONTRACT = "work-task-failure/v1"
CODES = {
    "invalid_review_report",
    "incomplete_agent_result",
    "upstream_command_failed",
    "prompt_not_executed",
    "runtime_version_mismatch",
    "review_tool_forbidden",
}


def failure(error, directory):
    code = str(error) if type(error) in (ValueError, RuntimeError) else "task_failed"
    result = {"contract": CONTRACT, "code": code if code in CODES else "task_failed"}
    try:
        candidate = Path(directory) / "runtime-home/review-candidate.json"
        if candidate.is_symlink() or candidate.stat().st_size > 100000:
            return result
        value = json.loads(candidate.read_text("utf-8"))
        result["accepted"] = value.get("accepted") is True
        result["settled"] = value.get("settled") is True
        result["normal_stop"] = value.get("stop_reason") in {"stop", "end_turn"}
        report = json.loads(value["response"])
        if not isinstance(report, dict):
            return result
        if report.get("verdict") in {"no_issues", "needs_changes", "inconclusive"}:
            result["verdict"] = report["verdict"]
        findings = report.get("findings")
        missing = report.get("missing_information")
        if isinstance(findings, list):
            result["findings_count"] = min(len(findings), 21)
        if isinstance(missing, list):
            result["missing_count"] = min(len(missing), 21)
        request = json.loads((Path(directory) / "request.json").read_text("utf-8"))
        files = {item["name"]: item["text"] for item in request["files"]}
        invalid_names = invalid_hashes = invalid_quotes = 0
        for finding in (findings or [])[:20]:
            for ref in finding.get("evidence", [])[:5]:
                text = files.get(ref.get("file"))
                if text is None:
                    invalid_names += 1
                elif ref.get("sha256") != digest(text.encode()):
                    invalid_hashes += 1
                elif (
                    not isinstance(ref.get("quote"), str)
                    or not ref["quote"].strip()
                    or ref["quote"] not in text
                ):
                    invalid_quotes += 1
        result.update(
            invalid_names=invalid_names,
            invalid_hashes=invalid_hashes,
            invalid_quotes=invalid_quotes,
        )
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        pass
    return result


def validate(value):
    if (
        not isinstance(value, dict)
        or value.get("contract") != CONTRACT
        or value.get("code") not in CODES | {"task_failed"}
    ):
        return None
    result = {"contract": CONTRACT, "code": value["code"]}
    for name in ("accepted", "settled", "normal_stop"):
        if type(value.get(name)) is bool:
            result[name] = value[name]
    if value.get("verdict") in {"no_issues", "needs_changes", "inconclusive"}:
        result["verdict"] = value["verdict"]
    for name in (
        "findings_count",
        "missing_count",
        "invalid_names",
        "invalid_hashes",
        "invalid_quotes",
    ):
        if type(value.get(name)) is int and 0 <= value[name] <= 100:
            result[name] = value[name]
    return result
