"""Compare diagnostic-only VAD/provider windows with unchanged routing checks.

Fixtures include controlled artificial pauses and sequential language changes.
Output counts describe fragmentation, not semantic or acoustic acceptance.
"""

import asyncio
import base64
import json
import logging
import os
import sys

from livekit import rtc
from livekit.plugins import silero
from probe_bilingual_latency import Timeline, probe_case

from translation.assistant_gateway import safe_error_code

PROFILES = {
    "baseline": (550, 1000),
    "moderate": (400, 700),
    "aggressive": (300, 500),
    "provider_only": (550, 700),
}
MAX_PLAN_CASES = 20


async def tuned_vad(silence_ms):
    """Own a separate model so cached production options cannot be mutated."""
    model = await asyncio.to_thread(
        silero.VAD.load,
        min_speech_duration=0.05,
        min_silence_duration=silence_ms / 1000,
        prefix_padding_duration=0.25,
        max_buffered_speech=30.0,
    )
    return model.stream()


async def boundaries(pcm, silence_ms):
    """Calibrate sample boundaries offline without a paid provider connection."""
    stream = await tuned_vad(silence_ms)
    rows = []

    async def consume():
        async for event in stream:
            kind = event.type.value
            if kind in {"start_of_speech", "end_of_speech"}:
                rows.append(
                    {
                        "type": kind,
                        "sample_index": event.samples_index,
                        "speech_samples": round(event.speech_duration * 16000),
                        "silence_samples": round(event.silence_duration * 16000),
                    }
                )

    task = asyncio.create_task(consume())
    try:
        padded = pcm + bytes(32000)
        for offset in range(0, len(padded), 3200):
            frame = padded[offset : offset + 3200]
            stream.push_frame(rtc.AudioFrame(frame, 16000, 1, len(frame) // 2))
        stream.end_input()
        await task
    finally:
        await stream.aclose()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    return rows


def paused_fixture(pcm, rows):
    """Insert 500 ms at the midpoint of VAD speech; never remove source samples."""
    starts = [r for r in rows if r["type"] == "start_of_speech"]
    ends = [r for r in rows if r["type"] == "end_of_speech"]
    if len(starts) != 1 or len(ends) != 1:
        raise ValueError("ambiguous_fixture_speech_span")
    end = ends[0]["sample_index"] - ends[0]["silence_samples"]
    start = max(0, starts[0]["sample_index"] - starts[0]["speech_samples"])
    midpoint = (start + end) // 2
    return pcm[: midpoint * 2] + bytes(16000) + pcm[midpoint * 2 :], midpoint


async def main():
    """Run a caller-selected bounded matrix, exporting no model content."""
    payload = json.load(sys.stdin)
    if not 1 <= len(payload["plan"]) <= MAX_PLAN_CASES:
        raise ValueError("invalid_turn_window_plan_size")
    fixtures = {
        k: base64.b64decode(v, validate=True) for k, v in payload["fixtures"].items()
    }
    if set(fixtures) != {"zh", "en"} or any(
        not p or len(p) % 2 or len(p) > 10 * 32000 for p in fixtures.values()
    ):
        raise ValueError("invalid_turn_window_fixtures")
    calibration = {lang: await boundaries(pcm, 550) for lang, pcm in fixtures.items()}
    pauses = {
        lang: paused_fixture(pcm, calibration[lang]) for lang, pcm in fixtures.items()
    }
    report = {
        "scope": "isolated loopback provider probe; no phone or acoustic output",
        "production_settings_changed": False,
        "final_source_validation_preserved": True,
        "pause_kind": (
            "artificial 500ms insertion; may split a phoneme, not a natural hesitation"
        ),
        "calibration": calibration,
        "cases": [],
    }
    for plan in payload["plan"]:
        profile, scenario = plan["profile"], plan["scenario"]
        vad_ms, provider_ms = PROFILES[profile]
        source = plan.get("source", "zh")
        if scenario == "plain":
            pcm, expected = fixtures[source], [source]
        elif scenario == "pause":
            pcm, expected = pauses[source][0], [source]
        elif scenario == "alternating":
            pcm = fixtures["zh"] + bytes(5 * 32000) + fixtures["en"]
            expected = ["zh", "en"]
        else:
            raise ValueError("invalid_turn_window_scenario")
        os.environ["TRANSLATION_TURN_SILENCE_MS"] = str(provider_ms)
        trace = Timeline()

        async def factory(vad_ms=vad_ms):
            return await tuned_vad(vad_ms)

        try:
            case = await probe_case(
                pcm,
                source=source,
                fixed=False,
                trace=trace,
                vad_factory_override=factory,
                settle_seconds=8,
                expected_sources=expected,
            )
        except Exception as error:
            case = {
                "passed": False,
                "failure_class": type(error).__name__,
                "error_code": safe_error_code(error),
                **trace.report(),
            }
        case.update(plan, local_vad_silence_ms=vad_ms, provider_silence_ms=provider_ms)
        case["vad_turns"] = sum(
            s["stage"] == "vad_start_of_speech" for s in trace.stages
        )
        case["shape_matches_fixture_expectation"] = case["passed"]
        if scenario == "pause":
            case["pause_inserted_at_sample"] = pauses[source][1]
        report["cases"].append(case)
    report["passed"] = all(c["passed"] for c in report["cases"])
    print(json.dumps(report))  # noqa: T201 -- safe diagnostic JSON only


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    asyncio.run(main())
