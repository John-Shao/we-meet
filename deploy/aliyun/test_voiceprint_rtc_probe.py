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
import voiceprint_filetrans_fixture as filetrans
import voiceprint_import_fixture as imported
import voiceprint_rtc_backend_probe as backend


class ImageIdentityTests(unittest.TestCase):
    """Reject missing identities and retain the image seen before a tag changes."""

    def test_cached_references_are_resolved_once_to_full_image_ids(self):
        first, second = "sha256:" + "a" * 64, "sha256:" + "b" * 64
        with patch.object(
            probe,
            "docker",
            side_effect=[
                subprocess.CompletedProcess("docker", 0, first + "\n", ""),
                subprocess.CompletedProcess("docker", 0, second + "\n", ""),
            ],
        ) as docker:
            result = probe.resolve_images(["backend:tag", "backend:tag", "encoder:tag"])
        self.assertEqual(result, {"backend:tag": first, "encoder:tag": second})
        self.assertEqual(docker.call_count, 2)
        self.assertTrue(
            all(call.args[:2] == ("image", "inspect") for call in docker.call_args_list)
        )

    def test_invalid_or_ambiguous_cached_identity_is_rejected(self):
        for output in (
            "",
            "latest",
            "sha256:abcd",
            "sha256:" + "A" * 64,
            "sha256:" + "a" * 64 + "\nsha256:" + "b" * 64,
        ):
            with (
                self.subTest(output=output),
                patch.object(
                    probe,
                    "docker",
                    return_value=subprocess.CompletedProcess("docker", 0, output, ""),
                ),
                self.assertRaisesRegex(
                    RuntimeError, "^rtc_cached_image_identity_invalid$"
                ),
            ):
                probe.resolve_images(["backend:tag"])


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


class IdentityEvidenceTests(unittest.TestCase):
    """Accept native query segmentation while rejecting incomplete or dirty runs."""

    @staticmethod
    def receipt():
        return {
            "jobs": 1,
            "jobs_succeeded": 1,
            "suggestions": 1,
            "suggested": 1,
            "confirmed": 1,
            "decisions": 1,
            "attempts": [1],
            "attributed_to_owner": True,
            "support_samples": 3,
            "query_clips": [5],
            "query_speech_ms": [25000],
            "query_temp_children": 0,
            "storage": {"heads": 1, "gets": 1},
        }

    def test_real_segment_count_can_differ_from_transcript_row_count(self):
        self.assertTrue(backend.identity_evidence_valid(self.receipt()))

    def test_incomplete_identity_or_temp_cleanup_is_rejected(self):
        self.assertFalse(backend.identity_evidence_valid(None))
        for field, value in (
            ("jobs_succeeded", 0),
            ("confirmed", 0),
            ("decisions", 2),
            ("attributed_to_owner", False),
            ("support_samples", 4),
            ("query_temp_children", None),
            ("query_temp_children", 1),
            ("storage", {"heads": 1, "gets": 0}),
        ):
            with self.subTest(field=field, value=value):
                self.assertFalse(
                    backend.identity_evidence_valid({**self.receipt(), field: value})
                )

    def test_unbounded_or_insufficient_query_is_rejected(self):
        for clips, speech in (
            ([], []),
            ([2], [10000]),
            ([13], [25000]),
            ([5], [8999]),
            ([5], [30001]),
            ([5, 5], [25000, 25000]),
        ):
            with self.subTest(clips=clips, speech=speech):
                self.assertFalse(
                    backend.identity_evidence_valid(
                        {
                            **self.receipt(),
                            "query_clips": clips,
                            "query_speech_ms": speech,
                        }
                    )
                )


