import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "finalization", Path(__file__).with_name("finalize-work-k3s-production.py")
)
finalization = importlib.util.module_from_spec(spec)
spec.loader.exec_module(finalization)


class FinalizationTests(unittest.TestCase):
    def prepare(self, folder):
        root = Path(folder)
        source = json.dumps(
            {"release_id": "marker", "supplier_calls": 3, "phase": "failed"}
        ).encode()
        (root / "acceptance.json").write_bytes(source)
        (root / "state.json").write_text(json.dumps({"id": "marker"}))
        return root, source

    def test_started_finalization_never_repeats_probes_or_jobs(self):
        with tempfile.TemporaryDirectory() as folder:
            root, source = self.prepare(folder)
            (root / "finalization.json").write_text("{}")
            with (
                patch.object(finalization.h, "ROOT", root),
                patch.object(finalization.os, "name", "posix"),
                patch.object(finalization.os, "geteuid", return_value=0, create=True),
                patch.object(finalization.os, "umask"),
                patch.object(finalization, "snapshot") as snapshot,
            ):
                with self.assertRaisesRegex(
                    finalization.h.AcceptanceError, "finalization_already_started"
                ):
                    finalization.execute()
                snapshot.assert_not_called()
            self.assertEqual((root / "acceptance.json").read_bytes(), source)

    def test_active_job_refuses_new_probes_and_preserves_failed_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            root, source = self.prepare(folder)
            with (
                patch.object(finalization.h, "ROOT", root),
                patch.object(finalization.os, "name", "posix"),
                patch.object(finalization.os, "geteuid", return_value=0, create=True),
                patch.object(finalization.os, "umask"),
                patch.object(
                    finalization,
                    "snapshot",
                    return_value={"model_calls": 3, "jobs": [["fixed", "running"]]},
                ),
                patch.object(finalization.h, "create_probe") as create,
                patch.object(finalization.h, "api", return_value={"items": []}),
            ):
                with self.assertRaisesRegex(
                    finalization.h.AcceptanceError, "active_model_jobs"
                ):
                    finalization.execute()
                create.assert_not_called()
            self.assertEqual((root / "acceptance.json").read_bytes(), source)
            report = json.loads((root / "finalization.json").read_text())
            self.assertEqual(report["failure"], "active_model_jobs")
            self.assertEqual(report["additional_supplier_calls"], 0)


if __name__ == "__main__":
    unittest.main()
