"""No cluster required: production update fences and limited spec changes."""

import copy
import importlib.util
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "cohort", Path(__file__).with_name("work-account-cohort.py")
)
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class CohortTests(unittest.TestCase):
    def resource(self, kind="Deployment"):
        pod = {
            "containers": [
                {
                    "name": "backend",
                    "image": "old@sha256:x",
                    "resources": {"requests": {"cpu": "200m"}},
                    "env": [
                        {
                            "name": "DATABASE_PASSWORD",
                            "valueFrom": {
                                "secretKeyRef": {"name": "db", "key": "password"}
                            },
                        },
                        {"name": "WORK_LOCAL_AGENT_ENABLED", "value": "False"},
                        {"name": "ORDINARY", "value": "keep"},
                    ],
                }
            ]
        }
        template = {"template": {"metadata": {"labels": {"app": "keep"}}, "spec": pod}}
        return {
            "kind": kind,
            "metadata": {"uid": "reviewed", "resourceVersion": "123"},
            "spec": {"jobTemplate": {"spec": template}, "schedule": "0 * * * *"}
            if kind == "CronJob"
            else template,
        }

    def test_closed_preserves_unrelated_secret_resources_and_env_order(self):
        for kind in ("Deployment", "CronJob"):
            old = self.resource(kind)
            before = copy.deepcopy(old)
            updated = c.changed(old, "new@sha256:x", "closed", "")
            self.assertEqual(old, before)
            pod = (
                updated["spec"]["jobTemplate"]["spec"]["template"]["spec"]
                if kind == "CronJob"
                else updated["spec"]["template"]["spec"]
            )
            container = pod["containers"][0]
            self.assertEqual(container["resources"], {"requests": {"cpu": "200m"}})
            self.assertEqual(
                container["env"][0],
                before["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"][
                    0
                ]["env"][0]
                if kind == "CronJob"
                else before["spec"]["template"]["spec"]["containers"][0]["env"][0],
            )
            values = {e["name"]: e.get("value") for e in container["env"]}
            self.assertEqual(values["ORDINARY"], "keep")
            self.assertTrue(all(values[n] == "False" for n in c.FLAGS))
            self.assertIsNone(values["WORK_AGENT_ALLOWED_USER_IDS"])

    def test_release_roots_are_distinct_and_confined(self):
        old = c.release_root(c.DEFAULT_RELEASE_ID)
        fresh = c.release_root("cohort-e92f9eec4-retest-032")
        self.assertEqual(old, c.STATE_PARENT / c.DEFAULT_RELEASE_ID)
        self.assertEqual(fresh.parent, c.STATE_PARENT)
        self.assertNotEqual(old, fresh)
        for invalid in (
            "../cohort-x",
            "/tmp/cohort-x",
            "cohort-x/y",
            "cohort-x\\y",
            "cohort-",
            "cohort-X",
            "cohort-" + "x" * 64,
            None,
        ):
            with (
                self.subTest(release_id=invalid),
                self.assertRaisesRegex(RuntimeError, "invalid_release_id"),
            ):
                c.release_root(invalid)

    def test_prepare_never_overwrites_an_existing_directory(self):
        with (
            TemporaryDirectory() as owned_dir,
            patch.object(c, "ROOT", Path(owned_dir)),
            self.assertRaisesRegex(RuntimeError, "release_state_exists"),
        ):
            c.prepare(None, {})

    def test_invalid_account_cannot_open(self):
        with self.assertRaisesRegex(RuntimeError, "account_not_reviewed"):
            c.changed(self.resource(), "new", "open", "unreviewed")

    def test_no_drift_bypass_and_rv_is_fresh(self):
        old = self.resource()
        live = copy.deepcopy(old)
        live["metadata"]["resourceVersion"] = "456"
        target = c.changed(old, "new", "closed", "")
        patch = c.patch_for(live, old, target)
        self.assertEqual(patch[1]["value"], "456")
        self.assertEqual(
            patch[2], {"op": "test", "path": "/spec", "value": old["spec"]}
        )
        live["spec"]["template"]["metadata"]["labels"]["app"] = "changed"
        with self.assertRaisesRegex(RuntimeError, "full_spec_drift"):
            c.patch_for(live, old, target)

    def test_recreated_resource_rejected(self):
        old = self.resource()
        live = copy.deepcopy(old)
        live["metadata"]["uid"] = "replacement"
        with self.assertRaisesRegex(RuntimeError, "resource_recreated"):
            c.patch_for(live, old, old)

    def test_duplicate_env_and_sidecars_rejected(self):
        old = self.resource()
        env = old["spec"]["template"]["spec"]["containers"][0]["env"]
        env.append(copy.deepcopy(env[0]))
        with self.assertRaisesRegex(RuntimeError, "duplicate_env"):
            c.changed(old, "new", "closed", "")
        old = self.resource()
        old["spec"]["template"]["spec"]["containers"].append({"name": "new-sidecar"})
        with self.assertRaisesRegex(RuntimeError, "unexpected_sidecar"):
            c.changed(old, "new", "closed", "")


if __name__ == "__main__":
    unittest.main()
