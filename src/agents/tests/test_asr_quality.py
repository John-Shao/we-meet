"""A quality score cannot hide missing cases, wrong media or speaker merging."""

import copy
import hashlib
import json
import unittest
import zipfile
from pathlib import Path

from evaluations.asr_quality.score import score

ROOT = Path(__file__).parents[1] / "evaluations" / "asr_quality"


class QualityTests(unittest.TestCase):
    """Known reference and deliberate regressions exercise meaningful metrics."""

    def setUp(self):
        """Use the actual frozen corpus, not a mirror of scorer internals."""
        self.manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        self.results = {
            "cases": [
                {
                    "id": case["id"],
                    "sha256": case["sha256"],
                    "status": "succeeded",
                    "elapsed_ms": 100,
                    "segments": copy.deepcopy(case["segments"]),
                }
                for case in self.manifest["cases"]
            ]
        }

    def test_frozen_media_checksums_and_reference(self):
        """All six audio files and references are pinned together."""
        with zipfile.ZipFile(ROOT / "fixtures.zip") as archive:
            for case in self.manifest["cases"]:
                self.assertEqual(
                    hashlib.sha256(archive.read(case["id"] + ".wav")).hexdigest(),
                    case["sha256"],
                )
        report = score(self.manifest, self.results)
        self.assertEqual(report["evaluated_cases"], 6)
        for row in report["cases"][:-1]:
            self.assertEqual(row["cer"], 0)
            self.assertEqual(row["term_recall"], 1)
            self.assertEqual(row["speaker_window_accuracy"], 1)

    def test_relabeling_preserves_score_but_merging_does_not(self):
        """Arbitrary cluster IDs are valid; putting everyone in one cluster is not."""
        segments = self.results["cases"][0]["segments"]
        for item in segments:
            item["speaker"] = "cluster-" + item["speaker"]
        self.assertEqual(
            score(self.manifest, self.results)["cases"][0]["speaker_window_accuracy"], 1
        )
        for item in segments:
            item["speaker"] = "merged"
        self.assertLess(
            score(self.manifest, self.results)["cases"][0]["speaker_window_accuracy"],
            0.8,
        )

    def test_missing_terms_and_silence_hallucination_are_visible(self):
        """Negation/number/term regression cannot get a perfect character score."""
        self.results["cases"][0]["segments"][0]["text"] = "SECRETARY"
        self.results["cases"][-1]["segments"] = [
            {"start_ms": 0, "end_ms": 100, "text": "invented", "speaker": None}
        ]
        report = score(self.manifest, self.results)
        self.assertGreater(report["cases"][0]["cer"], 0)
        self.assertLess(report["cases"][0]["term_recall"], 1)
        self.assertGreater(report["cases"][-1]["silence_hallucinated_chars"], 0)

    def test_missing_failed_and_wrong_hash_never_silently_pass(self):
        """Coverage and infrastructure failure remain distinct from accuracy."""
        self.results["cases"].pop()
        self.results["cases"][0]["status"] = "failed"
        report = score(self.manifest, self.results)
        self.assertEqual(report["evaluated_cases"], 5)
        self.assertEqual(report["succeeded_cases"], 4)
        self.assertEqual(report["cases"][-1]["status"], "not_evaluated")
        self.results["cases"][0]["sha256"] = "changed"
        with self.assertRaises(ValueError):
            score(self.manifest, self.results)

    def test_invalid_timestamps_and_duplicate_cases_fail_closed(self):
        """Overlap cannot double-count speaker coverage or inflate the result."""
        self.results["cases"][0]["segments"][1]["start_ms"] = 0
        with self.assertRaises(ValueError):
            score(self.manifest, self.results)
        self.setUp()
        self.results["cases"].append(self.results["cases"][0])
        with self.assertRaises(ValueError):
            score(self.manifest, self.results)
