"""Cross-service isolation, local-only database access, and snapshot safety."""
import copy
import datetime as dt
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import database_backup as db
import database_notify
import notify
import verify_database_restore as restore


class DatabaseBackupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config = {"service": "docs", "databases": ["impress"], "state_dir": str(self.root),
                       "source": {"kind": "kubernetes", "namespace": "docs", "resource": "deployment/postgres-docs",
                                  "container": "postgresql", "user": "dinum"}}
        self.storage = {"bucket": "private-backups", "prefix": "jd-sjy/databases/docs/"}
        self.receipt = {"format_version": db.FORMAT, "service": "docs", "databases": ["impress"],
                        "bucket": self.storage["bucket"], "key": self.storage["prefix"] + "archive.tar.gz.age",
                        "completed_at": dt.datetime.now(dt.timezone.utc).isoformat(), "bytes": 50, "sha256": "a" * 64}

    def client(self, receipt):
        client = MagicMock()
        client.get_object.return_value = {"Body": io.BytesIO(json.dumps(receipt).encode())}
        client.head_object.return_value = {"ContentLength": 50, "Metadata": {"sha256": "a" * 64}}
        client.get_object_acl.return_value = {"Owner": {"ID": "owner"}, "Grants": [
            {"Grantee": {"Type": "CanonicalUser", "ID": "owner"}, "Permission": "FULL_CONTROL"}]}
        return client

    def test_storage_prefix_cannot_overwrite_meet_or_other_service(self):
        db.validate(self.config, "docs", self.storage)
        for prefix in ["jd-sjy/", "jd-sjy/databases/im/", "../databases/docs/", "/databases/docs/"]:
            with self.assertRaises(ValueError):
                db.validate(self.config, "docs", {**self.storage, "prefix": prefix})

    def test_source_cannot_point_to_remote_database(self):
        self.config["source"]["socket_dir"] = "production.example.com"
        with self.assertRaises(ValueError):
            db.validate(self.config, "docs", self.storage)
        self.config["source"].pop("socket_dir")
        self.config["databases"] = ["host=production dbname=impress"]
        with self.assertRaises(ValueError):
            db.validate(self.config, "docs", self.storage)

    def test_all_transports_use_stdin_without_shell(self):
        self.assertEqual(db.transport(self.config["source"], True),
                         ["kubectl", "-n", "docs", "exec", "-i", "deployment/postgres-docs", "-c", "postgresql", "--"])
        self.assertEqual(db.transport({"kind": "docker", "container": "keycloak-db"}, True),
                         ["docker", "exec", "-i", "keycloak-db"])
        self.assertEqual(db.transport({"kind": "local"}), ["runuser", "-u", "postgres", "--"])

    def test_another_service_or_database_cannot_satisfy_freshness(self):
        for key, value in [("service", "im"), ("databases", ["postgres"]), ("key", "jd-sjy/archive.age"),
                           ("bucket", "different"), ("format_version", 1)]:
            receipt = {**self.receipt, key: value}
            client = self.client(receipt)
            with patch.object(db.backup, "object_client", return_value=client):
                with self.assertRaises(db.backup.BackupCheckError):
                    db.check_backup(self.config, self.storage)
            client.head_object.assert_not_called()

    def test_check_records_success_only_after_metadata_and_acl_match(self):
        with patch.object(db.backup, "object_client", return_value=self.client(self.receipt)):
            db.check_backup(self.config, self.storage)
        self.assertEqual(json.loads((self.root / "last-check.json").read_text())["status"], "success")
        client = self.client(self.receipt)
        client.head_object.return_value["Metadata"]["sha256"] = "tampered"
        with patch.object(db.backup, "object_client", return_value=client):
            with self.assertRaises(db.backup.BackupCheckError):
                db.check_backup(self.config, self.storage)

    def test_stale_and_future_receipts_fail(self):
        for hours, reason in [(-9, "stale"), (1, "future")]:
            receipt = {**self.receipt, "completed_at": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=hours)).isoformat()}
            with patch.object(db.backup, "object_client", return_value=self.client(receipt)):
                with self.assertRaises(db.backup.BackupCheckError) as error:
                    db.check_backup(self.config, self.storage)
            self.assertEqual(error.exception.reason, reason)

    def test_counts_and_dump_share_snapshot_and_commit_after_dump(self):
        session = MagicMock()
        session.__enter__.return_value = session
        session.query.side_effect = [["00000003-0000001A-1"], ["160004"],
                                     [json.dumps([{"schemaname": "public", "tablename": 'test"table'}])],
                                     ["[]"], ["3"], []]
        dump = self.root / "database-0.dump"
        dump.write_bytes(b"fake-dump")
        with patch.object(db, "Session", return_value=session), patch.object(db.backup, "command") as command:
            with patch.object(db.subprocess, "run", return_value=MagicMock(returncode=0)):
                result = db.database_dump(self.config["source"], "impress", dump)
            self.assertIn("--snapshot=00000003-0000001A-1", command.call_args.args[0])
        self.assertEqual(result["tables"][0]["rows"], 3)
        self.assertEqual(session.query.call_args_list[-2].args[0], 'SELECT count(*) FROM "public"."test""table";')
        self.assertEqual(session.query.call_args_list[-1].args[0], "COMMIT;")

    def test_alarm_units_and_state_are_independent(self):
        sender = MagicMock()
        mail = {"from_address": "backup@example.com", "recipients": ["operator@example.com"]}
        docs = notify.Notifications(self.root / "docs.json", copy.deepcopy(mail), sender)
        im = notify.Notifications(self.root / "im.json", copy.deepcopy(mail), sender)
        docs.observe("run", True, "failed-docs", "failure")
        im.observe("run", False, "im-ok", "ok")
        self.assertTrue(docs.state["incidents"]["run"]["active"])
        self.assertNotEqual(database_notify.units_for("docs"), database_notify.units_for("im"))
        with self.assertRaises(ValueError):
            notify.unit_event("meet-db-backup@im.service", self.root, database_notify.units_for("docs"))

    def test_wrong_encrypted_hash_never_starts_restore(self):
        archive = self.root / "database.age"
        archive.write_bytes(b"tampered")
        with patch.object(restore, "run") as command:
            with self.assertRaises(ValueError):
                restore.drill(archive, self.root / "identity", "0" * 64, self.root / "report", "docs")
            command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
