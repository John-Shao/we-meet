"""Offline research execution; no model/threshold publication or database writes.

Annotations and authorizations are independently reviewed declarations. Qwen's
signal-only checks never establish their truth. Final test embeddings are not
extracted until a policy has been selected from calibration queries alone.
"""

import hashlib
import io
import json
import math
import re
import time
import wave
from dataclasses import replace
from pathlib import Path
from uuid import NAMESPACE_URL, uuid4, uuid5

from core.services import voiceprint_matching as matching
from core.services import voiceprint_vectors as vectors
from core.services.voiceprint_devices import GROUPS
from core.services.voiceprint_encoder import FEATURE_SPACE, EncoderClient, EncoderResult
from core.services.voiceprint_evaluation_report import summarize
from core.services.voiceprint_templates import MIN_PAIR_COSINE

TOKEN = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
MAX_MANIFEST_BYTES = 8 * 1024 * 1024
MAX_DATASET_BYTES = 8 * 1024**3
MAX_RECORDING_BYTES = 24_000 * 2 * 7200 + 4096
QUALITY_FIELDS = {
    "valid_speech_ms",
    "speech_checked",
    "speaker_consistency_checked",
    "speaker_count",
}


class EvaluationError(ValueError):
    """A fixed code, never an input identifier or filesystem path."""


def require(value, code="evaluation_manifest_invalid"):
    if not value:
        raise EvaluationError(code)


def fields(value, names):
    require(type(value) is dict and set(value) == set(names))


def token(value):
    require(type(value) is str and TOKEN.fullmatch(value) is not None)
    return value


def digest(value):
    require(type(value) is str and SHA.fullmatch(value) is not None)


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("ascii")


def sha(value):
    return hashlib.sha256(value).hexdigest()


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        require(name not in result, "evaluation_duplicate_json_field")
        result[name] = value
    return result


def private_path(root, relative):
    require(type(relative) is str and 1 <= len(relative) <= 512)
    path = Path(relative)
    require(not path.is_absolute() and ".." not in path.parts)
    resolved = (root / path).resolve(strict=True)
    require(
        resolved != root and resolved.is_relative_to(root),
        "evaluation_path_outside_dataset",
    )
    require(resolved.is_file(), "evaluation_media_invalid")
    return resolved


def file_sha(path, maximum):
    require(path.stat().st_size <= maximum, "evaluation_file_too_large")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def quality(value, duration):
    fields(value, QUALITY_FIELDS)
    require(
        type(value["valid_speech_ms"]) is int
        and 0 <= value["valid_speech_ms"] <= duration
    )
    require(
        type(value["speech_checked"]) is bool
        and type(value["speaker_consistency_checked"]) is bool
    )
    require(type(value["speaker_count"]) is int and 0 <= value["speaker_count"] <= 50)


def admitted_quality(value):
    return (
        value["speech_checked"]
        and value["speaker_consistency_checked"]
        and value["speaker_count"] == 1
        and value["valid_speech_ms"] >= 3000
    )


