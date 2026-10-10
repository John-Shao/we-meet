"""Failure-path checks: diagnostics must never prevent owned Docker cleanup."""

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import run_voiceprint_rtc_probe as probe
import voiceprint_rtc_backend_probe as backend


class PermitEvidenceTests(unittest.TestCase):
    """Reject inconsistent live origins and incomplete janitor erasure."""

    @staticmethod
    def permit(*, scrubbed=False):
        participation = SimpleNamespace(
            session_id="session",
            user_id="owner",
            session=SimpleNamespace(livekit_room_sid="RM_current"),
            livekit_participant_sid="PA_current",
            identity="synthetic-owner",
        )
        return SimpleNamespace(
            track=SimpleNamespace(
                participation=participation, livekit_track_sid="TR_current"
            ),
            owner_id="owner",
            source_session_id="session",
            profile_id=None if scrubbed else "profile",
            status="canceled" if scrubbed else "issued",
            sample_id=None,
            livekit_room_sid="" if scrubbed else "RM_current",
            participant_sid="" if scrubbed else "PA_current",
            participant_identity="" if scrubbed else "synthetic-owner",
            source_track_sid="" if scrubbed else "TR_current",
            device_group="" if scrubbed else "headset",
        )

    def test_live_and_complete_terminal_origins_are_valid(self):
        for status in ("issued", "consumed", "canceled", "expired"):
            value = self.permit()
            value.status = status
            self.assertTrue(backend.permit_binding_valid(value))
        for status in ("canceled", "expired"):
            value = self.permit(scrubbed=True)
            value.status = status
            self.assertTrue(backend.permit_binding_valid(value))

    def test_live_origin_mismatches_are_rejected(self):
        for field in (
            "owner_id",
            "source_session_id",
            "livekit_room_sid",
            "participant_sid",
            "participant_identity",
            "source_track_sid",
        ):
            with self.subTest(field=field):
                value = self.permit()
                setattr(value, field, "other")
                self.assertFalse(backend.permit_binding_valid(value))

    def test_scrubbing_never_excuses_owner_or_session_mismatch(self):
        for field in ("owner_id", "source_session_id", "track"):
            with self.subTest(field=field):
                value = self.permit(scrubbed=True)
                setattr(value, field, None)
                self.assertFalse(backend.permit_binding_valid(value))

    def test_partial_erasure_or_live_scrubbed_receipt_is_rejected(self):
        for field in (
            "livekit_room_sid",
            "participant_sid",
            "participant_identity",
            "source_track_sid",
            "device_group",
            "sample_id",
        ):
            with self.subTest(field=field):
                value = self.permit(scrubbed=True)
                setattr(value, field, "retained")
                self.assertFalse(backend.permit_binding_valid(value))
        for status in ("issued", "consumed"):
            value = self.permit(scrubbed=True)
            value.status = status
            self.assertFalse(backend.permit_binding_valid(value))


class CleanupTests(unittest.TestCase):
    """Simulate a startup failure without contacting Docker or a registry."""

    def exercise(self, failure):
        """Force independent diagnostics failures, preserving the original error."""
        calls = []
        owned = ["postgres", "redis", "livekit", "encoder", "backend", "sampler"]

        def docker(*arguments, **_keywords):
            calls.append(arguments)
            if arguments[:2] == ("network", "create"):
                output = "owned-network"
            elif arguments[:2] == ("network", "inspect"):
                output = json.dumps(
                    [{"IPAM": {"Config": [{"Subnet": "10.44.0.0/24"}]}}]
                )
            elif arguments[0] == "create":
                output = "owned-" + arguments[arguments.index("--network-alias") + 1]
            elif arguments[0] == "inspect":
                output = json.dumps([{"State": {"Running": False}}])
            elif failure == "docker" and arguments == ("logs", "owned-postgres"):
                raise subprocess.TimeoutExpired("fixture-docker", 1)
            else:
                output = ""
            return subprocess.CompletedProcess("fixture-docker", 0, output, "")

        original_write = Path.write_text
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pack, diagnostics = root / "pack", root / "diagnostics"
            pack.mkdir()

            def write_text(path, *arguments, **keywords):
                if (
                    failure == "write"
                    and path.parent == diagnostics
                    and path.suffix == ".log"
                ):
                    raise OSError("synthetic_diagnostic_failure")
                return original_write(path, *arguments, **keywords)

            with (
                patch.object(probe, "docker", side_effect=docker),
                patch.object(Path, "write_text", write_text),
                patch.object(
                    probe.sys,
                    "argv",
                    [
                        "probe",
                        "--model-pack",
                        str(pack),
                        "--diagnostics-dir",
                        str(diagnostics),
                    ],
                ),
                contextlib.redirect_stderr(io.StringIO()) as output,
                self.assertRaisesRegex(RuntimeError, "^rtc_backend_startup_failed$"),
            ):
                probe.main()
            self.assertIn("rtc_fixture_cleanup_incomplete", output.getvalue())
            self.assertEqual(list(diagnostics.glob("vp-full-rtc-*-*/")), [])
        removals = [arguments[-1] for arguments in calls if arguments[0] == "rm"]
        self.assertCountEqual(removals, ["owned-" + alias for alias in owned])
        self.assertEqual(calls[-1], ("network", "rm", "owned-network"))

    def test_diagnostic_write_failure_still_removes_every_owned_resource(self):
        self.exercise("write")

    def test_docker_log_timeout_still_removes_every_owned_resource(self):
        self.exercise("docker")


if __name__ == "__main__":
    unittest.main()
