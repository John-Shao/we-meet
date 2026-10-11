"""Metric denominators, split leakage, privacy and output failure checks."""

import copy
import hashlib
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

from deploy.aliyun import voiceprint_evaluation_report as report


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def fixture():
    subjects = ["opaqueA", "opaqueB"]
    sessions = [
        {
            "session_id": phase,
            "split": phase,
            "subjects": subjects,
            "recording_sha256": [sha(phase)],
        }
        for phase in ("enrollment", "calibration", "test")
    ]
    sessions[-1]["subjects"] = subjects + ["opaqueUnknown"]
    queries = []
    # Known: one correct near, one wrong near, one unavailable far.
    # Unknown: one false acceptance, one refusal; each is ONE speaker query.
    for index, (subject, status, predicted, condition) in enumerate(
        (
            ("opaqueA", "suggested", "opaqueA", "near"),
            ("opaqueB", "suggested", "opaqueA", "near"),
            ("opaqueA", "unavailable", None, "far"),
            ("opaqueUnknown", "suggested", "opaqueB", "near"),
            ("opaqueUnknown", "unknown", None, "far"),
        )
    ):
        queries.append(
            {
                "query_id": f"query{index}",
                "subject_id": subject,
                "session_id": "test",
                "recording_sha256": sha("test"),
                "audio_sha256": sha(f"audio{index}"),
                "start_ms": index * 30000,
                "end_ms": index * 30000 + 10000,
                "condition": condition,
                "eligible": True,
                "candidate_subjects": subjects.copy(),
                "status": status,
                "predicted_subject_id": predicted,
            }
        )
    return {
        "schema_version": 1,
        "origin": "synthetic",
        "authorization_reference_sha256": None,
        "feature_space": report.FEATURE_SPACE,
        "threshold_version": "synthetic-only-v1",
        "threshold_sha256": sha("policy"),
        "dataset_sha256": sha("synthetic-dataset"),
        "sessions": sessions,
        "queries": queries,
    }


class EvaluationReportTests(unittest.TestCase):
    def test_speaker_query_denominators_and_far_separation(self):
        result = report.summarize(fixture())
        self.assertEqual(result["suggestion_precision"]["rate"], 1 / 3)
        self.assertEqual(result["unknown_false_acceptance"]["denominator"], 2)
        self.assertEqual(result["unknown_false_acceptance"]["rate"], 0.5)
        self.assertEqual(result["coverage"]["near"]["rate"], 0.5)
        self.assertEqual(result["coverage"]["far"]["rate"], 0)
        self.assertEqual(result["coverage"]["near"]["by_person"]["groups"], 2)
        self.assertEqual(result["never_registered_unknown_people"], 1)
        self.assertFalse(result["release_ready"])
        self.assertFalse(result["human_results_declared"])

    def test_no_suggestions_and_no_eligible_known_is_not_perfect(self):
        data = fixture()
        for row in data["queries"]:
            row.update(status="unknown", predicted_subject_id=None, eligible=False)
        result = report.summarize(data)
        self.assertIsNone(result["suggestion_precision"]["rate"])
        self.assertIsNone(result["coverage"]["near"]["rate"])
        self.assertEqual(result["unknown_false_acceptance"]["denominator"], 2)

    def test_zero_errors_interval_does_not_claim_zero_risk(self):
        metric = report.ratio(0, 300)
        self.assertGreater(metric["wilson95_iid"][1], 0.01)
        self.assertLess(metric["wilson95_iid"][1], 0.013)
        self.assertIsNone(report.ratio(0, 0)["wilson95_iid"])

    def test_candidate_exclusion_counts_as_unknown(self):
        data = fixture()
        data["queries"][1]["candidate_subjects"] = ["opaqueA"]
        metric = report.summarize(data)["unknown_false_acceptance"]
        self.assertEqual((metric["numerator"], metric["denominator"]), (2, 3))

    def test_human_declaration_needs_reference_and_never_approves_release(self):
        data = fixture()
        data["origin"] = "authorized_human"
        with self.assertRaises(report.EvaluationError):
            report.summarize(data)
        data["authorization_reference_sha256"] = sha("external-authorization")
        result = report.summarize(data)
        self.assertTrue(result["human_results_declared"])
        self.assertFalse(result["release_ready"])

    def test_invalid_evidence_is_rejected(self):
        changes = (
            lambda d: d["sessions"][2].update(session_id="calibration"),
            lambda d: d["sessions"][2].update(recording_sha256=[sha("enrollment")]),
            lambda d: d["queries"][0].update(session_id="calibration"),
            lambda d: d["queries"][1].update(query_id="query0"),
            lambda d: d["queries"][1].update(audio_sha256=sha("audio0")),
            lambda d: d["queries"][2].update(start_ms=0, end_ms=10000),
            lambda d: d["queries"][0].update(predicted_subject_id="opaqueUnknown"),
            lambda d: d["queries"][0].update(candidate_subjects=["opaqueA", "opaqueA"]),
            lambda d: d["queries"][0].update(candidate_subjects=["opaqueUnknown"]),
            lambda d: d["queries"][0].update(eligible=1),
            lambda d: d["queries"][0].update(start_ms=True),
            lambda d: d["queries"][0].update(vector=[1]),
            lambda d: d.update(feature_space="another-model"),
            lambda d: d.update(queries=[]),
        )
        for change in changes:
            data = copy.deepcopy(fixture())
            change(data)
            with self.subTest(change=change), self.assertRaises(report.EvaluationError):
                report.summarize(data)

    def test_group_macro_rate_is_not_query_weighted(self):
        rows = fixture()["queries"][0:3]
        metric = report.grouped_metric(rows, lambda row: row["subject_id"] == "opaqueA")
        self.assertEqual(metric["rate"], 2 / 3)
        self.assertEqual(metric["by_person"]["macro_rate"], 0.5)
        self.assertEqual(metric["by_person"]["query_count_range"], [1, 2])

    def test_cli_aggregate_privacy_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = (
                Path(directory) / "input.json",
                Path(directory) / "report.json",
            )
            source.write_text(json.dumps(fixture()), encoding="utf-8")
            with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                self.assertEqual(
                    report.main(["--input", str(source), "--output", str(target)]), 0
                )
                original = target.read_bytes()
                self.assertEqual(
                    report.main(["--input", str(source), "--output", str(target)]), 1
                )
            self.assertEqual(target.read_bytes(), original)
            if os.name != "nt":
                self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            output = original.decode()
            for secret in (
                "opaqueA",
                "opaqueB",
                "opaqueUnknown",
                "query0",
                sha("audio0"),
                str(source),
            ):
                self.assertNotIn(secret, output)
            self.assertEqual(
                json.loads(output)["input_sha256"],
                hashlib.sha256(source.read_bytes()).hexdigest(),
            )

    def test_duplicate_fields_and_malformed_json_leave_no_report(self):
        for raw in (
            '{"schema_version":1,"schema_version":1}',
            '{"participant":"private-name"',
            "[]",
        ):
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as directory:
                source, target = (
                    Path(directory) / "input.json",
                    Path(directory) / "report.json",
                )
                source.write_text(raw, encoding="utf-8")
                errors = StringIO()
                with redirect_stderr(errors):
                    self.assertEqual(
                        report.main(["--input", str(source), "--output", str(target)]),
                        1,
                    )
                self.assertFalse(target.exists())
                self.assertNotIn("private-name", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
