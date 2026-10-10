"""Render private API/consumer/expiry resources without a cluster or credentials."""

import unittest

from deploy.aliyun.test_voiceprint_encoder_chart import render

DIGEST = "registry.example.invalid/backend@sha256:" + "b" * 64


class VoiceprintRuntimeChartTest(unittest.TestCase):
    settings = (
        "voiceprintRuntime.enabled=true",
        "voiceprintRuntime.configurationSecret=fixture-private",
        f"backend.image.reference={DIGEST}",
    )
    workers = settings + (
        "voiceprintWorkers.enabled=true",
        "celeryBeat.enabled=true",
        "backend.envVars.CELERY_ENABLED=true",
    )

    def deployments(self, *settings):
        return [row for row in render(*settings) if row["kind"] == "Deployment"]

    def test_default_has_no_runtime_mounts_janitors_workers_or_business_flags(self):
        for row in self.deployments():
            spec = row["spec"]["template"]["spec"]
            self.assertNotIn("celery-voiceprint", row["metadata"]["labels"].values())
            for container in spec["containers"]:
                self.assertNotEqual("voiceprint-query-janitor", container["name"])
                self.assertFalse(
                    any(
                        item["name"].startswith("MEETING_VOICEPRINT_")
                        for item in (container.get("env") or [])
                    )
                )

    def test_runtime_requires_private_material_and_pinned_backend_artifact(self):
        for settings, reason in (
            (("voiceprintRuntime.enabled=true",), "configurationSecret"),
            (
                (
                    "voiceprintRuntime.enabled=true",
                    "voiceprintRuntime.configurationSecret=x",
                ),
                "immutable",
            ),
            (self.settings + ("voiceprintRuntime.userId=0",), "userId"),
            (self.settings + ("voiceprintRuntime.userId=1000.5",), "userId"),
            (self.settings + ("backend.podSecurityContext.runAsUser=1234",), "UID/GID"),
            (self.settings + ("backend.envVars.TMPDIR=/unshared",), "TMPDIR"),
            (
                self.settings
                + ("backend.envVars.MEETING_VOICEPRINT_MEDIA_CONFIG_FILE=/other",),
                "private file paths",
            ),
        ):
            self.assertIn(reason, render(*settings, success=False))

    def test_api_pools_use_one_read_only_secret_and_consistent_uid_and_private_paths(
        self,
    ):
        rows = self.deployments(*self.settings, "aiBackend.enabled=true")
        pools = [
            row
            for row in rows
            if row["metadata"]["labels"]["app.kubernetes.io/component"]
            in {"backend", "backend-ai"}
        ]
        self.assertEqual(2, len(pools))
        for row in pools:
            pod = row["spec"]["template"]["spec"]
            self.assertEqual(10001, pod["securityContext"]["runAsUser"])
            self.assertEqual(10001, pod["securityContext"]["fsGroup"])
            self.assertEqual("linux", pod["nodeSelector"]["kubernetes.io/os"])
            self.assertEqual("amd64", pod["nodeSelector"]["kubernetes.io/arch"])
            app, janitor = [
                next(c for c in pod["containers"] if c["name"] == name)
                for name in ("meet", "voiceprint-query-janitor")
            ]
            self.assertEqual(DIGEST, app["image"])
            self.assertEqual(DIGEST, janitor["image"])
            env = {item["name"]: item.get("value") for item in app["env"]}
            self.assertEqual(
                "/run/voiceprint-backend/encoder.json",
                env["MEETING_VOICEPRINT_ENCODER_CONFIG_FILE"],
            )
            self.assertEqual("/tmp", env["TMPDIR"])
            self.assertNotIn("MEETING_VOICEPRINT_ENABLED", env)
            private = next(
                v for v in pod["volumes"] if v["name"] == "voiceprint-private"
            )
            self.assertEqual(
                {"secretName": "fixture-private", "defaultMode": 0o440},
                private["secret"],
            )
            self.assertTrue(
                next(
                    v for v in app["volumeMounts"] if v["name"] == "voiceprint-private"
                )["readOnly"]
            )
            self.assertEqual(
                [{"name": "voiceprint-tmp", "mountPath": "/tmp"}],
                janitor["volumeMounts"],
            )
            self.assertEqual(10001, janitor["securityContext"]["runAsUser"])
            self.assertTrue(janitor["securityContext"]["readOnlyRootFilesystem"])

    def test_workers_need_runtime_single_beat_and_real_async_consumption(self):
        for extra, reason in (
            (
                (
                    "backend.podAnnotations.meet\\.voiceprint/configuration-revision=other",
                ),
                "revision annotation",
            ),
            (("voiceprintRuntime.enabled=false",), "voiceprintRuntime"),
            (("celeryBeat.enabled=false",), "singleton"),
            (("backend.envVars.CELERY_ENABLED=false",), "CELERY_ENABLED"),
            (("backend.envVars.CELERY_TASK_ALWAYS_EAGER=true",), "eager"),
            (("voiceprintWorkers.replicas=9",), "replicas"),
            (
                ("voiceprintWorkers.nodeSelector.kubernetes\\.io/arch=arm64",),
                "Linux amd64",
            ),
            (
                ("celeryBeat.envVars.CELERY_BROKER_URL=redis://other/0",),
                "share backend",
            ),
        ):
            self.assertIn(reason, render(*self.workers, *extra, success=False))

    def test_three_queues_have_separate_fixed_entrypoints_budgets_and_role_selectors(
        self,
    ):
        rows = self.deployments(*self.workers)
        roles = [
            row
            for row in rows
            if row["metadata"]["labels"].get("app.kubernetes.io/component")
            == "celery-voiceprint"
        ]
        self.assertEqual(
            {"control", "processing", "identity"},
            {row["metadata"]["labels"]["meet.voiceprint/role"] for row in roles},
        )
        for row in roles:
            role = row["metadata"]["labels"]["meet.voiceprint/role"]
            pod = row["spec"]["template"]["spec"]
            worker = next(
                c for c in pod["containers"] if c["name"] == "voiceprint-worker"
            )
            self.assertEqual(
                ["python", "manage.py", "run_voiceprint_worker", "--role", role],
                worker["command"],
            )
            self.assertEqual(DIGEST, worker["image"])
            self.assertFalse(pod["automountServiceAccountToken"])
            self.assertTrue(worker["securityContext"]["readOnlyRootFilesystem"])
            self.assertEqual("3Gi", worker["resources"]["limits"]["ephemeral-storage"])
            self.assertEqual("Recreate", row["spec"]["strategy"]["type"])
            self.assertEqual(
                role, row["spec"]["selector"]["matchLabels"]["meet.voiceprint/role"]
            )
            self.assertEqual(
                {"sizeLimit": "2Gi"},
                next(v for v in pod["volumes"] if v["name"] == "voiceprint-tmp")[
                    "emptyDir"
                ],
            )
            self.assertEqual(
                {"control": 210, "processing": 150, "identity": 930}[role],
                pod["terminationGracePeriodSeconds"],
            )

    def test_runtime_rejects_ai_pool_feature_drift_and_rotates_all_private_consumers(
        self,
    ):
        self.assertIn(
            "API pools must share",
            render(
                *self.settings,
                "aiBackend.enabled=true",
                "aiBackend.envVars.MEETING_VOICEPRINT_ENABLED=true",
                success=False,
            ),
        )
        for row in self.deployments(
            *self.workers, "voiceprintRuntime.configurationRevision=rotated"
        ):
            if row["metadata"]["labels"].get("app.kubernetes.io/component") in {
                "backend",
                "celery-voiceprint",
                "celery-beat",
            }:
                self.assertEqual(
                    "rotated",
                    row["spec"]["template"]["metadata"]["annotations"][
                        "meet.voiceprint/configuration-revision"
                    ],
                )

    def test_beat_reads_shared_credential_files_and_has_writable_schedule_directory(
        self,
    ):
        rows = self.deployments(
            *self.workers,
            "backend.envVars.DJANGO_SECRET_KEY_FILE=/run/voiceprint-backend/django-key",
        )
        beat = next(
            row
            for row in rows
            if row["metadata"]["labels"]["app.kubernetes.io/component"] == "celery-beat"
        )["spec"]["template"]["spec"]
        app = beat["containers"][0]
        self.assertEqual(10001, beat["securityContext"]["runAsUser"])
        self.assertTrue(app["securityContext"]["readOnlyRootFilesystem"])
        self.assertIn(
            {"name": "voiceprint-tmp", "mountPath": "/tmp"}, app["volumeMounts"]
        )
        self.assertTrue(
            next(m for m in app["volumeMounts"] if m["name"] == "voiceprint-private")[
                "readOnly"
            ]
        )
        self.assertIn("--schedule=/tmp/celerybeat-schedule", app["command"])
        self.assertFalse(
            any(c["name"] == "voiceprint-query-janitor" for c in beat["containers"])
        )
        self.assertIn(
            "shared credential files",
            render(
                *self.workers,
                "backend.envVars.DJANGO_SECRET_KEY_FILE=/unmounted/key",
                success=False,
            ),
        )

    def test_generic_backend_secret_volume_is_not_silently_replaced_with_empty_directory(
        self,
    ):
        rows = self.deployments(
            "backend.extraVolumes[0].name=private-test",
            "backend.extraVolumes[0].secret.secretName=fixture-generic",
        )
        pod = next(
            row
            for row in rows
            if row["metadata"]["labels"]["app.kubernetes.io/component"] == "backend"
        )["spec"]["template"]["spec"]
        volume = next(v for v in pod["volumes"] if v["name"] == "private-test")
        self.assertEqual({"secretName": "fixture-generic"}, volume["secret"])
        self.assertNotIn("emptyDir", volume)

    def test_runtime_rejects_overlapping_mounts_and_wrong_api_platform(self):
        for extra, reason in (
            (("backend.extraVolumes[0].name=voiceprint-private",), "volume names"),
            (
                (
                    "backend.extraVolumeMounts[0].name=voiceprint-private",
                    "backend.extraVolumeMounts[0].mountPath=/other",
                ),
                "volume names",
            ),
            (("backend.persistence.voiceprint-tmp.type=emptyDir",), "volume names"),
            (
                (
                    "backend.extraVolumeMounts[0].name=x",
                    "backend.extraVolumeMounts[0].mountPath=/tmp",
                ),
                "mount paths",
            ),
            (
                (
                    "mountFiles[0].path=/run/voiceprint-backend/keyring.json",
                    "mountFiles[0].content=fixture",
                ),
                "mount paths",
            ),
            (
                (
                    "backend.extraVolumeMounts[0].name=x",
                    "backend.extraVolumeMounts[0].mountPath=/run",
                ),
                "mount paths",
            ),
            (
                ("backend.sidecars[0].name=voiceprint-query-janitor",),
                "container name",
            ),
            (("backend.nodeSelector.kubernetes\\.io/arch=arm64",), "Linux amd64"),
            (
                (
                    "aiBackend.enabled=true",
                    "aiBackend.nodeSelector.kubernetes\\.io/os=windows",
                ),
                "Linux amd64",
            ),
            (("backend.securityContext.runAsUser=10001.5",), "UID/GID"),
        ):
            self.assertIn(reason, render(*self.settings, *extra, success=False))

    def test_all_pools_and_beat_reject_database_and_celery_drift(self):
        for target in ("aiBackend", "celeryBeat"):
            for key, value in (
                ("DB_PORT", "1234"),
                ("DB_USER", "different-fixture-user"),
                ("DATABASE_URL", "postgresql://other/fixture"),
                ("CELERY_TASK_ALWAYS_EAGER", "true"),
                ("CELERY_BROKER_URL", "redis://other/0"),
            ):
                self.assertIn(
                    "must share",
                    render(
                        *self.workers,
                        "aiBackend.enabled=true",
                        f"{target}.envVars.{key}={value}",
                        success=False,
                    ),
                )


if __name__ == "__main__":
    unittest.main()