class CleanupTests(unittest.TestCase):
    """Simulate a startup failure without contacting Docker or a registry."""

    def exercise(  # noqa: PLR0915 -- One owned-resource failure scenario and its assertions.
        self, failure, *, synthetic_identification=False, import_web_review=False
    ):
        """Force independent diagnostics failures, preserving the original error."""
        calls = []
        owned = [
            "postgres",
            "authority",
            "redis",
            "livekit",
            "encoder",
            "backend",
            "sampler",
        ]
        if import_web_review:
            synthetic_identification = True
            owned.insert(owned.index("backend"), "filetrans")
            owned.insert(owned.index("sampler"), "minio")
            if failure == "relay":
                owned.append("relay")
        if failure == "schema":
            owned = owned[:2]

        def docker(*arguments, **_keywords):
            calls.append(arguments)
            if arguments[:2] == ("image", "inspect"):
                output = "sha256:" + "a" * 64
            elif arguments[:2] == ("network", "create"):
                output = "owned-network"
            elif arguments[:2] == ("network", "inspect"):
                output = json.dumps(
                    [{"IPAM": {"Config": [{"Subnet": "10.44.0.0/24"}]}}]
                )
            elif arguments[0] == "create":
                if failure == "relay" and arguments[
                    arguments.index("--name") + 1
                ].endswith("-driver"):
                    raise RuntimeError("rtc_relay_fixture_failure")
                output = (
                    "owned-"
                    + arguments[arguments.index("--name") + 1].rsplit("-", 1)[-1]
                )
            elif arguments[0] == "inspect":
                output = json.dumps(
                    [
                        {
                            "State": {"Running": failure == "relay"},
                            "NetworkSettings": {
                                "Networks": {"owned": {"IPAddress": "10.44.0.7"}}
                            },
                        }
                    ]
                )
            elif failure == "relay" and arguments == ("logs", "owned-backend"):
                output = '{"event": "rtc_backend_fixture_ready"}'
            elif failure == "docker" and arguments == ("logs", "owned-postgres"):
                raise subprocess.TimeoutExpired("fixture-docker", 1)
            else:
                output = ""
            return subprocess.CompletedProcess("fixture-docker", 0, output, "")

        original_write = Path.write_text
        written = {}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pack, diagnostics = root / "pack", root / "diagnostics"
            pack.mkdir()

            def write_text(path, *arguments, **keywords):
                if path.name in ("backend.env", "threshold.json", "driver.json"):
                    written[path.name] = arguments[0]
                if (
                    failure in ("write", "relay")
                    and path.parent == diagnostics
                    and path.suffix == ".log"
                ):
                    raise OSError("synthetic_diagnostic_failure")
                return original_write(path, *arguments, **keywords)

            with (
                patch.object(probe, "docker", side_effect=docker),
                patch.object(probe.journal_fixture, "wait_database"),
                patch.object(
                    probe.journal_fixture,
                    "private_sql",
                    return_value=subprocess.CompletedProcess(
                        "fixture-sql", 1 if failure == "schema" else 0, "", ""
                    ),
                ),
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
                        *(["--import-web-review"] if import_web_review else []),
                        *(
                            ["--synthetic-identification"]
                            if synthetic_identification
                            else []
                        ),
                    ],
                ),
                contextlib.redirect_stderr(io.StringIO()) as output,
                self.assertRaisesRegex(
                    RuntimeError,
                    "^rtc_journal_install_failed$"
                    if failure == "schema"
                    else "^rtc_relay_fixture_failure$"
                    if failure == "relay"
                    else "^rtc_backend_startup_failed$",
                ),
            ):
                probe.main()
            if failure != "schema":
                self.assertIn("rtc_fixture_cleanup_incomplete", output.getvalue())
            self.assertEqual(list(diagnostics.glob("vp-full-rtc-*-*/")), [])
        removals = [arguments[-1] for arguments in calls if arguments[0] == "rm"]
        self.assertCountEqual(removals, ["owned-" + alias for alias in owned])
        self.assertEqual(calls[-1], ("network", "rm", "owned-network"))
        creations = [arguments for arguments in calls if arguments[0] == "create"]
        self.assert_identity_scope(written, synthetic_identification)
        for arguments in creations:
            self.assertIn("--pull=never", arguments)
            self.assertIn("sha256:" + "a" * 64, arguments)
            for option in ("--cpus", "--memory", "--pids-limit"):
                self.assertEqual(arguments.count(option), 1)
            if import_web_review and arguments[arguments.index("--name") + 1].endswith(
                "-relay"
            ):
                self.assertEqual(
                    arguments[arguments.index("--publish") + 1], "127.0.0.1:5318:8000"
                )
            else:
                self.assertNotIn("--publish", arguments)
            if import_web_review and arguments[arguments.index("--name") + 1].endswith(
                "-minio"
            ):
                self.assertEqual(
                    arguments[arguments.index("--network") + 1],
                    "container:owned-backend",
                )
                self.assertNotIn("--network-alias", arguments)
            self.assertNotIn("-p", arguments)

    def test_real_storage_web_opt_in_keeps_ports_local_and_cleans_owned_resources(self):
        self.exercise("relay", import_web_review=True)

    def assert_identity_scope(self, written, synthetic_identification):
        """Matching stays disabled unless the operator explicitly opts in."""
        environment = dict(
            line.split("=", 1) for line in written["backend.env"].splitlines()
        )
        self.assertEqual(
            environment["MEETING_VOICEPRINT_MATCHING_ENABLED"],
            "true" if synthetic_identification else "false",
        )
        self.assertEqual(
            environment["VOICEPRINT_SYNTHETIC_IDENTITY"],
            "1" if synthetic_identification else "0",
        )
        self.assertEqual(
            json.loads(written["driver.json"])["synthetic_identification"],
            synthetic_identification,
        )
        if synthetic_identification:
            self.assertEqual(
                json.loads(written["threshold.json"])["threshold_version"],
                "rtc-synthetic-test-only-v1",
            )
            self.assertTrue(environment["MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE"])
        else:
            self.assertNotIn("threshold.json", written)
            self.assertEqual(
                environment["MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE"], ""
            )

    def test_diagnostic_write_failure_still_removes_every_owned_resource(self):
        self.exercise("write")

    def test_docker_log_timeout_still_removes_every_owned_resource(self):
        self.exercise("docker")

    def test_journal_schema_failure_removes_both_databases_and_credentials(self):
        self.exercise("schema")

    def test_identification_is_explicit_and_cleans_up_on_startup_failure(self):
        self.exercise("write", synthetic_identification=True)


