"""Exercise the actual default gateway detector and router with synthetic fixtures."""

import asyncio
import base64
import json
import logging
import os
import sys

from probe_bilingual_latency import Timeline, probe_case
from probe_bilingual_prosody import Coverage

from translation.assistant_gateway import safe_error_code

MAX_CASES = 12


async def main():
    """Observe the default detector after readiness without replacing its factory."""
    payload = json.load(sys.stdin)
    if not 1 <= len(payload["plan"]) <= MAX_CASES:
        raise ValueError("invalid_formal_handshake_plan")
    os.environ["TRANSLATION_TURN_SILENCE_MS"] = "1000"
    report = {
        "actual_gateway_default_detector": True,
        "diagnostic_vad_hook": False,
        "scope": "synthetic PCM, fixture admission, loopback; real providers",
        "product_deployed": False,
        "cases": [],
    }
    for plan in payload["plan"]:
        fixture = payload["fixtures"][plan["fixture_id"]]
        pcm = base64.b64decode(fixture["pcm"], validate=True)
        if not pcm or len(pcm) % 2 or len(pcm) > 20 * 32000:
            raise ValueError("invalid_formal_handshake_fixture")
        quiet = fixture["category"] == "silence"
        coverage = None if quiet else Coverage(fixture["category"])
        sources = fixture.get("source_sequence", [fixture["source"]])
        trace = Timeline()
        try:
            case = await probe_case(
                pcm,
                source=fixture["source"],
                fixed=plan.get("fixed", False),
                trace=trace,
                settle_seconds=8,
                expect_silence=quiet,
                expected_sources=sources,
                translation_observer=coverage.observe if coverage else None,
                use_gateway_default_detector=True,
            )
        except Exception as error:
            case = {
                "passed": False,
                "failure_class": type(error).__name__,
                "error_code": safe_error_code(error),
                **trace.report(),
            }
        outputs = case.get("outputs", [])
        complete = (
            not case.get("errors")
            and "failure_class" not in case
            and case.get("leases_closed") == 1
        )
        if quiet:
            complete = (
                complete
                and not outputs
                and not any(
                    s["stage"] in {"vad_start_of_speech", "language_connect_start"}
                    for s in trace.stages
                )
            )
        else:
            complete = (
                complete
                and {o.get("source") for o in outputs} == set(sources)
                and all(
                    o["audio_end"]
                    and o["audio_bytes"] > 0
                    and o.get("target") == ("en" if o.get("source") == "zh" else "zh")
                    for o in outputs
                )
            )
        case.update(
            plan,
            category=fixture["category"],
            transport_complete=complete,
            lexical=coverage.report() if coverage else None,
        )
        report["cases"].append(case)
    report["completed"] = True
    print(json.dumps(report))  # noqa: T201 -- bounded metadata, no model text or audio


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    asyncio.run(main())