class Dataset:
    def __init__(self, manifest, root):  # noqa: PLR0915 -- Validate all splits before any RPC.
        fields(
            manifest,
            (
                "schema_version",
                "origin",
                "authorization",
                "annotation",
                "sessions",
                "enrollment",
                "queries",
                "policy_grid",
                "threshold_version",
            ),
        )
        require(
            type(manifest["schema_version"]) is int and manifest["schema_version"] == 1
        )
        require(manifest["origin"] in ("synthetic", "authorized_human"))
        token(manifest["threshold_version"])
        require(manifest["threshold_version"][0].isalnum())
        self.manifest = manifest
        self.root = Path(root).resolve(strict=True)
        self.authorization_sha256 = None
        for key in ("authorization", "annotation"):
            reference = manifest[key]
            if key == "authorization" and manifest["origin"] == "synthetic":
                require(reference is None)
                continue
            fields(reference, ("path", "sha256"))
            digest(reference["sha256"])
            require(
                file_sha(private_path(self.root, reference["path"]), MAX_MANIFEST_BYTES)
                == reference["sha256"],
                "evaluation_reference_changed",
            )
            if key == "authorization":
                self.authorization_sha256 = reference["sha256"]
        self.sessions, self.recordings = {}, {}
        raw_hashes, pcm_hashes = set(), set()
        total_bytes = 0
        sessions = manifest["sessions"]
        require(type(sessions) is list and 3 <= len(sessions) <= 1000)
        for session in sessions:
            fields(session, ("session_id", "split", "subjects", "recordings"))
            sid = token(session["session_id"])
            require(sid not in self.sessions)
            require(session["split"] in ("enrollment", "calibration", "test"))
            require(
                type(session["subjects"]) is list
                and 1 <= len(session["subjects"]) <= 1000
            )
            subjects = [token(value) for value in session["subjects"]]
            require(len(subjects) == len(set(subjects)))
            self.sessions[sid] = session
            require(
                type(session["recordings"]) is list
                and 1 <= len(session["recordings"]) <= 1000
            )
            for recording in session["recordings"]:
                fields(recording, ("recording_id", "path", "sha256"))
                rid = token(recording["recording_id"])
                digest(recording["sha256"])
                require(
                    rid not in self.recordings
                    and recording["sha256"] not in raw_hashes,
                    "evaluation_recording_reused",
                )
                require(len(self.recordings) < 1000)
                path = private_path(self.root, recording["path"])
                total_bytes += path.stat().st_size
                require(
                    total_bytes <= MAX_DATASET_BYTES, "evaluation_dataset_too_large"
                )
                require(
                    file_sha(path, MAX_RECORDING_BYTES) == recording["sha256"],
                    "evaluation_media_changed",
                )
                pcm = hashlib.sha256()
                with wave.open(str(path), "rb") as stream:
                    require(
                        stream.getparams()[:3] == (1, 2, 24000)
                        and stream.getcomptype() == "NONE",
                        "evaluation_prepared_pcm_required",
                    )
                    frames = stream.getnframes()
                    require(72000 <= frames <= 24_000 * 7200)
                    read = 0
                    while block := stream.readframes(240000):
                        pcm.update(block)
                        read += len(block)
                    require(read == frames * 2, "evaluation_media_truncated")
                require(
                    pcm.hexdigest() not in pcm_hashes, "evaluation_pcm_recording_reused"
                )
                pcm_hashes.add(pcm.hexdigest())
                raw_hashes.add(recording["sha256"])
                self.recordings[rid] = {
                    **recording,
                    "session_id": sid,
                    "split": session["split"],
                    "duration_ms": frames // 24,
                    "resolved": path,
                }
        require(
            {value["split"] for value in sessions}
            == {"enrollment", "calibration", "test"}
        )
        self.used_intervals = {}
        enrollment = manifest["enrollment"]
        require(type(enrollment) is list and 1 <= len(enrollment) <= 250)
        groups, subject_groups = set(), {}
        for row in enrollment:
            fields(row, ("subject_id", "device_group", "clips"))
            subject, group = token(row["subject_id"]), token(row["device_group"])
            require(group in GROUPS, "evaluation_device_group_invalid")
            require((subject, group) not in groups)
            groups.add((subject, group))
            subject_groups[subject] = subject_groups.get(subject, 0) + 1
            require(len(subject_groups) <= 50 and subject_groups[subject] <= 5)
            self.validate_clips(row["clips"], subject, "enrollment")
            require(
                3 <= len(row["clips"]) <= 12
                and sum(clip["quality"]["valid_speech_ms"] for clip in row["clips"])
                >= 30000,
                "evaluation_enrollment_insufficient",
            )
            require(
                all(admitted_quality(clip["quality"]) for clip in row["clips"]),
                "evaluation_enrollment_quality_required",
            )
        require(
            {subject for subject, group in groups if group == "default"}
            == set(subject_groups),
            "evaluation_baseline_required",
        )
        queries = manifest["queries"]
        require(type(queries) is list and 2 <= len(queries) <= 10000)
        query_ids = set()
        query_spans = {}
        for row in queries:
            fields(
                row,
                (
                    "query_id",
                    "subject_id",
                    "session_id",
                    "recording_id",
                    "start_ms",
                    "end_ms",
                    "condition",
                    "eligible",
                    "candidate_subjects",
                    "clips",
                ),
            )
            qid, subject = token(row["query_id"]), token(row["subject_id"])
            token(row["session_id"])
            token(row["recording_id"])
            require(qid not in query_ids)
            query_ids.add(qid)
            recording = self.recordings.get(row["recording_id"])
            require(
                recording is not None
                and recording["session_id"] == row["session_id"]
                and recording["split"] in ("calibration", "test")
            )
            require(
                type(row["start_ms"]) is int
                and type(row["end_ms"]) is int
                and 0 <= row["start_ms"] < row["end_ms"] <= recording["duration_ms"]
            )
            query_spans.setdefault((row["recording_id"], subject), []).append(
                (row["start_ms"], row["end_ms"])
            )
            require(
                row["condition"] in ("near", "far") and type(row["eligible"]) is bool
            )
            require(
                type(row["candidate_subjects"]) is list
                and len(row["candidate_subjects"]) <= 50
            )
            candidates = [token(value) for value in row["candidate_subjects"]]
            require(
                len(candidates) == len(set(candidates))
                and set(candidates) <= set(subject_groups),
                "evaluation_candidate_template_missing",
            )
            self.validate_clips(row["clips"], subject, recording["split"])
            require(
                all(
                    clip["recording_id"] == row["recording_id"]
                    and row["start_ms"]
                    <= clip["start_ms"]
                    < clip["end_ms"]
                    <= row["end_ms"]
                    for clip in row["clips"]
                )
            )
            if row["eligible"]:
                require(
                    len(row["clips"]) >= 3
                    and sum(clip["quality"]["valid_speech_ms"] for clip in row["clips"])
                    >= 9000
                    and all(admitted_quality(clip["quality"]) for clip in row["clips"]),
                    "evaluation_eligibility_invalid",
                )
        require(
            {self.sessions[row["session_id"]]["split"] for row in queries}
            == {"calibration", "test"}
        )
        for intervals in (*self.used_intervals.values(), *query_spans.values()):
            ordered = sorted(intervals)
            require(
                all(
                    right[0] >= left[1]
                    for left, right in zip(ordered, ordered[1:], strict=False)
                ),
                "evaluation_clip_overlap",
            )
        grid = manifest["policy_grid"]
        require(type(grid) is list and 1 <= len(grid) <= 32)
        seen = set()
        for params in grid:
            fields(params, ("accept", "margin", "min_pair_cosine"))
            require(
                all(
                    type(value) in (int, float)
                    and math.isfinite(value)
                    and 0 < value <= 1
                    for value in params.values()
                )
            )
            key = canonical(params)
            require(key not in seen)
            seen.add(key)

    def validate_clips(self, clips, subject, split):
        require(type(clips) is list and 1 <= len(clips) <= 12)
        for clip in clips:
            fields(clip, ("recording_id", "start_ms", "end_ms", "quality"))
            token(clip["recording_id"])
            recording = self.recordings.get(clip["recording_id"])
            require(
                recording is not None
                and recording["split"] == split
                and subject in self.sessions[recording["session_id"]]["subjects"]
            )
            start, end = clip["start_ms"], clip["end_ms"]
            require(
                type(start) is int
                and type(end) is int
                and 0 <= start < end <= recording["duration_ms"]
                and 3000 <= end - start <= 10000
            )
            quality(clip["quality"], end - start)
            self.used_intervals.setdefault((clip["recording_id"], subject), []).append(
                (start, end)
            )

    def wav(self, clip):
        recording = self.recordings[clip["recording_id"]]
        path = recording["resolved"]
        # Hash the same open file before and after slicing; reject replacement
        # or edits rather than publishing a result from changed source bytes.
        with path.open("rb") as source:
            require(
                hashlib.file_digest(source, "sha256").hexdigest()
                == recording["sha256"],
                "evaluation_media_changed",
            )
            source.seek(0)
            with wave.open(source, "rb") as stream:
                stream.setpos(clip["start_ms"] * 24)
                pcm = stream.readframes((clip["end_ms"] - clip["start_ms"]) * 24)
            require(
                len(pcm) == (clip["end_ms"] - clip["start_ms"]) * 48,
                "evaluation_media_truncated",
            )
            source.seek(0)
            require(
                hashlib.file_digest(source, "sha256").hexdigest()
                == recording["sha256"],
                "evaluation_media_changed",
            )
        output = io.BytesIO()
        with wave.open(output, "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(24000)
            stream.writeframes(pcm)
        return output.getvalue(), sha(pcm)


def metric(rows):
    accepted = [row for row in rows if row["status"] == "suggested"]
    unknown = [
        row for row in rows if row["subject_id"] not in row["candidate_subjects"]
    ]
    near = [
        row
        for row in rows
        if row["eligible"]
        and row["condition"] == "near"
        and row["subject_id"] in row["candidate_subjects"]
    ]

    def correct(row):
        return (
            row["status"] == "suggested"
            and row["predicted_subject_id"] == row["subject_id"]
        )

    def ratio(numerator, denominator):
        return {
            "numerator": numerator,
            "denominator": denominator,
            "value": numerator / denominator if denominator else None,
        }

    return {
        "precision": ratio(sum(map(correct, accepted)), len(accepted)),
        "unknown_far": ratio(
            sum(row["status"] == "suggested" for row in unknown), len(unknown)
        ),
        "near_coverage": ratio(sum(map(correct, near)), len(near)),
    }


def execute(dataset, extractor, *, deadline_seconds=3600):  # noqa: PLR0915 -- Freeze calibration before entering the test phase.
    require(type(deadline_seconds) is int and 120 <= deadline_seconds <= 86400)
    began = time.monotonic()
    seen_pcm = set()
    extraction_calls = 0
    latencies = []

    def extract(clip):
        nonlocal extraction_calls
        require(
            time.monotonic() - began < deadline_seconds, "evaluation_deadline_exceeded"
        )
        require(extraction_calls < 130000, "evaluation_extraction_budget_exceeded")
        wav, pcm_sha = dataset.wav(clip)
        require(
            time.monotonic() - began < deadline_seconds, "evaluation_deadline_exceeded"
        )
        require(pcm_sha not in seen_pcm, "evaluation_pcm_clip_reused")
        seen_pcm.add(pcm_sha)
        started = time.monotonic()
        encoded = extractor.extract(
            wav, job_id=uuid4(), lease_expires_at=int(time.time()) + 60
        )
        latencies.append(time.monotonic() - started)
        extraction_calls += 1
        require(
            time.monotonic() - began < deadline_seconds, "evaluation_deadline_exceeded"
        )
        require(
            isinstance(encoded, EncoderResult)
            and encoded.feature_space == FEATURE_SPACE
            and encoded.input_sha256 == sha(wav),
            "evaluation_encoder_contract_invalid",
        )
        vector = vectors.unit_vector(encoded.vector)
        require(
            abs(math.sqrt(math.fsum(value * value for value in encoded.vector)) - 1)
            < 1e-4,
            "evaluation_encoder_contract_invalid",
        )
        return vector, sha(wav)

    subjects = sorted({row["subject_id"] for row in dataset.manifest["enrollment"]})
    uuids = {
        subject: uuid5(NAMESPACE_URL, "we-meet-evaluation/" + subject)
        for subject in subjects
    }
    inverse = {identifier: subject for subject, identifier in uuids.items()}
    templates = {subject: [] for subject in subjects}
    anchors = {}
    for row in sorted(
        dataset.manifest["enrollment"],
        key=lambda item: item["device_group"] != "default",
    ):
        embedded = [extract(clip)[0] for clip in row["clips"]]
        require(
            all(
                vectors.cosine(left, right) >= MIN_PAIR_COSINE
                for index, left in enumerate(embedded)
                for right in embedded[index + 1 :]
            ),
            "evaluation_enrollment_inconsistent",
        )
        if row["device_group"] != "default":
            require(
                all(
                    vectors.cosine(vector, anchors[row["subject_id"]])
                    >= MIN_PAIR_COSINE
                    for vector in embedded
                ),
                "evaluation_device_baseline_inconsistent",
            )
        template = vectors.aggregate(embedded)
        if row["device_group"] == "default":
            anchors[row["subject_id"]] = template
        templates[row["subject_id"]].append(template)
    candidates = {
        subject: matching.Candidate(uuids[subject], tuple(templates[subject]))
        for subject in subjects
    }

    def prepare(split):
        prepared = []
        for query in dataset.manifest["queries"]:
            if dataset.sessions[query["session_id"]]["split"] != split:
                continue
            clips = []
            for clip in query["clips"]:
                vector, audio_sha = extract(clip)
                clips.append(
                    matching.QueryClip(
                        start_ms=clip["start_ms"],
                        end_ms=clip["end_ms"],
                        audio_sha256=audio_sha,
                        vector=vector,
                        **clip["quality"],
                    )
                )
            prepared.append((query, tuple(clips)))
        return prepared

    def score(prepared, policy):
        rows = []
        for query, clips in prepared:
            require(
                time.monotonic() - began < deadline_seconds,
                "evaluation_deadline_exceeded",
            )
            result = matching.match(
                clips,
                tuple(candidates[subject] for subject in query["candidate_subjects"]),
                policy=policy,
            )
            rows.append(
                {
                    **query,
                    "status": result.status,
                    "predicted_subject_id": inverse.get(result.user_id),
                    "audio_sha256": sha(
                        canonical([clip.audio_sha256 for clip in clips])
                    ),
                }
            )
        return rows

    calibration = prepare("calibration")
    calibration_material = {
        "feature_space": FEATURE_SPACE,
        "score_policy": matching.SCORE_POLICY,
        "enrollment_min_pair_cosine": MIN_PAIR_COSINE,
        "matching_source_sha256": sha(
            Path(matching.__file__).read_bytes().replace(b"\r\n", b"\n")
        ),
        "vectors_source_sha256": sha(
            Path(vectors.__file__).read_bytes().replace(b"\r\n", b"\n")
        ),
        "sessions": [
            session
            for session in dataset.manifest["sessions"]
            if session["split"] != "test"
        ],
        "enrollment": dataset.manifest["enrollment"],
        "queries": [
            query
            for query in dataset.manifest["queries"]
            if dataset.sessions[query["session_id"]]["split"] == "calibration"
        ],
        "policy_grid": dataset.manifest["policy_grid"],
    }
    calibration_digest = sha(canonical(calibration_material))
    base = matching.ThresholdPolicy(
        threshold_version=dataset.manifest["threshold_version"],
        feature_space=FEATURE_SPACE,
        score_policy=matching.SCORE_POLICY,
        accept=1,
        margin=1,
        min_pair_cosine=1,
        min_query_clips=3,
        min_query_speech_ms=9000,
        max_candidates=50,
        max_device_groups=5,
        calibration_sha256=calibration_digest,
        calibrated=True,
    )
    summaries, feasible = [], []
    for index, params in enumerate(dataset.manifest["policy_grid"]):
        policy = replace(base, **params).validate()
        summary = metric(score(calibration, policy))
        summaries.append(
            {"grid_index": index, "parameters": params, "metrics": summary}
        )
        if (
            all(summary[key]["value"] is not None for key in summary)
            and summary["precision"]["value"] >= 0.99
            and summary["unknown_far"]["value"] <= 0.01
            and summary["near_coverage"]["value"] >= 0.8
        ):
            feasible.append(
                (
                    summary["near_coverage"]["value"],
                    params["accept"],
                    params["margin"],
                    params["min_pair_cosine"],
                    -index,
                    policy,
                )
            )
    selected = max(feasible, key=lambda row: row[:-1])[-1] if feasible else None
    report = {
        "schema_version": 1,
        "execution": "prepared_pcm_real_matching_research",
        "origin_declared": dataset.manifest["origin"],
        "feature_space": FEATURE_SPACE,
        "dataset_sha256": sha(canonical(dataset.manifest)),
        "calibration_sha256": calibration_digest,
        "authorization_reference_sha256": dataset.authorization_sha256,
        "annotation_reference_sha256": dataset.manifest["annotation"]["sha256"],
        "calibration_grid": summaries,
        "selected_research_parameters": None,
        "test_results": None,
        "release_ready": False,
        "production_threshold_written": False,
        "database_used": False,
        "backend_rpc_client_used": isinstance(extractor, EncoderClient),
        "limitations": [
            "consent_and_ground_truth_are_reviewed_declarations_not_authenticated",
            "empirical_grid_selection_is_not_release_acceptance",
            "prepared_pcm_only_not_diarization_or_business_end_to_end",
            "no_clustered_uncertainty_or_pollution_assessment",
            "synthetic_execution_is_not_human_accuracy",
        ],
    }
    if selected:
        # The production summarizer accepts test queries only. It never affects
        # policy selection; no test embedding was extracted before this point.
        test = score(prepare("test"), selected)
        report["selected_research_parameters"] = {
            key: getattr(selected, key)
            for key in ("accept", "margin", "min_pair_cosine")
        }
        result_input = {
            "schema_version": 1,
            "origin": dataset.manifest["origin"],
            "authorization_reference_sha256": dataset.authorization_sha256,
            "feature_space": FEATURE_SPACE,
            "threshold_version": selected.threshold_version,
            "threshold_sha256": selected.digest,
            "dataset_sha256": report["dataset_sha256"],
            "sessions": [
                {
                    "session_id": row["session_id"],
                    "split": row["split"],
                    "subjects": row["subjects"],
                    "recording_sha256": [
                        recording["sha256"] for recording in row["recordings"]
                    ],
                }
                for row in dataset.manifest["sessions"]
            ],
            "queries": [
                {
                    key: row[key]
                    for key in (
                        "query_id",
                        "subject_id",
                        "session_id",
                        "audio_sha256",
                        "start_ms",
                        "end_ms",
                        "condition",
                        "eligible",
                        "candidate_subjects",
                        "status",
                        "predicted_subject_id",
                    )
                }
                | {
                    "recording_sha256": dataset.recordings[row["recording_id"]][
                        "sha256"
                    ]
                }
                for row in test
            ],
        }
        report["test_results"] = summarize(result_input)
        exposed = set().union(
            *(
                set(session["subjects"])
                for session in dataset.manifest["sessions"]
                if session["split"] == "calibration"
            )
        ) | set().union(*(set(query["candidate_subjects"]) for query, _ in calibration))
        report["test_results"]["held_out_of_calibration_people"] = len(
            {row["subject_id"] for row in test} - exposed
        )
        report["test_results"]["calibration_candidate_people"] = len(
            set().union(*(set(query["candidate_subjects"]) for query, _ in calibration))
        )
        report["test_results"]["limitations"] = [
            item
            for item in report["test_results"]["limitations"]
            if item != "supplied_results_only_not_encoder_or_end_to_end_execution"
        ]
        report["test_results"]["limitations"].append(
            "actual_core_matching_not_full_business_end_to_end"
        )
    report["selection_status"] = (
        "research_candidate_selected"
        if selected
        else "no_empirically_feasible_calibration_policy"
    )
    report["extraction_calls"] = extraction_calls
    report["encoder_rpc_seconds"] = {
        "median": sorted(latencies)[len(latencies) // 2],
        "p95_nearest_rank": sorted(latencies)[math.ceil(len(latencies) * 0.95) - 1],
        "max": max(latencies),
    }
    report["elapsed_seconds"] = time.monotonic() - began
    return report
