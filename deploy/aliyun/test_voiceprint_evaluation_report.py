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

    def test_whole_person_resampling_does_not_treat_copies_as_independent(self):
        rows = [
            {
                "subject_id": f"person{i}",
                "session_id": "one_shared_session",
                "correct": i < 15,
            }
            for i in range(30)
        ]
        first = report.grouped_metric(rows, lambda row: row["correct"])
        copied = report.grouped_metric(rows * 100, lambda row: row["correct"])
        self.assertEqual(
            first["by_person"]["cluster_bootstrap95"],
            copied["by_person"]["cluster_bootstrap95"],
        )
        interval = copied["by_person"]["cluster_bootstrap95"]["interval"]
        self.assertLess(interval[0], 0.4)
        self.assertGreater(interval[1], 0.6)
        self.assertLess(
            copied["wilson95_iid"][1] - copied["wilson95_iid"][0],
            interval[1] - interval[0],
        )
        self.assertIsNone(copied["by_session"]["cluster_bootstrap95"]["interval"])

    def test_session_resampling_and_reordered_anonymous_data_are_reproducible(self):
        rows = [
            {"subject_id": "same_person", "session_id": f"s{i}", "correct": i < 15}
            for i in range(30)
        ]
        first = report.grouped_metric(rows, lambda row: row["correct"])
        renamed = [
            {**row, "session_id": f"renamed{i}"} for i, row in enumerate(reversed(rows))
        ]
        second = report.grouped_metric(renamed, lambda row: row["correct"])
        self.assertEqual(first, second)
        self.assertIsNotNone(first["by_session"]["cluster_bootstrap95"]["interval"])
        self.assertIsNone(first["by_person"]["cluster_bootstrap95"]["interval"])

    def test_zero_errors_small_cohorts_and_budget_never_emit_zero_width_interval(self):
        cases = (
            ([], "no_denominator"),
            ([(0, 1)] * 29, "too_few_metric_clusters"),
            ([(0, 10)] * 30, "no_observed_cluster_variation"),
            ([(1, 1)] * 30, "no_observed_cluster_variation"),
            ([(0, 1), (1, 1)] * 501, "cohort_cluster_budget_exceeded"),
        )
        for counts, status in cases:
            with self.subTest(status=status):
                result = report.cluster_bootstrap(counts)
                self.assertEqual(result["status"], status)
                self.assertIsNone(result["interval"])
                self.assertEqual(result["replicates_valid"], 0)

    def test_unequal_cluster_sizes_use_query_weighted_ratio_in_each_resample(self):
        result = report.cluster_bootstrap([(0, 1)] * 15 + [(100, 100)] * 15)
        interval = result["interval"]
        # Equal-cluster mean is 0.5; query-weighted point estimate is 100/101.
        self.assertGreater(interval[0], 0.97)
        self.assertLess(interval[0], 100 / 101)
        self.assertGreater(interval[1], 100 / 101)
        self.assertEqual(result["replicates_valid"], 999)

    def test_precision_resampling_keeps_cohort_people_with_no_suggestion(self):
        rows = [
            {
                "subject_id": f"p{i}",
                "session_id": f"s{i}",
                "accepted": i < 30,
                "correct": i < 15,
            }
            for i in range(60)
        ]
        result = report.grouped_metric(
            [row for row in rows if row["accepted"]],
            lambda row: row["correct"],
            cohort=rows,
            included=lambda row: row["accepted"],
        )
        bootstrap = result["by_person"]["cluster_bootstrap95"]
        self.assertEqual(
            (bootstrap["cohort_clusters"], bootstrap["metric_clusters"]), (60, 30)
        )
        self.assertEqual((result["numerator"], result["denominator"]), (15, 30))
        self.assertIsNotNone(bootstrap["interval"])
        self.assertNotIn("p0", json.dumps(result))

    def test_metric_subset_and_bootstrap_cohort_must_agree(self):
        rows = [{"subject_id": "person", "session_id": "session"}]
        with self.assertRaises(report.EvaluationError):
            report.grouped_metric(rows, lambda row: True, cohort=[])
        with self.assertRaises(report.EvaluationError):
            report.grouped_metric(
                rows, lambda row: True, cohort=rows, included=lambda row: False
            )

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
