r"""Summarize bilingual translation gateway latency logs without reading content.

The gateway logs fixed stages for every bilingual session. This script turns one
log window into per-stage percentiles, so a configuration change
(``TRANSLATION_TURN_SILENCE_MS``, ``TRANSLATION_LID_PROBE_MS``, a new image) can
be compared against a recorded baseline.

Collect a window on the machine that owns the cluster:

    kubectl -n meet logs deploy/meet-agent-capture-translation --since=10m \\
        | python src/agents/evaluations/bilingual_latency/summarize.py

    python src/agents/evaluations/bilingual_latency/summarize.py gateway.log --json

Stages, in the order one sentence travels them:

``language_probe``              one classifier round trip
``language_selected``           local VAD start -> forwarded direction locked
``translation_first_audio``     first forwarded frame -> first translated audio
``translation_audio_delivered`` audio already upstream -> handed to the phone
``speech_end->result_ready``    local VAD end -> whole reply delivered; this is
                                the stage the server turn window controls

Only durations, fixed error codes, language codes and the short per-connection
key are read. No PCM, transcript, voice or credential content is involved.
"""

import argparse
import json
import re
import sys
from collections import Counter, deque
from datetime import datetime

PROBE = re.compile(r"language_probe outcome=(\S+) elapsed_ms=(\d+)")
SELECTED = re.compile(r"language_selected source=(\S+) elapsed_ms=(\d+)")
FIRST_AUDIO = re.compile(
    r"translation_first_audio source=(\S+) target=(\S+) elapsed_ms=(\d+)"
)
DELIVERED = re.compile(
    r"translation_audio_delivered target=\S+ gate_ms=(-?\d+) since_speech_ms=(-?\d+)"
)
UNKNOWN = re.compile(r"translation_language_unknown .*buffered_ms=(\d+)")
ERROR = re.compile(r"Bilingual translation interrupted code=(\S+)")
MARKERS = {
    "translation_speech_started": re.compile(r"translation_speech_started"),
    "translation_speech_ended": re.compile(r"translation_speech_ended"),
    "translation_result_ready": re.compile(r"translation_result_ready"),
}
KEY = re.compile(r"session=([0-9a-f]+)")
STAMP = re.compile(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d{3})?)")
STAMP_FORMAT = "%Y-%m-%d %H:%M:%S"
# A reply tail longer than this cannot belong to the same utterance.
PAIR_LIMIT = 15.0
SHARES = (("p50", 0.50), ("p90", 0.90), ("p95", 0.95))
TAIL = "speech_end->result_ready"


def percentile(values, share):
    """Return the nearest-rank percentile of an already collected list."""
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(share * (len(ordered) - 1))))]


def summarise(values):
    """Describe one duration list, keeping an empty stage visible as n=0."""
    if not values:
        return {"n": 0}
    summary = {"n": len(values), "min": min(values), "max": max(values)}
    summary.update({name: percentile(values, share) for name, share in SHARES})
    return summary


def timestamp(stamp):
    """Convert one log timestamp to epoch seconds, or None when absent."""
    if not stamp:
        return None
    text = stamp.group(1)
    millis = 0
    if "," in text:
        text, fraction = text.split(",", 1)
        millis = int(fraction) / 1000
    return datetime.strptime(text, STAMP_FORMAT).timestamp() + millis


def observe_marker(line, when, key, pending, stages):
    """Pair one turn marker with the pending speech end of the same session.

    Returns the matched marker name and how many stale speech ends expired.
    """
    for name, pattern in MARKERS.items():
        if not pattern.search(line):
            continue
        if when is None:
            return name, 0
        unpaired = 0
        if name == "translation_speech_ended":
            pending.setdefault(key, deque()).append(when)
        elif name == "translation_result_ready":
            queue = pending.setdefault(key, deque())
            while queue and when - queue[0] > PAIR_LIMIT:
                queue.popleft()
                unpaired += 1
            if queue:
                stages[TAIL].append(round((when - queue.popleft()) * 1000))
        return name, unpaired
    return None, 0


