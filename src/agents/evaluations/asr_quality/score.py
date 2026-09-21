"""Score frozen ASR outputs without network; missing/failed cases stay visible."""

import argparse
import itertools
import json
import math
import unicodedata
from pathlib import Path

ROOT = Path(__file__).parent
MAX_SPEAKERS = 4
MAX_SEGMENTS = 2000
MAX_SEGMENT_CHARS = 10000
MAX_OUTPUT_CHARS = 5000


def normalize(text):
    """Ignore case, punctuation and whitespace, retaining letters and numbers."""
    return "".join(
        c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum()
    )


def distance(left, right):
    """Compute character edit distance with one-row memory."""
    previous = list(range(len(right) + 1))
    for index, a in enumerate(left, 1):
        row = [index]
        for offset, b in enumerate(right, 1):
            row.append(
                min(row[-1] + 1, previous[offset] + 1, previous[offset - 1] + (a != b))
            )
        previous = row
    return previous[-1]


def speaker_accuracy(reference, hypothesis):
    """Permutation-invariant utterance-window coverage, with missing speech wrong."""
    duration = sum(s["end_ms"] - s["start_ms"] for s in reference)
    if not duration:
        return None
    identities = sorted(
        {
            s.get("speaker")
            for s in hypothesis
            if s.get("speaker") not in {None, "", "unknown"}
        }
    )
    expected = sorted({s["speaker"] for s in reference})
    if not identities:
        return 0.0
    if len(identities) > MAX_SPEAKERS or len(expected) > MAX_SPEAKERS:
        raise ValueError("Speaker scorer supports at most four identities")
    # Unique mappings; extra or merged predicted identities remain penalized.
    labels = expected + [None] * max(0, len(identities) - len(expected))
    best = 0
    for assigned in set(itertools.permutations(labels, len(identities))):
        mapping = dict(zip(identities, assigned, strict=True))
        correct = 0
        for ref in reference:
            # Non-overlapping hypotheses are required by input validation.
            for hyp in hypothesis:
                if mapping.get(hyp.get("speaker")) == ref["speaker"]:
                    correct += max(
                        0,
                        min(ref["end_ms"], hyp["end_ms"])
                        - max(ref["start_ms"], hyp["start_ms"]),
                    )
        best = max(best, correct)
    return round(best / duration, 4)


def validate_segments(segments, duration_ms):
    """Reject malformed time or text before it can inflate quality metrics."""
    if not isinstance(segments, list) or len(segments) > MAX_SEGMENTS:
        raise ValueError("Invalid segment count")
    previous = 0
    for item in segments:
        start, end = item["start_ms"], item["end_ms"]
        if (
            any(
                type(x) not in (int, float) or not math.isfinite(x)
                for x in (start, end)
            )
            or not previous <= start < end <= duration_ms
            or not isinstance(item["text"], str)
            or len(item["text"]) > MAX_SEGMENT_CHARS
            or (
                item.get("speaker") is not None and not isinstance(item["speaker"], str)
            )
        ):
            raise ValueError("Invalid or overlapping segment")
        previous = end


def score(manifest, results):
    """Keep failed and missing cases in the denominator and report noise pairs."""
    indexed = {}
    expected_ids = {case["id"] for case in manifest["cases"]}
    for result in results["cases"]:
        if result["id"] in indexed or result["id"] not in expected_ids:
            raise ValueError("Duplicate or unknown case")
        indexed[result["id"]] = result
    report = []
    for case in manifest["cases"]:
        observed = indexed.get(case["id"])
        row = {
            "id": case["id"],
            "category": case["category"],
            "synthetic": case["synthetic"],
        }
        if observed is None:
            report.append({**row, "status": "not_evaluated"})
            continue
        if observed["sha256"] != case["sha256"]:
            raise ValueError("Audio hash does not match frozen corpus")
        if observed["status"] not in {"succeeded", "failed"}:
            raise ValueError("Invalid result status")
        elapsed = observed["elapsed_ms"]
        if (
            type(elapsed) not in (int, float)
            or not math.isfinite(elapsed)
            or elapsed < 0
        ):
            raise ValueError("Invalid elapsed time")
        segments = observed.get("segments", [])
        validate_segments(segments, case["duration_ms"])
        target = normalize("".join(s["text"] for s in case["segments"]))
        actual = normalize("".join(s["text"] for s in segments))
        if len(actual) > MAX_OUTPUT_CHARS:
            raise ValueError("Output exceeds quality fixture budget")
        terms = case["terms"]
        row.update(
            status=observed["status"],
            elapsed_ms=elapsed,
            cer=round(distance(target, actual) / len(target), 4) if target else None,
            silence_hallucinated_chars=len(actual) if not target else None,
            term_recall=round(
                sum(normalize(term) in actual for term in terms) / len(terms), 4
            )
            if terms
            else None,
            speaker_window_accuracy=speaker_accuracy(case["segments"], segments),
            speaker_labels_available=any(
                s.get("speaker") not in {None, "", "unknown"} for s in segments
            ),
            manual_fact_todo_review="pending",
        )
        report.append(row)
    by_id = {row["id"]: row for row in report}
    for case, row in zip(manifest["cases"], report, strict=True):
        clean = by_id.get(case.get("clean_case"), {})
        if (
            case.get("snr_db") is not None
            and row.get("cer") is not None
            and clean.get("cer") is not None
        ):
            row["cer_delta_from_clean"] = round(row["cer"] - clean["cer"], 4)
    return {
        "version": 1,
        "expected_cases": len(report),
        "evaluated_cases": len(indexed),
        "succeeded_cases": sum(r["status"] == "succeeded" for r in report),
        "scope": "Synthetic regression baseline; not human meeting accuracy or DER.",
        "cases": report,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "manifest.json")
    parser.add_argument("--results", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    measured = score(
        json.loads(args.manifest.read_text(encoding="utf-8")),
        json.loads(args.results.read_text(encoding="utf-8")),
    )
    args.output.write_text(
        json.dumps(measured, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