class FiletransBoundaryTests(unittest.TestCase):
    def test_untrusted_or_unsigned_origins_are_rejected_before_fetch(self):
        urls = [
            "https://example.com/a.wav",
            "http://backend:9000/a.wav?x=1",
            "http://backend:9000/voiceprint-rtc-fixture/record-uploads/identity-input-a.wav",
            "http://backend:9000/voiceprint-rtc-fixture/record-uploads/identity-input-a.wav?x=1#fragment",
            "http://user@backend:9000/voiceprint-rtc-fixture/record-uploads/identity-input-a.wav?x=1",
        ]
        with patch.object(filetrans, "build_opener") as opener:
            for url in urls:
                with self.subTest(url=url), self.assertRaises(ValueError):
                    filetrans.read_audio(url)
            opener.assert_not_called()

    def test_signed_source_cannot_redirect_to_another_origin(self):
        with self.assertRaisesRegex(ValueError, "filetrans_fixture_redirect_rejected"):
            filetrans.NoRedirect().redirect_request(
                None, None, 302, None, None, "https://example.com"
            )


class WebProcessCleanupTests(unittest.TestCase):
    @unittest.skipUnless(probe.os.name == "nt", "Windows process tree cleanup")
    def test_browser_deadline_terminates_only_the_owned_node_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = Path(temporary)
            with (
                patch.object(probe.subprocess, "Popen") as launch,
                patch.object(probe.subprocess, "run") as terminate,
            ):
                process = launch.return_value
                process.pid = 424242
                process.poll.return_value = None
                process.wait.side_effect = [
                    subprocess.TimeoutExpired("owned-node", 600),
                    0,
                ]
                with self.assertRaises(subprocess.TimeoutExpired):
                    probe.web_review(artifacts / "private-web.json", artifacts)
                self.assertEqual(
                    terminate.call_args.args[0],
                    ["taskkill", "/PID", "424242", "/T", "/F"],
                )
                self.assertEqual(
                    launch.call_args.args[0],
                    ["node", "scripts/review-local-import-identity.mjs"],
                )


class ImportCompletionTests(unittest.TestCase):
    @staticmethod
    def receipt():
        return {
            **IdentityEvidenceTests.receipt(),
            "jobs_succeeded": 0,
            "jobs_canceled_for_presentation": 1,
            "decisions": 5,
            "upload_status": "succeeded",
            "preflight_status": "ready",
            "dispatch_status": "submitted",
            "upload_attempt": 1,
            "dispatch_attempts": 1,
            "original_segments": 3,
            "original_speakers": 1,
            "attribution_kind": "custom",
            "manual_label": "Synthetic final label",
            "decision_actions": [
                "confirm_suggestion",
                "select_contact",
                "set_label",
                "set_label",
                "set_label",
            ],
            "provider": {
                "submissions": 1,
                "signed_audio_reads": 1,
                "polls": 1,
                "result_reads": 1,
            },
            "versioned_prepared_inputs": 1,
            "unsigned_source_status": 403,
        }

    def test_successful_request_may_be_canceled_after_human_override(self):
        fixture = object.__new__(imported.ImportFixture)
        with patch.object(fixture, "evidence", return_value=self.receipt()):
            self.assertEqual(fixture.complete(), {"status": "passed"})
        self.assertTrue(fixture.web_complete)

    def test_duplicate_work_or_lost_manual_decision_never_completes(self):
        for field, value in (
            ("jobs_canceled_for_presentation", 0),
            ("decisions", 6),
            ("manual_label", "Synthetic stale label"),
            ("versioned_prepared_inputs", 0),
            ("unsigned_source_status", 200),
        ):
            with self.subTest(field=field):
                fixture = object.__new__(imported.ImportFixture)
                fixture.web_complete = False
                with (
                    patch.object(
                        fixture,
                        "evidence",
                        return_value={**self.receipt(), field: value},
                    ),
                    self.assertRaises(RuntimeError),
                ):
                    fixture.complete()
                self.assertFalse(fixture.web_complete)


if __name__ == "__main__":
    unittest.main()