def collect(lines):
    """Parse one log window into stage durations and bounded counters."""
    stages = {
        "language_probe": [],
        "language_selected": [],
        "translation_first_audio": [],
        "translation_audio_delivered": [],
        "since_speech_ms": [],
        TAIL: [],
    }
    markers = Counter()
    outcomes = Counter()
    locked = Counter()
    directions = Counter()
    errors = Counter()
    unknown_buffered = []
    unknown_utterances = 0
    keys = set()
    pending = {}
    unpaired = 0
    stamps = []
    for line in lines:
        stamp = STAMP.search(line)
        if stamp:
            stamps.append(stamp.group(1))
        key = KEY.search(line)
        key = key.group(1) if key else ""
        if key:
            keys.add(key)
        if match := PROBE.search(line):
            outcomes[match.group(1)] += 1
            stages["language_probe"].append(int(match.group(2)))
            continue
        if match := SELECTED.search(line):
            locked[match.group(1)] += 1
            stages["language_selected"].append(int(match.group(2)))
            continue
        if match := FIRST_AUDIO.search(line):
            directions[f"{match.group(1)}->{match.group(2)}"] += 1
            stages["translation_first_audio"].append(int(match.group(3)))
            continue
        if match := DELIVERED.search(line):
            stages["translation_audio_delivered"].append(int(match.group(1)))
            if int(match.group(2)) >= 0:
                stages["since_speech_ms"].append(int(match.group(2)))
            continue
        if match := UNKNOWN.search(line):
            unknown_utterances += 1
            unknown_buffered.append(int(match.group(1)))
            continue
        if match := ERROR.search(line):
            errors[match.group(1)] += 1
            continue
        name, expired = observe_marker(line, timestamp(stamp), key, pending, stages)
        if name:
            markers[name] += 1
        unpaired += expired
    return {
        "window": {
            "first": stamps[0] if stamps else None,
            "last": stamps[-1] if stamps else None,
            "lines": len(lines),
            "sessions": len(keys),
            "unpaired_speech_end": unpaired,
        },
        "stages": {name: summarise(values) for name, values in stages.items()},
        "probe_outcomes": dict(outcomes),
        "unknown_utterances": unknown_utterances,
        "unknown_buffered_ms": summarise(unknown_buffered),
        "markers": dict(markers),
        "locked_source": dict(locked),
        "directions": dict(directions),
        "error_codes": dict(errors),
    }


def render(summary):
    """Format one summary as operator-facing lines."""
    window = summary["window"]
    lines = [f"window: {window['first']} .. {window['last']}"]
    lines.append(
        f"lines:  {window['lines']}  sessions={window['sessions']}"
        + (
            f"  unpaired_speech_end={window['unpaired_speech_end']}"
            if window["unpaired_speech_end"]
            else ""
        )
    )
    for name, values in summary["stages"].items():
        if not values["n"]:
            lines.append(f"{name:<28} n=0")
            continue
        lines.append(
            f"{name:<28} n={values['n']:<5} p50={values['p50']:<6} "
            f"p90={values['p90']:<6} p95={values['p95']:<6} max={values['max']:<6}"
        )
    if summary["unknown_utterances"]:
        buffered = summary["unknown_buffered_ms"]
        lines.append(
            f"undecided utterances: {summary['unknown_utterances']} "
            f"(buffered_ms p50={buffered.get('p50')} max={buffered.get('max')})"
        )
    for name in (
        "markers",
        "probe_outcomes",
        "locked_source",
        "directions",
        "error_codes",
    ):
        pairs = summary[name]
        lines.append(
            f"{name + ':':<16} "
            + (", ".join(f"{k}={v}" for k, v in sorted(pairs.items())) or "-")
        )
    return lines


def main():
    """Read one log window and print its latency summary."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", nargs="?", help="Log file; read stdin when omitted.")
    parser.add_argument("--json", action="store_true", help="Emit the summary as JSON.")
    args = parser.parse_args()
    if args.log:
        with open(args.log, encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
    else:
        lines = sys.stdin.read().splitlines()
    summary = collect(lines)
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))  # noqa: T201
        return
    print("\n".join(render(summary)))  # noqa: T201 -- operator-facing summary


if __name__ == "__main__":
    main()
