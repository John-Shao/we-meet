"""Check short replies and punctuation-driven TTS prosody without raw model text.

Lexical anchors are diagnostic indicators, not a semantic or acoustic acceptance.
Provider text stays in bounded process memory and only match flags are exported.
"""

import asyncio
import base64
import json
import logging
import os
import re
import sys
import unicodedata

from probe_bilingual_latency import Timeline, probe_case
from probe_bilingual_turn_windows import PROFILES, tuned_vad

from translation.assistant_gateway import safe_error_code

MAX_TEXT_CHARS = 12000
MAX_CASES = 12
HAN_NUMERALS = "一二三四五六七八九十百千万零〇两"


def number_anchor(word, digit, han):
    """Match fixture numbers in English or Chinese without matching 13 as 3."""
    return (
        rf"\b{word}\b|(?<![\d.]){digit}(?![\d.])|"
        rf"(?<![{HAN_NUMERALS}]){han}(?![{HAN_NUMERALS}])"
    )


ANCHORS = {
    "short_yes": {"affirmation": r"\byes\b|\bsure\b|\bcorrect\b|是|对|好"},
    "short_polite_no": {
        "negation": r"\bno\b|\bnot\b|不|不用|没",
        "thanks": r"\bthank|谢",
    },
    "travel_prosody": {
        "shinjuku": r"shin\s*juku|新宿",
        "asakusa": r"asa\s*kusa|sens[oō][\s-]*ji|浅草|淺草",
        "line_three": number_anchor("three", "3", "三"),
        "line_seven": number_anchor("seven", "7", "七"),
    },
}


class Coverage:
    """Accumulate known synthetic fixture output only, exporting match flags."""

    def __init__(self, category):
        """Select fixed lexical rules, never a prompt or provider-generated pattern."""
        self.patterns = ANCHORS[category]
        self.source = []
        self.target = []
        self.chars = 0

    def observe(self, event):
        """Keep fragments together so a clause split does not imply missing content."""
        source, target = event["source"], event["text"]
        self.chars += len(source) + len(target)
        if self.chars > MAX_TEXT_CHARS:
            raise ValueError("prosody_text_limit")
        self.source.append(source)
        self.target.append(target)

    def report(self):
        """Return booleans and sizes without transcripts or translations."""
        texts = {
            "source": unicodedata.normalize("NFKC", " ".join(self.source)).casefold(),
            "target": unicodedata.normalize("NFKC", " ".join(self.target)).casefold(),
        }
        result = {"translation_events": len(self.source)}
        for side, text in texts.items():
            matches = {
                label: bool(re.search(pattern, text))
                for label, pattern in self.patterns.items()
            }
            result[side + "_anchors"] = matches
            result[side + "_all_anchors"] = all(matches.values())
            result[side + "_chars"] = len(text)
        return result


async def main():
    """Run a bounded caller-selected corpus using actual gateway classes."""
    payload = json.load(sys.stdin)
    if not 1 <= len(payload["plan"]) <= MAX_CASES:
        raise ValueError("invalid_prosody_plan_size")
    report = {
        "scope": "synthetic local TTS; real providers; fixture admission; loopback",
        "phone_network_or_acoustic_measured": False,
        "raw_model_content_exported": False,
        "production_settings_changed": False,
        "final_source_validation_preserved": True,
        "cases": [],
    }
    for plan in payload["plan"]:
        fixture = payload["fixtures"][plan["fixture_id"]]
        pcm = base64.b64decode(fixture["pcm"], validate=True)
        if not pcm or len(pcm) % 2 or len(pcm) > 20 * 32000:
            raise ValueError("invalid_prosody_fixture_size")
        source, category = fixture["source"], fixture["category"]
        if source not in {"zh", "en"} or category not in ANCHORS:
            raise ValueError("invalid_prosody_fixture_metadata")
        vad_ms, provider_ms = PROFILES[plan["profile"]]
        os.environ["TRANSLATION_TURN_SILENCE_MS"] = str(provider_ms)
        coverage, trace = Coverage(category), Timeline()

        async def factory(vad_ms=vad_ms):
            return await tuned_vad(vad_ms)

        try:
            case = await probe_case(
                pcm,
                source=source,
                fixed=plan.get("fixed", False),
                trace=trace,
                vad_factory_override=factory,
                settle_seconds=8,
                translation_observer=coverage.observe,
            )
        except Exception as error:
            case = {
                "passed": False,
                "failure_class": type(error).__name__,
                "error_code": safe_error_code(error),
                **trace.report(),
            }
        outputs = case.get("outputs", [])
        case.update(
            plan,
            category=category,
            source=source,
            local_vad_silence_ms=vad_ms,
            provider_silence_ms=provider_ms,
            lexical=coverage.report(),
        )
        case["transport_complete"] = (
            bool(outputs)
            and not case.get("errors")
            and "failure_class" not in case
            and case.get("leases_closed") == 1
            and all(
                o["audio_end"]
                and o["audio_bytes"] > 0
                and o.get("source") == source
                and o.get("target") == ("en" if source == "zh" else "zh")
                for o in outputs
            )
        )
        case["vad_turns"] = sum(
            s["stage"] == "vad_start_of_speech" for s in trace.stages
        )
        case["language_unknown_events"] = sum(
            s["stage"] == "language_unknown" for s in trace.stages
        )
        case["fixture_samples"] = len(pcm) // 2
        report["cases"].append(case)
    report["completed"] = True
    print(json.dumps(report))  # noqa: T201 -- safe diagnostic JSON only


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    asyncio.run(main())
