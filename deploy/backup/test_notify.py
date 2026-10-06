import importlib.util
import json
from pathlib import Path
import smtplib
import tempfile
import unittest
from unittest.mock import MagicMock, patch


spec = importlib.util.spec_from_file_location("notify", Path(__file__).with_name("notify.py"))
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)


class NotificationsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "notifications.json"
        self.config = {"from_address": "backup@example.com", "recipients": ["operator@example.com"],
                       "hostname": "test-host", "smtp": {"host": "smtp.example.com", "port": 465,
                       "security": "ssl", "username": "backup@example.com", "password": "not-real"}}
        self.clock = 100000.0
        self.sender = MagicMock()
        self.engine = notify.Notifications(self.path, self.config, self.sender, lambda: self.clock)

    def test_healthy_runs_do_not_send_mail(self):
        self.engine.observe("run", False, "normal", "unused")
        self.engine.flush()
        self.sender.assert_not_called()

    def test_failure_recovery_and_duplicate_observation(self):
        self.engine.observe("run", True, "failed1", "任务执行失败")
        self.assertTrue(self.engine.flush())
        self.engine.observe("run", True, "failed1", "任务执行失败")
        self.engine.flush()
        self.assertEqual(self.sender.call_count, 1)
        self.engine.observe("run", False, "success1", "unused")
        self.engine.flush()
        self.assertEqual(self.sender.call_count, 2)
        self.assertIn("恢复通知", self.sender.call_args.args[2])
        self.engine.observe("run", False, "success2", "unused")
        self.engine.flush()
        self.assertEqual(self.sender.call_count, 2)

    def test_check_success_cannot_clear_failed_backup(self):
        self.engine.observe("run", True, "r1", "failure")
        self.engine.observe("check", False, "c1", "ok")
        self.assertTrue(self.engine.state["incidents"]["run"]["active"])

    def test_repeat_failures_are_limited_to_six_hours(self):
        self.engine.observe("check", True, "c1", "stale")
        self.engine.flush()
        self.clock += 3600
        self.engine.observe("check", True, "c2", "stale")
        self.engine.flush()
        self.assertEqual(self.sender.call_count, 1)
        self.clock += 5 * 3600
        self.engine.flush()
        self.assertEqual(self.sender.call_count, 2)
        self.assertEqual(self.engine.state["pending"], [])

    def test_retry_persists_and_does_not_duplicate_other_recipient(self):
        self.config["recipients"].append("second@example.com")
        self.sender.side_effect = [None, smtplib.SMTPException("private provider detail")]
        self.engine.observe("run", True, "r1", "failure")
        self.assertFalse(self.engine.flush())
        pending = self.engine.state["pending"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["recipient"], "second@example.com")
        self.assertNotIn("private provider detail", self.path.read_text(encoding="utf-8"))
        restarted = notify.Notifications(self.path, self.config, self.sender, lambda: self.clock)
        self.sender.reset_mock(side_effect=True)
        restarted.flush()
        self.sender.assert_not_called()
        self.clock += 60
        restarted.flush()
        self.assertEqual(self.sender.call_args.args[1], "second@example.com")
        self.assertEqual(restarted.state["pending"], [])

    def test_retry_budget_is_finite(self):
        self.sender.side_effect = OSError("network down")
        self.engine.observe("check", True, "c1", "failure")
        for delay in [0, 60, 300, 900, 3600, 1]:
            self.clock += delay
            self.engine.flush()
        self.assertEqual(self.sender.call_count, 5)
        self.assertEqual(self.engine.state["pending"][0]["attempts"], 5)

    def test_recovery_cancels_unsent_failure(self):
        self.engine.observe("run", True, "r1", "failure")
        self.engine.observe("run", False, "r2", "ok")
        self.engine.flush()
        self.sender.assert_not_called()
        self.assertEqual(self.engine.state["pending"], [])

    def test_removed_recipient_receives_no_queued_mail(self):
        self.engine.observe("run", True, "r1", "failure")
        self.config["recipients"] = ["replacement@example.com"]
        self.engine.flush()
        self.sender.assert_not_called()

    def test_transport_uses_verified_tls_and_explicit_recipient(self):
        client = MagicMock()
        client.send_message.return_value = {}
        with patch.object(notify.smtplib, "SMTP_SSL", return_value=client) as connect:
            notify.send_mail(self.config, "operator@example.com", "测试", "body", "<id@example.com>")
        self.assertTrue(connect.call_args.kwargs["context"].check_hostname)
        self.assertEqual(client.send_message.call_args.kwargs["to_addrs"], ["operator@example.com"])
        client.close.assert_called_once()

    def test_insecure_or_missing_recipient_config_rejected(self):
        config_path = self.path.parent / "config.json"
        for key, value in [("security", "none"), ("security", "ssl")]:
            self.config["smtp"][key] = value
            if value == "ssl":
                self.config["recipients"] = []
            config_path.write_text(json.dumps(self.config))
            with self.assertRaises(ValueError):
                notify.load_config(config_path)

    def test_unit_failure_works_even_without_python_status_file(self):
        result = MagicMock(stdout="Result=timeout\nExecMainStatus=15\nExecMainExitTimestamp=now\nActiveState=failed\n")
        with patch.object(notify.subprocess, "run", return_value=result):
            event = notify.unit_event("meet-backup.service", self.path.parent)
        self.assertEqual(event[:2], ("run", True))
        self.assertEqual(event[3], "任务执行超时")

    def test_start_failure_without_main_process_is_reported(self):
        result = MagicMock(stdout="Result=resources\nExecMainStatus=0\nExecMainExitTimestamp=\n"
                           "StateChangeTimestamp=now\nActiveState=failed\n")
        with patch.object(notify.subprocess, "run", return_value=result):
            event = notify.unit_event("meet-backup.service", self.path.parent)
        self.assertEqual(event[:2], ("run", True))

    def test_running_or_never_started_unit_does_not_report_recovery(self):
        for state in ["Result=success\nExecMainStatus=0\nExecMainExitTimestamp=\nActiveState=inactive\n",
                      "Result=success\nExecMainStatus=0\nExecMainExitTimestamp=old\nActiveState=activating\n"]:
            with patch.object(notify.subprocess, "run", return_value=MagicMock(stdout=state)):
                self.assertIsNone(notify.unit_event("meet-backup.service", self.path.parent))

    def test_corrupt_check_receipt_does_not_suppress_alarm(self):
        (self.path.parent / "last-check.json").write_text("broken", encoding="utf-8")
        result = MagicMock(stdout="Result=exit-code\nExecMainStatus=1\nExecMainExitTimestamp=now\nActiveState=failed\n")
        with patch.object(notify.subprocess, "run", return_value=result):
            event = notify.unit_event("meet-backup-check.service", self.path.parent)
        self.assertEqual(event[:2], ("check", True))


if __name__ == "__main__":
    unittest.main()
