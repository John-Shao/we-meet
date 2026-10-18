"""Isolated one-shot handshake overlap; never enable it on a production gateway."""

import asyncio
import base64
import json
import logging
import os
import sys
import time

from probe_bilingual_latency import Timeline, probe_case
from probe_bilingual_prosody import Coverage

from plugins.qwen.omni.speech_language_id import SpeechLanguageDetector
from translation.assistant_gateway import safe_error_code

MAX_CASES = 12


# Compatibility name for archived diagnostic commands.
SpeechHandshakeDetector = SpeechLanguageDetector


async def prepare_on_admitted_speech(connection, trace):
    """Honor fixed routing and unknown-language backoff before opening a classifier."""
    router = connection.audio_input.router
    if router.fixed_source is not None or time.monotonic() < router.probe_after:
        trace.mark("language_speech_prepare_skipped")
        return
    trace.mark("language_speech_prepare_requested")
    await connection.detector.begin_speech()


async def main():
    """Compare an independent candidate process with the current cold baseline."""
    payload = json.load(sys.stdin)
    if not 1 <= len(payload["plan"]) <= MAX_CASES:
        raise ValueError("invalid_handshake_plan_size")
    os.environ["TRANSLATION_TURN_SILENCE_MS"] = "1000"
    report = {
        "scope": "fixture admission, synthetic PCM, real providers, loopback",
        "product_defaults_changed": False,
        "production_deployed": False,
        "final_source_validation_preserved": True,
        "cases": [],
    }
    for plan in payload["plan"]:
        fixture = payload["fixtures"][plan["fixture_id"]]
        pcm = base64.b64decode(fixture["pcm"], validate=True)
        if not pcm or len(pcm) % 2 or len(pcm) > 20 * 32000:
            raise ValueError("invalid_handshake_fixture")
        quiet = fixture["category"] == "silence"
        coverage = None if quiet else Coverage(fixture["category"])
        trace = Timeline()
        overlap = plan["variant"] == "speech_start"
        try:
            case = await probe_case(
                pcm,
                source=fixture["source"],
                fixed=False,
                trace=trace,
                detector_base=SpeechHandshakeDetector if overlap else None,
                speech_start_observer=prepare_on_admitted_speech if overlap else None,
                translation_observer=coverage.observe if coverage else None,
                settle_seconds=8,
                expect_silence=quiet,
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
                and bool(outputs)
                and all(
                    o["audio_end"]
                    and o["audio_bytes"] > 0
                    and o.get("source") == fixture["source"]
                    and o.get("target") == ("en" if fixture["source"] == "zh" else "zh")
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
    print(json.dumps(report))  # noqa: T201 -- bounded metadata only


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    asyncio.run(main())
