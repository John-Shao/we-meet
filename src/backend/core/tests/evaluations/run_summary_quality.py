"""Run the real summary prompt/parser on frozen snapshots without database writes."""

import argparse
import hashlib
import json
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


class ObservedClient:
    """Bind each provider response to its own immutable input case."""

    def __init__(self, client, observed):
        self.client, self.observed = client, observed

    def chat(self, **kwargs):
        self.observed["prompt_sha256"] = hashlib.sha256(
            kwargs["system"].encode()
        ).hexdigest()
        raw = self.client.chat(**kwargs)
        self.observed["raw_output"] = raw
        return raw


def failure_report(error, observed):
    """Project safe enums only; never include provider exception text."""
    observed.update(
        status="failed",
        error_code="provider_or_validation_failed",
        failure_stage="validation" if "raw_output" in observed else "provider_or_setup",
    )
    status = getattr(error, "status_code", None)
    if type(status) is int and 400 <= status <= 599:
        observed["http_status"] = status
    allowed = {
        "ValueError",
        "AttributeError",
        "AuthenticationError",
        "BadRequestError",
        "APITimeoutError",
        "RateLimitError",
        "ValidationError",
        "TypeError",
    }
    observed["failure_type"] = (
        type(error).__name__ if type(error).__name__ in allowed else "other"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()
    if not args.execute:
        parser.error("Explicit --execute is required for paid provider requests")
    if args.output.exists():
        parser.error("Refusing to overwrite an earlier result")
    data = args.inputs.read_bytes()
    cases = json.loads(data)["cases"]
    if not 1 <= len(cases) <= 8 or len({c["id"] for c in cases}) != len(cases):
        parser.error("Expected 1–8 uniquely named frozen cases")

    import configurations  # noqa: PLC0415 -- load Django only after the execution gate

    configurations.setup()
    from django.conf import settings  # noqa: PLC0415

    from core.services.llm_client import LLMClient  # noqa: PLC0415
    from core.services.meeting_summary_versions import (  # noqa: PLC0415
        _generate_content,
    )

    report = {
        "label": args.label,
        "inputs_sha256": hashlib.sha256(data).hexdigest(),
        "scope": "Local production prompt/parser; no database, notifications or tasks.",
        "semantic_review": "pending; valid references do not prove factual support",
        "cases": [],
    }

    def save():
        args.output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )

    # All synthetic input snapshots are validated before the first paid call.
    for case in cases:
        rows = case["snapshot"]["segments"]
        if not rows or len({r["segment_id"] for r in rows}) != len(rows):
            parser.error("Source snapshots must have unique, nonempty segments")
        for row in rows:
            for field in (
                "segment_id",
                "segment_revision",
                "start_ms",
                "end_ms",
                "text",
            ):
                if field not in row:
                    parser.error("Source snapshot is incomplete")
    save()
    client = LLMClient(
        api_key=settings.DASHSCOPE_API_KEY,
        model=settings.MEETING_SUMMARY_MODEL,
        base_url=settings.MEETING_SUMMARY_BASE_URL,
        timeout=90,
        max_retries=0,
    )
    try:
        for case in cases:
            observed = {"id": case["id"], "model": client.model, "status": "attempted"}
            report["cases"].append(observed)
            save()
            job = SimpleNamespace(
                configuration={"stage": "final"},
                record=SimpleNamespace(organization=None),
                record_id=case["id"],
                input_snapshot=SimpleNamespace(segments=case["snapshot"]["segments"]),
            )
            started = time.monotonic()

            try:
                # Only persistence/checkpoint hooks are replaced. Prompt construction,
                # input encoding, provider transport and citation validation are real.
                with (
                    patch("core.services.meeting_summary_versions._checkpoint"),
                    patch(
                        "core.services.meeting_summary_versions.ai_usage.make_sink",
                        return_value=None,
                    ),
                ):
                    observed["content"] = _generate_content(
                        job, ObservedClient(client, observed), 1
                    )
                observed["status"] = "succeeded"
            except Exception as error:  # noqa: BLE001 -- retain failures without exposing provider bodies
                failure_report(error, observed)
            observed["elapsed_ms"] = round((time.monotonic() - started) * 1000)
            save()
            print(  # noqa: T201 -- bounded progress, no response bodies or credentials
                json.dumps({k: observed[k] for k in ("id", "status", "elapsed_ms")}),
                flush=True,
            )
            if observed["status"] == "failed":
                break
    finally:
        client.close()


if __name__ == "__main__":
    main()
