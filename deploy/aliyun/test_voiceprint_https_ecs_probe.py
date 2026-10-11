"""Ensure automation cannot mistake a failed HTTPS receipt for success."""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import voiceprint_https_ecs_probe as probe


class CliStatusTests(unittest.TestCase):
    def check_status(self, status, expected):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "task.json"
            path.write_text("{}", encoding="utf-8")
            output = io.StringIO()
            report = {"status": status, "cleanup": {"namespace_deleted": True}}
            with (
                patch("sys.argv", ["probe", "--task-file", str(path)]),
                patch.object(probe, "main", return_value=report) as main,
                contextlib.redirect_stdout(output),
            ):
                self.assertEqual(probe.cli(), expected)
            main.assert_called_once_with({})
            self.assertEqual(json.loads(output.getvalue()), report)

    def test_failure_receipt_has_nonzero_exit(self):
        self.check_status("failed", 1)

    def test_success_receipt_has_zero_exit(self):
        self.check_status("passed", 0)


if __name__ == "__main__":
    unittest.main()
