"""The production diagnostic must expose counts, never source/provider payloads."""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "capture_diagnostic", Path(__file__).with_name("check_capture_transcription.py")
)
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


class DiagnosticTests(unittest.TestCase):
    def job(self, **changes):
        values = dict(
            pk="job",
            capture_id="capture",
            status="incomplete",
            started_at=object(),
            finish_hash="PRIVATE-HASH",
            acknowledged_inputs=3,
            final_sequence=0,
            configuration={"token": "PRIVATE-TOKEN"},
            inputs={
                "runs": 1,
                "chunks": [
                    {"duration_ms": 10000, "url": "PRIVATE-URL"} for _ in range(3)
                ],
            },
            report={
                "provider_finished": False,
                "final_sequence": 0,
                "text": "PRIVATE-TEXT",
                "tasks": [
                    {
                        "finished": False,
                        "input_samples": 480000,
                        "task_id": "PRIVATE-PROVIDER-ID",
                        "error": "PRIVATE-ERROR",
                    }
                ],
            },
        )
        return SimpleNamespace(**{**values, **changes})

    def test_incomplete_after_all_audio_received(self):
        report = diagnostic.counts_report(self.job())
        self.assertTrue(report["input_samples_match"])
        self.assertEqual(report["acknowledged_inputs"], 3)
        self.assertEqual(report["finished_tasks"], 0)
        self.assertFalse(report["provider_finished"])
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_no_terminal_receipt_is_not_provider_success(self):
        report = diagnostic.counts_report(
            self.job(report={}, finish_hash="", started_at=None)
        )
        self.assertFalse(report["terminal_receipt_present"])
        self.assertIsNone(report["provider_finished"])
        self.assertFalse(report["input_samples_match"])

    def test_delivery_mismatch_is_visible(self):
        report = diagnostic.counts_report(
            self.job(
                report={
                    "provider_finished": True,
                    "final_sequence": 7,
                    "tasks": [{"finished": True, "input_samples": 100}],
                }
            )
        )
        self.assertFalse(report["input_samples_match"])
        self.assertNotEqual(report["receipt_final_count"], report["final_count"])

    def test_live_uses_current_input_ledger(self):
        report = diagnostic.counts_report(
            self.job(configuration={"mode": "live"}, inputs={}),
            {"runs": 1, "chunks": [{"duration_ms": 30000}]},
        )
        self.assertEqual(report["mode"], "live")
        self.assertEqual(report["input_count"], 1)
        self.assertTrue(report["input_samples_match"])

    def test_log_projection_is_job_scoped_and_content_free(self):
        job = "requested-job"
        event = {
            "job_id": job,
            "stage": "storage_upload",
            "code": "failed",
            "elapsed_ms": 42,
            "secret": "PRIVATE",
        }
        logs = "capture_diagnostic " + json.dumps(event)
        logs += "\ncapture_diagnostic " + json.dumps({**event, "job_id": "other"})
        logs += "\ncapture_diagnostic " + json.dumps({**event, "stage": "PRIVATE"})
        logs += "\ncapture_diagnostic not-json PRIVATE"
        logs += "\ncapture_diagnostic null"
        reports = diagnostic.stage_reports(logs, job)
        self.assertEqual(
            reports, [{"stage": "storage_upload", "code": "failed", "elapsed_ms": 42}]
        )
        self.assertNotIn("PRIVATE", json.dumps(reports))

    def test_subprocess_error_does_not_echo_sensitive_output(self):
        with patch.object(
            diagnostic.subprocess,
            "run",
            return_value=SimpleNamespace(
                returncode=1, stdout="PRIVATE-TOKEN", stderr="PRIVATE-URL"
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "^diagnostic_command_failed$"):
                diagnostic.run(["kubectl"])


if __name__ == "__main__":
    unittest.main()
