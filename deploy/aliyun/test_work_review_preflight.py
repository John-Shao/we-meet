"""Real TLS validation and fake Kubernetes inventories; no deployment or models."""

import base64
import copy
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import yaml
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

spec = importlib.util.spec_from_file_location(
    "preflight", Path(__file__).with_name("preflight-work-review.py")
)
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)

NS = "review-test"
HOST = f"meet-work-review.{NS}.svc.cluster.local"
TOKEN = "offline-gateway-canary-token-123456"
PROVIDER = "sk-offline-provider-canary-123456"


def encoded(values):
    return {
        name: base64.b64encode(
            value if isinstance(value, bytes) else value.encode()
        ).decode()
        for name, value in values.items()
    }


def tls_values(host=HOST, expired=False, san=True):
    now = datetime.now(timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "Offline Preflight CA")]
    )
    ca = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=2))
        .not_valid_after(now + timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(True, False, False, False, False, True, True, None, None),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]))
        .issuer_name(ca_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(
            now - timedelta(minutes=1) if expired else now + timedelta(days=1)
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
    )
    if san:
        cert = cert.add_extension(
            x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False
        )
    cert = cert.sign(ca_key, hashes.SHA256())
    return {
        "data": encoded(
            {
                "tls.crt": cert.public_bytes(serialization.Encoding.PEM),
                "tls.key": key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                ),
                "ca.crt": ca.public_bytes(serialization.Encoding.PEM),
            }
        )
    }


def profile_values():
    profile = yaml.safe_load(
        (
            preflight.ROOT / "src/helm/env.d/aliyun-prod/values.work-review.yaml.dist"
        ).read_text("utf-8")
    )
    agent = profile["workAgent"]
    agent["enabled"] = True
    agent["image"] = {
        "repository": "fixture.invalid/gateway",
        "digest": "sha256:" + "a" * 64,
    }
    agent["runtime"].update(
        dedicatedNodeAcknowledged=True,
        nodeHostname="test-docker-node",
        workerImage="fixture.invalid/pi@sha256:" + "b" * 64,
    )
    env = profile["backend"]["envVars"]
    env["WORK_REVIEW_ENABLED"] = "True"
    env["WORK_REVIEW_URL"] = f"https://{HOST}:8444"
    env["WORK_REVIEW_TOKEN"]["secretKeyRef"]["optional"] = False
    env["WORK_REVIEW_CA_PEM"]["secretKeyRef"]["optional"] = False
    return profile


