import json
import tempfile
import unittest
from pathlib import Path

from work_agent.diagnostics import failure, validate


class DiagnosticsTests(unittest.TestCase):
    def test_report_failure_counts_aliases_without_exposing_any_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runtime-home").mkdir()
            (root / "request.json").write_text(
                json.dumps(
                    {
                        "files": [
                            {"name": "result-01.md", "text": "private-source-canary"}
                        ]
                    }
                )
            )
            report = {
                "verdict": "needs_changes",
                "findings": [
                    {
                        "evidence": [
                            {
                                "file": "report.md",
                                "sha256": "secret-key-canary",
                                "quote": "private-source-canary",
                            }
                        ]
                    }
                ],
                "missing_information": [],
            }
            (root / "runtime-home/review-candidate.json").write_text(
                json.dumps(
                    {
                        "accepted": True,
                        "settled": True,
                        "stop_reason": "stop",
                        "response": json.dumps(report),
                    }
                )
            )
            result = failure(ValueError("invalid_review_report"), root)
            self.assertEqual(result["invalid_names"], 1)
            self.assertEqual(result["code"], "invalid_review_report")
            self.assertNotIn("canary", json.dumps(result))
            self.assertEqual(validate(result), result)

    def test_unknown_exception_and_extra_remote_fields_never_echo(self):
        result = failure(RuntimeError("secret-key-canary"), Path("missing"))
        self.assertEqual(result["code"], "task_failed")
        self.assertNotIn("canary", json.dumps(result))
        self.assertEqual(
            validate({**result, "raw": "secret", "invalid_quotes": True}), result
        )
        self.assertIsNone(
            validate({"contract": "work-task-failure/v1", "code": "secret-key-canary"})
        )


if __name__ == "__main__":
    unittest.main()
