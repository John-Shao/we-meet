import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "business_alignment", Path(__file__).with_name("align-work-business.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def deployment():
    return {
        "kind": "Deployment",
        "metadata": {"name": "backend", "uid": "reviewed", "resourceVersion": "1"},
        "spec": {
            "replicas": 1,
            "template": {
                "spec": {
                    "imagePullSecrets": [{"name": "existing-registry"}],
                    "containers": [
                        {
                            "name": "meet",
                            "image": "repo@sha256:old",
                            "env": [
                                {
                                    "name": n,
                                    "valueFrom": {
                                        "secretKeyRef": {
                                            "name": "existing-db",
                                            "key": n,
                                        }
                                    },
                                }
                                for n in (
                                    "DB_HOST",
                                    "DB_NAME",
                                    "DB_PORT",
                                    "DB_USER",
                                    "DB_PASSWORD",
                                )
                            ]
                            + [{"name": "DASHSCOPE_API_KEY", "value": "fixture-only"}],
                            "resources": {
                                "requests": {"cpu": "200m", "memory": "512Mi"}
                            },
                        }
                    ],
                }
            },
        },
    }


class BusinessAlignmentTests(unittest.TestCase):
    def test_fresh_resource_version_accepts_only_unchanged_spec_and_uid(self):
        old = deployment()
        live = copy.deepcopy(old)
        live["metadata"]["resourceVersion"] = "42"
        result = module.fenced_patch(live, old, "repo@sha256:new")
        self.assertEqual(result[1]["value"], "42")
        live["spec"]["replicas"] = 2
        with self.assertRaisesRegex(module.AlignmentError, "business_spec_drift"):
            module.fenced_patch(live, old, "repo@sha256:new")
        live = copy.deepcopy(old)
        live["metadata"]["uid"] = "recreated"
        with self.assertRaisesRegex(module.AlignmentError, "resource_recreated"):
            module.fenced_patch(live, old, "repo@sha256:new")

    def test_patch_preserves_original_env_resources_and_only_closes_new_flags(self):
        old = deployment()
        result = module.changed_spec(old, "repo@sha256:new")
        before = module.pod_spec(old)["containers"][0]
        after = module.pod_spec(result)["containers"][0]
        self.assertEqual(after["resources"], before["resources"])
        self.assertEqual(after["env"][: len(before["env"])], before["env"])
        self.assertEqual(
            after["env"][len(before["env"]) :],
            [{"name": n, "value": "False"} for n in module.FLAGS],
        )
        self.assertEqual(before["image"], "repo@sha256:old")

    def test_migration_job_has_db_refs_and_no_provider_secret_or_service_selector(self):
        job = module.migration_job(deployment(), "repo@sha256:new")
        pod = job["spec"]["template"]["spec"]
        names = {e["name"] for e in pod["containers"][0]["env"]}
        self.assertNotIn("DASHSCOPE_API_KEY", names)
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(pod["imagePullSecrets"], [{"name": "existing-registry"}])
        self.assertEqual(job["spec"]["backoffLimit"], 0)
        self.assertEqual(job["spec"]["activeDeadlineSeconds"], 180)
        self.assertNotIn(
            "app.kubernetes.io/component", job["spec"]["template"]["metadata"]["labels"]
        )
        self.assertNotIn("nodeName", pod)

    def test_previous_failed_rollout_cannot_be_followed_by_another(self):
        with (
            patch.object(
                module,
                "read_private",
                return_value={"phase": "rolling", "in_flight": "first"},
            ),
            patch.object(module, "api") as api,
        ):
            with self.assertRaisesRegex(
                module.AlignmentError, "previous_rollout_requires_inspection"
            ):
                module.rollout("second")
            api.assert_not_called()

    def test_backup_retry_refuses_state_after_migration(self):
        with (
            patch.object(module, "read_private", return_value={"phase": "migrated"}),
            patch.object(module, "schema") as schema,
        ):
            with self.assertRaisesRegex(
                module.AlignmentError, "backup_retry_requires_pre_migration_state"
            ):
                module.backup_database()
            schema.assert_not_called()

    def test_cronjob_patch_targets_future_template_only(self):
        old = deployment()
        old["kind"] = "CronJob"
        old["spec"] = {
            "schedule": "0 * * * *",
            "jobTemplate": {"spec": {"template": old["spec"]["template"]}},
        }
        result = module.fenced_patch(old, old, "repo@sha256:new")
        self.assertTrue(
            all(
                op["path"].startswith("/metadata/")
                or op["path"].startswith("/spec/jobTemplate/spec/template/")
                for op in result
            )
        )


if __name__ == "__main__":
    unittest.main()
