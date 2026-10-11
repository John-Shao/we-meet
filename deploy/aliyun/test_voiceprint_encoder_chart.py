"""Render real Helm resources; never read cluster credentials or deploy anything."""

import pathlib
import re
import shutil
import subprocess
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
DIGEST = "registry.example.invalid/encoder@sha256:" + "a" * 64


def render(*settings, success=True):
    command = [shutil.which("helm"), "template", "meet", str(ROOT / "src/helm/meet")]
    for setting in settings:
        command += ["--set", setting]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if success:
        if result.returncode:
            raise AssertionError(result.stderr)
        return [row for row in yaml.safe_load_all(result.stdout) if row]
    if result.returncode == 0:
        raise AssertionError("Invalid deployment unexpectedly rendered")
    return result.stderr


class VoiceprintEncoderChartTest(unittest.TestCase):
    required = (
        "voiceprintEncoder.enabled=true",
        f"voiceprintEncoder.imageReference={DIGEST}",
        "voiceprintEncoder.credentialsSecret=fixture-encoder",
        "voiceprintEncoder.tlsSecret=fixture-tls",
        "voiceprintEncoder.modelClaim=fixture-qwen-pack",
    )

    def resources(self, *extra):
        return [
            row
            for row in render(*self.required, *extra)
            if row["metadata"]["name"].endswith("voiceprint-encoder")
        ]

    def test_default_does_not_create_encoder_or_enable_backend_collection(self):
        rows = render()
        self.assertFalse(
            any("voiceprint-encoder" in row["metadata"]["name"] for row in rows)
        )
        for row in rows:
            spec = row.get("spec", {}).get("template", {}).get("spec", {})
            for container in spec.get("containers", []):
                self.assertFalse(
                    any(
                        env["name"].startswith("MEETING_VOICEPRINT_")
                        for env in (container.get("env") or [])
                    )
                )

    def test_enabled_requires_an_immutable_image_and_separate_private_material(self):
        for index, expected in (
            (1, "imageReference"),
            (2, "credentialsSecret"),
            (3, "tlsSecret"),
            (4, "modelClaim"),
        ):
            settings = self.required[:index] + self.required[index + 1 :]
            self.assertIn(expected, render(*settings, success=False))
        self.assertIn(
            "sha256",
            render(
                *self.required,
                "voiceprintEncoder.imageReference=fixture/encoder:latest",
                success=False,
            ),
        )
        self.assertIn(
            "separate Secrets",
            render(
                *self.required,
                "voiceprintEncoder.tlsSecret=fixture-encoder",
                success=False,
            ),
        )

    def test_three_resources_are_private_and_use_the_pinned_model_contract(self):
        rows = self.resources()
        self.assertEqual(
            {"Deployment", "Service", "NetworkPolicy"}, {row["kind"] for row in rows}
        )
        service = next(row for row in rows if row["kind"] == "Service")
        self.assertEqual("ClusterIP", service["spec"]["type"])
        self.assertEqual(
            [{"name": "https", "port": 8093, "targetPort": "https"}],
            service["spec"]["ports"],
        )
        pod = next(row for row in rows if row["kind"] == "Deployment")["spec"][
            "template"
        ]["spec"]
        container = pod["containers"][0]
        self.assertEqual(DIGEST, container["image"])
        env = {item["name"]: item.get("value") for item in container["env"]}
        source = (ROOT / "src/voiceprint/voiceprint/spec.py").read_text(
            encoding="utf-8"
        )
        expected = re.search(
            r'^ENCODER_SHA256 = "([a-f0-9]{64})"', source, re.MULTILINE
        ).group(1)
        self.assertEqual(expected, env["VOICEPRINT_ENCODER_SHA256"])
        self.assertEqual("2", env["VOICEPRINT_CPU_THREADS"])
        self.assertFalse(
            any("TOKEN" in key and not key.endswith("_FILE") for key in env)
        )

    def test_pod_has_bounded_resources_no_privileges_and_only_read_only_private_mounts(
        self,
    ):
        deployment = next(
            row for row in self.resources() if row["kind"] == "Deployment"
        )
        self.assertEqual("Recreate", deployment["spec"]["strategy"]["type"])
        pod = deployment["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(
            {"kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64"},
            pod["nodeSelector"],
        )
        self.assertEqual(10001, pod["securityContext"]["runAsUser"])
        self.assertTrue(pod["securityContext"]["runAsNonRoot"])
        self.assertEqual(
            "RuntimeDefault", pod["securityContext"]["seccompProfile"]["type"]
        )
        container = pod["containers"][0]
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
        self.assertEqual(["ALL"], container["securityContext"]["capabilities"]["drop"])
        self.assertEqual({"cpu": 2, "memory": "2Gi"}, container["resources"]["limits"])
        self.assertTrue(
            all(
                mount["readOnly"]
                for mount in container["volumeMounts"]
                if mount["name"] != "temporary"
            )
        )
        volumes = {volume["name"]: volume for volume in pod["volumes"]}
        self.assertEqual(0o440, volumes["private-credentials"]["secret"]["defaultMode"])
        self.assertEqual(
            {"medium": "Memory", "sizeLimit": "64Mi"}, volumes["temporary"]["emptyDir"]
        )
        self.assertTrue(volumes["qwen-model"]["persistentVolumeClaim"]["readOnly"])

    def test_unverified_node_architectures_are_rejected(self):
        for selector in (
            "voiceprintEncoder.nodeSelector.kubernetes\\.io/arch=arm64",
            "voiceprintEncoder.nodeSelector.kubernetes\\.io/os=windows",
        ):
            self.assertIn(
                "Linux amd64", render(*self.required, selector, success=False)
            )

    def test_startup_readiness_and_liveness_are_distinct_https_checks(self):
        pod = next(row for row in self.resources() if row["kind"] == "Deployment")[
            "spec"
        ]["template"]["spec"]
        container = pod["containers"][0]
        for name, path in (
            ("startupProbe", "/health/ready"),
            ("readinessProbe", "/health/ready"),
            ("livenessProbe", "/health/live"),
        ):
            self.assertEqual(
                {"path": path, "port": "https", "scheme": "HTTPS"},
                container[name]["httpGet"],
            )
        self.assertGreaterEqual(
            container["startupProbe"]["periodSeconds"]
            * container["startupProbe"]["failureThreshold"],
            60,
        )

    def test_network_policy_denies_egress_and_limits_ingress_to_same_release_callers(
        self,
    ):
        policy = next(
            row for row in self.resources() if row["kind"] == "NetworkPolicy"
        )["spec"]
        self.assertEqual(["Ingress", "Egress"], policy["policyTypes"])
        self.assertEqual([], policy["egress"])
        rule = policy["ingress"][0]
        self.assertEqual([{"protocol": "TCP", "port": 8093}], rule["ports"])
        peer = rule["from"][0]["podSelector"]
        self.assertEqual("meet", peer["matchLabels"]["app.kubernetes.io/instance"])
        self.assertEqual(
            ["backend", "backend-ai", "celery-voiceprint"],
            peer["matchExpressions"][0]["values"],
        )

    def test_thread_and_replica_budgets_reject_zero_fractional_and_excessive_values(
        self,
    ):
        for key in ("cpuThreads", "replicas"):
            for value in ("0", "9", "2.5", "not-an-integer"):
                self.assertIn(
                    key,
                    render(
                        *self.required,
                        f"voiceprintEncoder.{key}={value}",
                        success=False,
                    ),
                )

    def test_configuration_rotation_and_model_subdirectory_are_explicit(self):
        deployment = next(
            row
            for row in self.resources(
                "voiceprintEncoder.configurationRevision=fixture-rotation",
                "voiceprintEncoder.modelSubPath=pack-v1",
            )
            if row["kind"] == "Deployment"
        )
        template = deployment["spec"]["template"]
        self.assertEqual(
            "fixture-rotation",
            template["metadata"]["annotations"][
                "meet.voiceprint/configuration-revision"
            ],
        )
        model = next(
            mount
            for mount in template["spec"]["containers"][0]["volumeMounts"]
            if mount["name"] == "qwen-model"
        )
        self.assertEqual("pack-v1", model["subPath"])

    def test_long_parent_name_keeps_distinct_legal_encoder_resource_names(self):
        rows = self.resources("fullnameOverride=" + "x" * 63)
        self.assertTrue(rows)
        self.assertTrue(all(len(row["metadata"]["name"]) <= 63 for row in rows))


if __name__ == "__main__":
    unittest.main()
