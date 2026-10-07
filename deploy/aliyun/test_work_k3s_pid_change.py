import hashlib
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "pid_change", Path(__file__).with_name("change-work-k3s-pids.py")
)
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class PidMaintenanceTest(unittest.TestCase):
    def test_candidate_matches_reviewed_file(self):
        self.assertEqual(
            maintenance.PAYLOAD,
            Path(__file__).with_name("kubelet-work-pids.conf").read_bytes(),
        )

    def test_sqlite_online_snapshot_integrity_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            source, dest = Path(folder) / "live.db", Path(folder) / "backup.db"
            with closing(sqlite3.connect(source)) as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE proof(value TEXT)")
                db.execute("INSERT INTO proof VALUES ('committed')")
                db.commit()
                self.assertGreater(maintenance.sqlite_backup(source, dest), 0)
                with closing(sqlite3.connect(dest)) as copy:
                    self.assertEqual(
                        copy.execute("SELECT value FROM proof").fetchall(),
                        [("committed",)],
                    )
                with self.assertRaises(FileExistsError):
                    maintenance.sqlite_backup(source, dest)

    def test_rollback_refuses_changed_content(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "owned.conf"
            path.write_bytes(maintenance.PAYLOAD)
            inode = path.stat().st_ino
            digest = hashlib.sha256(maintenance.PAYLOAD).hexdigest()
            path.write_bytes(b"changed by someone else")
            with self.assertRaisesRegex(
                maintenance.MaintenanceError, "rollback_target_changed"
            ):
                maintenance.remove_owned_target(path, inode, digest)
            self.assertTrue(path.exists())

    def test_rollback_only_removes_matching_owned_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "owned.conf"
            path.write_bytes(maintenance.PAYLOAD)
            maintenance.remove_owned_target(
                path,
                path.stat().st_ino,
                hashlib.sha256(maintenance.PAYLOAD).hexdigest(),
            )
            self.assertFalse(path.exists())

    def test_cleanup_sends_uid_precondition(self):
        pod = {
            "metadata": {"uid": "owned-uid", "labels": {"work-maintenance-id": "owner"}}
        }
        with patch.object(
            maintenance, "run", return_value=json.dumps(pod).encode()
        ) as run:
            with patch.object(maintenance, "api", return_value={"items": []}):
                maintenance.delete_owned_pod("fixed-name", "owned-uid", "owner")
        arguments, body = run.call_args_list[1].args
        self.assertIn("--raw=/api/v1/namespaces/meet/pods/fixed-name", arguments)
        self.assertEqual(json.loads(body)["preconditions"], {"uid": "owned-uid"})

    def test_cleanup_refuses_other_pod(self):
        pod = {
            "metadata": {"uid": "other-uid", "labels": {"work-maintenance-id": "owner"}}
        }
        with patch.object(
            maintenance, "run", return_value=json.dumps(pod).encode()
        ) as run:
            with self.assertRaisesRegex(
                maintenance.MaintenanceError, "pod_ownership_mismatch"
            ):
                maintenance.delete_owned_pod("fixed-name", "owned-uid", "owner")
        self.assertEqual(run.call_count, 1)

    def test_health_refuses_replaced_business_uid(self):
        pod = {
            "metadata": {"uid": "replacement"},
            "spec": {"containers": [{}]},
            "status": {
                "phase": "Running",
                "containerStatuses": [{"ready": True}],
                "conditions": [{"type": "Ready", "status": "True"}],
            },
        }
        with patch.object(maintenance, "node_state", return_value=512):
            with patch.object(maintenance, "api", return_value={"items": [pod]}):
                with self.assertRaisesRegex(
                    maintenance.MaintenanceError, "health_verification_timeout"
                ):
                    maintenance.wait_health("node", "uid", ["original"], 512, timeout=0)

    def test_probe_uses_unique_names_and_cleans_failed_uid(self):
        pod_uid = "01234567-1234-1234-1234-0123456789ab"
        created = {
            "metadata": {"uid": pod_uid, "labels": {"work-maintenance-id": "owner"}}
        }
        failed = {"metadata": {"uid": pod_uid}, "status": {"phase": "Failed"}}
        with patch.object(
            maintenance, "api", side_effect=[created, failed, created, failed]
        ) as api:
            with patch.object(maintenance, "private_json"):
                with patch.object(maintenance, "delete_owned_pod") as cleanup:
                    for _ in range(2):
                        with self.assertRaisesRegex(
                            maintenance.MaintenanceError, "probe_terminated"
                        ):
                            maintenance.probe_pid(
                                "node",
                                "owner",
                                "repo@sha256:abc",
                                {},
                                Path("receipt"),
                                pull_secrets=[{"name": "existing-registry"}],
                            )
        bodies = [
            json.loads(c.kwargs["body"])
            for c in api.call_args_list
            if c.args[0] == "create"
        ]
        self.assertNotEqual(
            bodies[0]["metadata"]["name"], bodies[1]["metadata"]["name"]
        )
        self.assertEqual(
            bodies[0]["spec"]["containers"][0]["resources"]["requests"]["cpu"], "10m"
        )
        self.assertEqual(
            bodies[0]["spec"]["imagePullSecrets"], [{"name": "existing-registry"}]
        )
        self.assertFalse(bodies[0]["spec"]["automountServiceAccountToken"])
        self.assertEqual(cleanup.call_count, 2)
        self.assertEqual(cleanup.call_args.args[1], pod_uid)

    def test_hostname_drift_stops_before_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(maintenance, "IDENTITY", Path(folder) / "missing.yaml"):
                with patch.object(maintenance, "run", return_value=b"new-hostname\n"):
                    with self.assertRaisesRegex(
                        maintenance.MaintenanceError, "hostname_node_identity_drift"
                    ):
                        maintenance.verify_restart_identity(
                            "original-node", "k3s server"
                        )

    def test_explicit_original_identity_survives_hostname_change(self):
        with tempfile.TemporaryDirectory() as folder:
            pin = Path(folder) / "90-work-maintenance-node-identity.yaml"
            pin.write_text("node-name: original-node\n")
            with patch.object(maintenance, "IDENTITY", pin):
                with patch.object(
                    maintenance, "run", side_effect=[b"new-hostname\n", b""]
                ):
                    maintenance.verify_restart_identity("original-node", "k3s server")


if __name__ == "__main__":
    unittest.main()