class Inventory:
    context = "explicit-test-context"
    namespace = NS

    def __init__(self):
        self.calls = []
        self.node = {
            "metadata": {
                "name": "test-docker-node",
                "labels": {
                    "kubernetes.io/hostname": "test-docker-node",
                    "work-agent": "dedicated",
                },
            },
            "spec": {
                "taints": [
                    {"key": "work-agent", "value": "dedicated", "effect": "NoSchedule"}
                ]
            },
            "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        }
        self.pods = []
        self.secrets = {
            "meet-work-review-gateway": {"data": encoded({"WORK_AGENT_TOKEN": TOKEN})},
            "meet-work-review-client": {"data": encoded({"WORK_AGENT_TOKEN": TOKEN})},
            "meet-ai-credentials": {"data": encoded({"DASHSCOPE_API_KEY": PROVIDER})},
            "meet-work-review-tls": tls_values(),
        }

    def get(self, resource, *args):
        self.calls.append((resource, args))
        if resource == "namespace":
            return {"status": {"phase": "Active"}}
        if resource == "nodes":
            return {"items": [self.node]}
        if resource == "pods":
            return {"items": self.pods}
        if resource == "secret":
            return {
                "items": [
                    {"metadata": {"name": name}, **value}
                    for name, value in self.secrets.items()
                    if name in args
                ]
            }
        raise AssertionError(resource)


class PreflightTests(unittest.TestCase):
    def test_real_tls_and_inventory_pass_without_exposing_credentials(self):
        reader = Inventory()
        report = preflight.preflight(profile_values(), reader)
        self.assertTrue(report["passed"], report)
        self.assertFalse(report["deployment_performed"])
        self.assertIn("tls_not_after", report)
        self.assertIn(
            "node Docker daemon and pinned worker image", report["not_checked"]
        )
        text = json.dumps(report)
        for canary in (
            TOKEN,
            PROVIDER,
            reader.secrets["meet-work-review-tls"]["data"]["tls.key"],
        ):
            self.assertNotIn(canary, text)
        self.assertEqual(
            {"namespace", "nodes", "pods", "secret"}, {row[0] for row in reader.calls}
        )

    def test_disabled_or_mismatched_profile_never_queries_cluster(self):
        for mutate in (
            lambda p: p["workAgent"].update(enabled=False),
            lambda p: p["backend"]["envVars"].update(
                WORK_REVIEW_URL="https://wrong.invalid"
            ),
            lambda p: p["workAgent"]["secrets"].update(create=True),
            lambda p: p["workAgent"]["secrets"].update(qwenApiKey=PROVIDER),
        ):
            reader = Inventory()
            profile = profile_values()
            mutate(profile)
            report = preflight.preflight(profile, reader)
            self.assertFalse(report["passed"])
            self.assertEqual([], reader.calls)
            self.assertNotIn(PROVIDER, json.dumps(report))

    def test_node_must_be_ready_isolated_and_schedulable(self):
        original = Inventory().node
        agent = profile_values()["workAgent"]
        for mutate in (
            lambda n: n["metadata"]["labels"].update({"work-agent": "business"}),
            lambda n: n["spec"].update(taints=[]),
            lambda n: n["spec"].update(unschedulable=True),
            lambda n: n["status"].update(
                conditions=[{"type": "Ready", "status": "False"}]
            ),
            lambda n: n["spec"]["taints"].append(
                {"key": "business", "effect": "NoSchedule"}
            ),
        ):
            node = copy.deepcopy(original)
            mutate(node)
            with self.assertRaises(preflight.PreflightError):
                preflight.check_node({"items": [node]}, agent)
        with self.assertRaises(preflight.PreflightError):
            preflight.check_node({"items": [original, original]}, agent)

    def test_business_pods_and_other_gateways_cannot_share_port_or_state(self):
        agent = profile_values()["workAgent"]
        system = {
            "metadata": {
                "namespace": "kube-system",
                "ownerReferences": [{"kind": "DaemonSet"}],
            }
        }
        own = {
            "metadata": {
                "namespace": NS,
                "labels": {
                    "app.kubernetes.io/name": "work-agent",
                    "app.kubernetes.io/component": "gateway",
                },
                "ownerReferences": [
                    {"kind": "ReplicaSet", "name": "meet-work-review-abcdef"}
                ],
            },
            "spec": {
                "hostNetwork": True,
                "containers": [{"ports": [{"containerPort": 8444}]}],
                "volumes": [{"hostPath": {"path": agent["runtime"]["stateDirectory"]}}],
            },
        }
        preflight.check_workloads({"items": [system, own]}, agent, NS)
        system_conflict = copy.deepcopy(system)
        system_conflict["spec"] = {
            "hostNetwork": True,
            "containers": [{"ports": [{"containerPort": 8444}]}],
        }
        with self.assertRaisesRegex(preflight.PreflightError, "host_port_conflict"):
            preflight.check_workloads({"items": [system_conflict]}, agent, NS)
        system_conflict["spec"]["containers"][0]["ports"][0]["protocol"] = "UDP"
        preflight.check_workloads({"items": [system_conflict]}, agent, NS)
        business = {
            "metadata": {"namespace": "meet", "name": "backend"},
            "status": {"phase": "Running"},
        }
        with self.assertRaisesRegex(preflight.PreflightError, "other_workloads"):
            preflight.check_workloads({"items": [business]}, agent, NS)
        other = copy.deepcopy(own)
        other["metadata"].update(
            name="meet-work-review-other-abcdef-pod",
            ownerReferences=[
                {"kind": "ReplicaSet", "name": "meet-work-review-other-abcdef"}
            ],
        )
        with self.assertRaisesRegex(preflight.PreflightError, "host_port_conflict"):
            preflight.check_workloads({"items": [other]}, agent, NS)
        other["spec"]["containers"][0]["ports"][0]["containerPort"] = 8443
        with self.assertRaisesRegex(
            preflight.PreflightError, "state_directory_conflict"
        ):
            preflight.check_workloads({"items": [other]}, agent, NS)

    def test_missing_mismatched_and_unscoped_secrets_block(self):
        original = Inventory().secrets
        agent = profile_values()["workAgent"]
        for mutate in (
            lambda s: s["meet-work-review-client"].update(
                data=encoded({"WORK_AGENT_TOKEN": "different-canary-token-123456"})
            ),
            lambda s: s["meet-work-review-client"]["data"].update(
                encoded({"DB_PASSWORD": "business-canary"})
            ),
            lambda s: s["meet-work-review-gateway"]["data"].update(
                encoded({"DASHSCOPE_API_KEY": PROVIDER})
            ),
            lambda s: s["meet-ai-credentials"].update(
                data=encoded({"DASHSCOPE_API_KEY": "REPLACE_PRODUCTION_KEY"})
            ),
            lambda s: s["meet-ai-credentials"].update(
                data=encoded({"DASHSCOPE_API_KEY": " " * 30})
            ),
        ):
            secrets = copy.deepcopy(original)
            mutate(secrets)
            with self.assertRaises(preflight.PreflightError):
                preflight.check_credentials(secrets, agent)
        reader = Inventory()
        reader.secrets.pop("meet-work-review-client")
        self.assertFalse(preflight.preflight(profile_values(), reader)["passed"])

    def test_actual_tls_rejects_wrong_ca_san_expiry_and_key_and_cleans_files(self):
        valid = tls_values()
        wrong_ca = copy.deepcopy(valid)
        wrong_ca["data"]["ca.crt"] = tls_values()["data"]["ca.crt"]
        wrong_key = copy.deepcopy(valid)
        wrong_key["data"]["tls.key"] = tls_values()["data"]["tls.key"]
        encrypted_key = copy.deepcopy(valid)
        key = serialization.load_pem_private_key(
            preflight.secret_value(valid, "tls.key"), password=None
        )
        encrypted_key["data"]["tls.key"] = encoded(
            {
                "tls.key": key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.BestAvailableEncryption(b"offline-only"),
                )
            }
        )["tls.key"]
        with tempfile.TemporaryDirectory() as directory:
            scratch = Path(directory).resolve()
            self.assertTrue(preflight.check_tls(valid, HOST, scratch))
            for secret in (
                wrong_ca,
                wrong_key,
                encrypted_key,
                tls_values(host="wrong.invalid"),
                tls_values(expired=True),
                tls_values(san=False),
            ):
                with self.assertRaisesRegex(
                    preflight.PreflightError, "tls_validation_failed"
                ):
                    preflight.check_tls(secret, HOST, scratch)
                self.assertEqual([], list(scratch.iterdir()))

    def test_kubectl_is_always_explicit_and_read_only_and_diagnostics_are_redacted(
        self,
    ):
        reader = preflight.ClusterReader("explicit-context", NS)
        with patch.object(
            preflight.subprocess,
            "run",
            return_value=subprocess.CompletedProcess([], 0, b'{"items":[]}', b""),
        ) as execute:
            reader.get("pods", "--all-namespaces")
            args = execute.call_args.args[0]
            self.assertIn("--context=explicit-context", args)
            self.assertIn(f"--namespace={NS}", args)
            self.assertEqual("get", args[4])
        with patch.object(
            preflight.subprocess,
            "run",
            return_value=subprocess.CompletedProcess([], 1, b"", PROVIDER.encode()),
        ):
            with self.assertRaisesRegex(
                preflight.PreflightError, "^cluster_read_failed$"
            ):
                reader.get("secret", "fixture")
        with self.assertRaises(preflight.PreflightError):
            reader.get("apply", "fixture")

    def test_cli_emits_only_report_and_refuses_unignored_report_destination(self):
        reader = Inventory()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            values = root / "values.yaml"
            values.write_text(yaml.safe_dump(profile_values()), encoding="utf-8")
            report = root / "report.json"
            output = io.StringIO()
            with (
                patch.object(preflight, "ClusterReader", return_value=reader),
                redirect_stdout(output),
            ):
                code = preflight.main(
                    [
                        "--context",
                        reader.context,
                        "--namespace",
                        NS,
                        "--values-file",
                        str(values),
                        "--report",
                        str(report),
                    ]
                )
            self.assertEqual(0, code, output.getvalue())
            self.assertTrue(json.loads(report.read_text())["passed"])
            self.assertNotIn(PROVIDER, output.getvalue())
            output = io.StringIO()
            unsafe = preflight.ROOT / "preflight-must-not-write.json"
            self.assertFalse(unsafe.exists())
            with (
                patch.object(preflight, "ClusterReader", return_value=reader),
                redirect_stdout(output),
            ):
                code = preflight.main(
                    [
                        "--context",
                        reader.context,
                        "--namespace",
                        NS,
                        "--values-file",
                        str(values),
                        "--report",
                        str(unsafe),
                    ]
                )
            self.assertEqual(1, code)
            self.assertFalse(unsafe.exists())
            self.assertNotIn(PROVIDER, output.getvalue())


if __name__ == "__main__":
    unittest.main()
