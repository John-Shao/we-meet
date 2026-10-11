"""Namespace collisions and changed ownership must never permit deletion."""

import contextlib
import io
import json
import unittest
from unittest.mock import patch

import voiceprint_network_policy_probe as probe


def task():
    identifier = "0123456789ab"
    namespace = "vp-network-probe-" + identifier
    return {
        "task_id": identifier,
        "image_reference": "example.invalid/fixture@sha256:" + "a" * 64,
        "release": "fixture",
        "policy": {
            "kind": "NetworkPolicy",
            "metadata": {"namespace": namespace},
            "spec": {
                "policyTypes": ["Ingress", "Egress"],
                "egress": [],
                "podSelector": {"matchLabels": {"component": "fixture"}},
            },
        },
    }


class OwnershipTest(unittest.TestCase):
    def run_probe(self, command, apply=None):
        output = io.StringIO()
        with (
            patch.object(probe, "command", side_effect=command),
            patch.object(probe, "apply", side_effect=apply),
            contextlib.redirect_stdout(output),
        ):
            probe.main(task())
        return json.loads(output.getvalue())

    def test_existing_namespace_is_not_adopted_or_deleted(self):
        calls = []

        def command(*args, **kwargs):
            calls.append(args)
            return "namespace/already-exists"

        result = self.run_probe(command)
        self.assertEqual(result["error"], "namespace_already_exists")
        self.assertFalse(any(args[0] in ("create", "delete", "exec") for args in calls))
        self.assertEqual(result["cleanup"], {})

    def test_changed_ownership_prevents_cleanup(self):
        self.verify_failed_setup_cleanup(owned=False)

    def test_failed_setup_deletes_only_the_created_owned_namespace(self):
        self.verify_failed_setup_cleanup(owned=True)

    def verify_failed_setup_cleanup(self, *, owned):
        calls = []
        namespace = "vp-network-probe-0123456789ab"
        labels = {
            "app.kubernetes.io/managed-by": "codex",
            "voiceprint-test-id": "0123456789ab" if owned else "someone-else",
        }

        def command(*args, **kwargs):
            calls.append(args)
            if args[:2] == ("get", "namespace") and "json" in args:
                return json.dumps({"metadata": {"labels": labels}})
            return ""

        def fail_setup(body):
            raise RuntimeError("fixture_setup_failed")

        result = self.run_probe(command, fail_setup)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"], "fixture_setup_failed")
        self.assertEqual(result["cleanup"], {namespace: owned})
        deletes = [args for args in calls if args[0] == "delete"]
        self.assertEqual([args[2] for args in deletes], [namespace] if owned else [])

    def test_invalid_id_does_not_contact_the_cluster(self):
        data = task()
        data["task_id"] = "../meet"
        with patch.object(probe, "command") as command:
            with self.assertRaises(ValueError):
                probe.main(data)
            command.assert_not_called()

    def test_arbitrary_mutable_or_foreign_task_image_is_rejected(self):
        for image in (
            "example.invalid/business:latest",
            "localhost/we-meet-voiceprint-bench:ecs-fedcba987654",
        ):
            data = task()
            data["image_reference"] = image
            output = io.StringIO()
            with (
                patch.object(probe, "command") as command,
                contextlib.redirect_stdout(output),
            ):
                probe.main(data)
            command.assert_not_called()
            self.assertEqual(
                json.loads(output.getvalue())["error"], "cached_image_digest_required"
            )


if __name__ == "__main__":
    unittest.main()
