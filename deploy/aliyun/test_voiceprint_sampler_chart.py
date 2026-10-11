"""Render the actual sampler and shared backend credentials without a cluster."""

import unittest

from deploy.aliyun.test_voiceprint_encoder_chart import render
from deploy.aliyun import test_voiceprint_runtime_chart as runtime_chart

DIGEST = "registry.example.invalid/sampler@sha256:" + "c" * 64


class VoiceprintSamplerChartTest(unittest.TestCase):
    """The default stays off; enabled infrastructure stays private and bounded."""

    settings = runtime_chart.VoiceprintRuntimeChartTest.workers + (
        "voiceprintSampler.enabled=true",
        f"voiceprintSampler.imageReference={DIGEST}",
        "voiceprintSampler.credentialsSecret=fixture-sampler",
        "voiceprintSampler.livekitUrl=wss://rtc.invalid",
        "voiceprintSampler.networkPolicy.additionalEgress[0].to[0].ipBlock.cidr=192.0.2.10/32",
        "voiceprintSampler.networkPolicy.additionalEgress[0].ports[0].protocol=TCP",
        "voiceprintSampler.networkPolicy.additionalEgress[0].ports[0].port=443",
    )

    def resources(self, *extra):
        """Return only the isolated sampler resources from the complete release."""
        return {
            row["kind"]: row
            for row in render(*self.settings, *extra)
            if row["metadata"]["name"].endswith("voiceprint-sampler")
        }

    def test_default_creates_no_sampler_or_shared_sampling_credentials(self):
        """Adding the artifact cannot enable biometric collection."""
        rows = render()
        self.assertFalse(
            any("voiceprint-sampler" in row["metadata"]["name"] for row in rows)
        )
        for row in rows:
            for container in (
                row.get("spec", {})
                .get("template", {})
                .get("spec", {})
                .get("containers", [])
            ):
                self.assertFalse(
                    any(
                        item["name"].startswith("MEETING_VOICEPRINT_SAMPLING_AGENT")
                        for item in (container.get("env") or [])
                    )
                )

    def test_sampler_mounts_only_distinct_credentials_and_has_bounded_resources(self):
        """Keep private keys in files, SDK enumeration closed and pod budgets explicit."""
        rows = self.resources()
        spec = rows["Deployment"]["spec"]["template"]["spec"]
        container = spec["containers"][0]
        self.assertEqual(container["image"], DIGEST)
        self.assertEqual(
            container["command"],
            ["python", "-m", "entrypoints.voiceprint_sampler", "start"],
        )
        self.assertFalse(spec["automountServiceAccountToken"])
        self.assertEqual(spec["terminationGracePeriodSeconds"], 60)
        self.assertEqual(spec["securityContext"]["runAsUser"], 10001)
        self.assertEqual(spec["securityContext"]["runAsGroup"], 10001)
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(container["resources"]["limits"]["memory"], "768Mi")
        self.assertEqual(
            container["ports"], [{"name": "health", "containerPort": 8094}]
        )
        credentials = spec["volumes"][0]["secret"]
        self.assertEqual(credentials["secretName"], "fixture-sampler")
        self.assertEqual(credentials["defaultMode"], 0o440)
        self.assertEqual(
            {item["key"] for item in credentials["items"]},
            {"api-key", "api-secret", "sampling-token"},
        )
        values = {item["name"]: item.get("value") for item in container["env"]}
        self.assertEqual(values["MEETING_VOICEPRINT_ENABLED"], "false")
        self.assertEqual(values["MEETING_VOICEPRINT_SAMPLING_ENABLED"], "false")
        self.assertNotIn("AGENT_INTERNAL_API_TOKEN", values)
        for name in (
            "LIVEKIT_API_KEY",
            "LIVEKIT_API_SECRET",
            "MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN",
        ):
            self.assertNotIn(name, values)
            self.assertTrue(
                values[name + "_FILE"].startswith("/run/voiceprint-sampler/")
            )
        self.assertEqual(rows["Service"]["spec"]["type"], "ClusterIP")
        self.assertEqual(rows["NetworkPolicy"]["spec"]["ingress"], [])

    def test_api_ai_beat_and_all_consumers_share_one_sampling_secret(self):
        """All callers authenticate the same sampler without copying its key into values."""
        rows = render(*self.settings, "aiBackend.enabled=true")
        count = 0
        for row in rows:
            if row["kind"] != "Deployment":
                continue
            component = row["metadata"]["labels"].get("app.kubernetes.io/component")
            if component not in {
                "backend",
                "backend-ai",
                "celery-voiceprint",
                "celery-beat",
            }:
                continue
            container = next(
                item
                for item in row["spec"]["template"]["spec"]["containers"]
                if item["name"] != "voiceprint-query-janitor"
            )
            env = container["env"]
            token = next(
                item
                for item in env
                if item["name"] == "MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN"
            )
            self.assertEqual(
                token["valueFrom"],
                {"secretKeyRef": {"name": "fixture-sampler", "key": "sampling-token"}},
            )
            self.assertEqual(
                next(
                    item["value"]
                    for item in env
                    if item["name"] == "MEETING_VOICEPRINT_SAMPLING_AGENT_NAME"
                ),
                "meeting-voiceprint",
            )
            count += 1
        self.assertEqual(count, 6)

    def test_explicit_flags_are_shared_without_overriding_consent(self):
        """Sampling alone still leaves the total flag disabled."""
        rows = self.resources(
            "backend.envVars.MEETING_VOICEPRINT_SAMPLING_ENABLED=true"
        )
        values = {
            item["name"]: item.get("value")
            for item in rows["Deployment"]["spec"]["template"]["spec"]["containers"][0][
                "env"
            ]
        }
        self.assertEqual(values["MEETING_VOICEPRINT_ENABLED"], "false")
        self.assertEqual(values["MEETING_VOICEPRINT_SAMPLING_ENABLED"], "true")

    def test_invalid_deployment_fails_before_resources_are_created(self):
        """Reject prerequisites, mutable images, platform drift and unbounded capacity."""
        for setting, reason in (
            ("voiceprintWorkers.enabled=false", "voiceprintWorkers"),
            ("voiceprintRuntime.enabled=false", "voiceprintRuntime"),
            (
                "voiceprintSampler.imageReference=registry.invalid/sampler:latest",
                "sha256",
            ),
            ("voiceprintSampler.credentialsSecret=fixture-private", "separate"),
            ("voiceprintSampler.agentName=private name", "agentName"),
            ("voiceprintSampler.maxRooms=9", "maxRooms"),
            ("voiceprintSampler.replicas=0", "replicas"),
            ("voiceprintSampler.jobMemoryMb=127", "jobMemoryMb"),
            ("voiceprintSampler.jobMemoryMb=2049", "jobMemoryMb"),
            ("voiceprintSampler.nodeSelector.kubernetes\\.io/arch=arm64", "amd64"),
            ("voiceprintSampler.livekitUrl=wss://private-secret@rtc.invalid", "ws/wss"),
            (
                "voiceprintSampler.backendUrl=https://backend.invalid/private",
                "http/https",
            ),
            ("voiceprintSampler.backendCASecret=private-ca", "HTTPS"),
            ("backend.envVars.MEETING_VOICEPRINT_ENABLED=1", "literal"),
            (
                "backend.envVars.MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN=private-token",
                "Secret reference",
            ),
            (
                "backend.envVars.MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN_FILE=/private",
                "Secret reference",
            ),
            (
                "backend.envVars.MEETING_VOICEPRINT_SAMPLING_AGENT_NAME=wrong-worker",
                "agent name",
            ),
            (
                "aiBackend.envVars.MEETING_VOICEPRINT_SAMPLING_AGENT_NAME=wrong-worker",
                "settings",
            ),
        ):
            with self.subTest(setting=setting):
                self.assertIn(
                    reason,
                    render(
                        *self.settings, "aiBackend.enabled=true", setting, success=False
                    ),
                )

    def test_private_backend_ca_has_an_independent_read_only_mount(self):
        """Trust the operator CA through a file without disabling TLS verification."""
        rows = self.resources(
            "voiceprintSampler.backendUrl=https://backend.invalid",
            "voiceprintSampler.backendCASecret=fixture-ca",
        )
        spec = rows["Deployment"]["spec"]["template"]["spec"]
        ca = next(item for item in spec["volumes"] if item["name"] == "backend-ca")
        self.assertEqual(ca["secret"]["items"], [{"key": "ca.crt", "path": "ca.crt"}])
        self.assertEqual(ca["secret"]["defaultMode"], 0o440)
        mounts = spec["containers"][0]["volumeMounts"]
        self.assertTrue(
            next(item for item in mounts if item["name"] == "backend-ca")["readOnly"]
        )

    def test_capacity_changes_pod_memory_and_recreate_prevents_surge(self):
        """Declared per-child limits remain within the computed pod limit."""
        rows = self.resources(
            "voiceprintSampler.maxRooms=4",
            "voiceprintSampler.jobMemoryMb=512",
            "voiceprintSampler.replicas=2",
        )
        deployment = rows["Deployment"]["spec"]
        self.assertEqual(deployment["strategy"], {"type": "Recreate"})
        self.assertEqual(deployment["replicas"], 2)
        self.assertEqual(
            deployment["template"]["spec"]["containers"][0]["resources"]["limits"][
                "memory"
            ],
            "2560Mi",
        )

    def test_network_policy_limits_ingress_and_uses_explicit_livekit_egress(self):
        """Expose aggregate metrics only to selected peers, with no default internet route."""
        rows = self.resources(
            "voiceprintSampler.networkPolicy.additionalPeers[0].podSelector.matchLabels.app=metrics"
        )
        policy = rows["NetworkPolicy"]["spec"]
        self.assertEqual(
            policy["ingress"][0]["ports"], [{"protocol": "TCP", "port": 8094}]
        )
        self.assertEqual(
            policy["egress"][-1]["to"], [{"ipBlock": {"cidr": "192.0.2.10/32"}}]
        )
        self.assertEqual(
            policy["egress"][-1]["ports"], [{"protocol": "TCP", "port": 443}]
        )
        self.assertIn(
            "additionalEgress",
            render(
                *[item for item in self.settings if "additionalEgress" not in item],
                success=False,
            ),
        )
