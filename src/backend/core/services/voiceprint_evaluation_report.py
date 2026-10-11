"""Shared standard-library summary of private speaker-query results.

No audio, embeddings, database access, calibration or release approval. Input
claims about consent, ground truth and extraction must be reviewed separately.
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

MAX_BYTES = 8 * 1024 * 1024
TOKEN = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
FEATURE_SPACE = (
    "qwen3tts-speaker:2ce8c66530f607837b8cdb4f95ce4a359bfee604dc2a2731adc46b89866c5df5"
)
STATUSES = {
    "suggested",
    "unknown",
    "ambiguous",
    "insufficient_audio",
    "mixed_speaker",
    "unavailable",
}


class EvaluationError(ValueError):
    """Fixed error code; never echo private input or a path."""


def require(condition, code="invalid_evaluation"):
    if not condition:
        raise EvaluationError(code)


def fields(value, expected):
    require(type(value) is dict and set(value) == set(expected))


def identifier(value):
    require(type(value) is str and TOKEN.fullmatch(value) is not None)
    return value


def digest(value):
    require(type(value) is str and SHA256.fullmatch(value) is not None)


def identifiers(values, maximum):
    require(type(values) is list and len(values) <= maximum)
    result = [identifier(value) for value in values]
    require(len(result) == len(set(result)))
    return set(result)


def validate(data):  # noqa: PLR0915 -- Validate query evidence and split invariants together.
    fields(
        data,
        (
            "schema_version",
            "origin",
            "authorization_reference_sha256",
            "feature_space",
            "threshold_version",
            "threshold_sha256",
            "dataset_sha256",
            "sessions",
            "queries",
        ),
    )
    require(type(data["schema_version"]) is int and data["schema_version"] == 1)
    require(data["origin"] in ("synthetic", "authorized_human"))
    if data["origin"] == "authorized_human":
        digest(data["authorization_reference_sha256"])
    else:
        require(data["authorization_reference_sha256"] is None)
    require(data["feature_space"] == FEATURE_SPACE, "feature_space_mismatch")
    identifier(data["threshold_version"])
    digest(data["threshold_sha256"])
    digest(data["dataset_sha256"])
    require(type(data["sessions"]) is list and 1 <= len(data["sessions"]) <= 1000)
    sessions, recording_splits = {}, {}
    enrolled, calibrated = set(), set()
    for session in data["sessions"]:
        fields(session, ("session_id", "split", "subjects", "recording_sha256"))
        sid = identifier(session["session_id"])
        require(sid not in sessions, "duplicate_session")
        require(session["split"] in ("enrollment", "calibration", "test"))
        subjects = identifiers(session["subjects"], 1000)
        require(subjects)
        recordings = session["recording_sha256"]
        require(type(recordings) is list and 1 <= len(recordings) <= 1000)
        for recording in recordings:
            digest(recording)
            require(
                recording not in recording_splits, "recording_reused_across_sessions"
            )
            recording_splits[recording] = session["split"]
        require(len(recordings) == len(set(recordings)))
        sessions[sid] = session
        if session["split"] == "enrollment":
            enrolled.update(subjects)
        elif session["split"] == "calibration":
            calibrated.update(subjects)
    require(enrolled and calibrated, "missing_reference_split")
    require(type(data["queries"]) is list and 1 <= len(data["queries"]) <= 10000)
    query_ids, audio_hashes = set(), set()
    intervals = defaultdict(list)
    for row in data["queries"]:
        fields(
            row,
            (
                "query_id",
                "subject_id",
                "session_id",
                "recording_sha256",
                "audio_sha256",
                "start_ms",
                "end_ms",
                "condition",
                "eligible",
                "candidate_subjects",
                "status",
                "predicted_subject_id",
            ),
        )
        qid = identifier(row["query_id"])
        require(qid not in query_ids, "duplicate_query")
        query_ids.add(qid)
        subject = identifier(row["subject_id"])
        sid = identifier(row["session_id"])
        require(
            sid in sessions and sessions[sid]["split"] == "test", "query_split_leakage"
        )
        require(subject in sessions[sid]["subjects"])
        digest(row["recording_sha256"])
        require(row["recording_sha256"] in sessions[sid]["recording_sha256"])
        digest(row["audio_sha256"])
        require(row["audio_sha256"] not in audio_hashes, "duplicate_query_audio")
        audio_hashes.add(row["audio_sha256"])
        require(
            type(row["start_ms"]) is int
            and type(row["end_ms"]) is int
            and 0 <= row["start_ms"] < row["end_ms"] <= 7200000,
        )
        intervals[(row["recording_sha256"], subject)].append(
            (row["start_ms"], row["end_ms"])
        )
        require(row["condition"] in ("near", "far") and type(row["eligible"]) is bool)
        candidates = identifiers(row["candidate_subjects"], 50)
        require(candidates <= enrolled, "unregistered_candidate")
        require(type(row["status"]) is str and row["status"] in STATUSES)
        if row["status"] == "suggested":
            predicted = identifier(row["predicted_subject_id"])
            require(predicted in candidates, "prediction_outside_candidates")
        else:
            require(row["predicted_subject_id"] is None)
    for spans in intervals.values():
        spans.sort()
        require(
            all(
                right[0] >= left[1]
                for left, right in zip(spans, spans[1:], strict=False)
            ),
            "overlapping_queries",
        )
    return sessions, enrolled, calibrated


def ratio(successes, total):
    """Wilson 95% interval under an explicit independent-binomial assumption."""
    if not total:
        return {"numerator": 0, "denominator": 0, "rate": None, "wilson95_iid": None}
    rate = successes / total
    z = 1.959963984540054
    denominator = 1 + z * z / total
    center = (rate + z * z / (2 * total)) / denominator
    half = (
        z
        * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total))
        / denominator
    )
    return {
        "numerator": successes,
        "denominator": total,
        "rate": rate,
        "wilson95_iid": [max(0.0, center - half), min(1.0, center + half)],
    }


def grouped_metric(rows, success):
    result = ratio(sum(success(row) for row in rows), len(rows))
    # Descriptive dispersion, not an independence claim or clustered CI.
    for field, label in (("subject_id", "by_person"), ("session_id", "by_session")):
        groups = defaultdict(list)
        for row in rows:
            groups[row[field]].append(row)
        rates = [
            sum(success(row) for row in group) / len(group) for group in groups.values()
        ]
        sizes = [len(group) for group in groups.values()]
        result[label] = {
            "groups": len(groups),
            "macro_rate": sum(rates) / len(rates) if rates else None,
            "rate_range": [min(rates), max(rates)] if rates else None,
            "query_count_range": [min(sizes), max(sizes)] if sizes else None,
        }
    return result


def summarize(data):
    sessions, enrolled, calibrated = validate(data)
    rows = data["queries"]
    correct = lambda row: (
        row["status"] == "suggested"
        and row["predicted_subject_id"] == row["subject_id"]
    )
    accepted = lambda row: row["status"] == "suggested"
    known = lambda row: row["subject_id"] in row["candidate_subjects"]
    unknown = [row for row in rows if not known(row)]
    participant_sessions = defaultdict(set)
    for sid, session in sessions.items():
        for subject in session["subjects"]:
            participant_sessions[subject].add(sid)
    return {
        "schema_version": 1,
        "origin": data["origin"],
        "feature_space": data["feature_space"],
        "threshold_version": data["threshold_version"],
        "threshold_sha256": data["threshold_sha256"],
        "dataset_sha256": data["dataset_sha256"],
        "release_ready": False,
        "human_results_declared": data["origin"] == "authorized_human",
        "query_count": len(rows),
        "participant_count": len(participant_sessions),
        "tested_participant_count": len({row["subject_id"] for row in rows}),
        "enrolled_participant_count": len(enrolled),
        "calibration_participant_count": len(calibrated),
        "minimum_sessions_per_participant": min(
            map(len, participant_sessions.values())
        ),
        "held_out_of_calibration_people": len(
            {row["subject_id"] for row in rows if row["subject_id"] not in calibrated}
        ),
        "never_registered_unknown_people": len(
            {
                row["subject_id"]
                for row in unknown
                if row["subject_id"] not in enrolled | calibrated
            }
        ),
        "status_counts": {
            status: sum(row["status"] == status for row in rows)
            for status in sorted(STATUSES)
        },
        "suggestion_precision": grouped_metric(
            [row for row in rows if accepted(row)], correct
        ),
        "unknown_false_acceptance": grouped_metric(unknown, accepted),
        "coverage": {
            condition: grouped_metric(
                [
                    row
                    for row in rows
                    if known(row) and row["eligible"] and row["condition"] == condition
                ],
                correct,
            )
            for condition in ("near", "far")
        },
        "suggestions_on_ineligible_queries": sum(
            accepted(row) and not row["eligible"] for row in rows
        ),
        "limitations": [
            "supplied_results_only_not_encoder_or_end_to_end_execution",
            "consent_ground_truth_hashes_and_split_provenance_require_external_review",
            "wilson95_assumes_independent_queries_group_summaries_are_descriptive",
            "clustered_uncertainty_not_estimated",
            "pollution_diarization_latency_and_authorization_gates_not_measured",
            "synthetic_results_are_not_human_accuracy_evidence",
        ],
    }


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate_json_field")
        result[key] = value
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        with args.input.open("rb") as stream:
            raw = stream.read(MAX_BYTES + 1)
        require(len(raw) <= MAX_BYTES, "input_too_large")
        data = json.loads(raw, object_pairs_hook=unique_object)
        report = summarize(data)
        report["input_sha256"] = hashlib.sha256(raw).hexdigest()
        payload = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except (OSError, UnicodeError, ValueError, TypeError, RecursionError) as error:
        code = str(error) if isinstance(error, EvaluationError) else "evaluation_failed"
        print(code, file=sys.stderr)  # noqa: T201 -- Compatibility CLI emits fixed status only.
        return 1
    print("evaluation_report_written")  # noqa: T201 -- Compatibility CLI emits fixed status only.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
