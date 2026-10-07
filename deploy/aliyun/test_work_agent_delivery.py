"""Offline chart/secret boundaries and real TLS transport; no model or cluster."""

import copy
import importlib.util
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import yaml
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src/backend"))
sys.path.insert(0, str(ROOT / "src/work-agent"))
from work.agent_client import AgentBoundaryError, AgentClient  # noqa: E402
from work_agent.config import Config  # noqa: E402
from work_agent.health import probe  # noqa: E402
from work_agent.server import Gateway  # noqa: E402


def helper(name):
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), Path(__file__).with_name(name + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = helper("prepare-work-agent")
checker = helper("check-work-agent")


def fixture_values():
    return {
        "workAgent": {
            "enabled": True,
            "image": {
                "repository": "fixture.invalid/gateway",
                "digest": "sha256:" + "a" * 64,
            },
            "runtime": {
                "dedicatedNodeAcknowledged": True,
                "nodeHostname": "offline-runner",
                "workerImage": "fixture.invalid/worker@sha256:" + "b" * 64,
            },
            "tls": {"existingSecret": "fixture-tls"},
            "secrets": {
                "create": True,
                "gatewaySecret": "meet-work-agent-gateway",
                "clientSecret": "meet-work-agent-client",
                "gatewayToken": "offline-gateway-token-only-123456",
                "deepseekApiKey": "sk-offline-production-fixture-123456",
            },
        },
        "backend": {"envVars": {"DB_PASSWORD": "business-only-canary"}},
    }


def render(values=None, chart="work-agent", *extra):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "fixture.yaml"
        path.write_text(json.dumps(values or {}), encoding="utf8")
        result = subprocess.run(
            [
                shutil.which("helm") or "helm",
                "template",
                "work-agent" if chart == "work-agent" else "meet",
                str(ROOT / "src/helm" / chart),
                "-n",
                "meet",
                "-f",
                str(path),
                *extra,
            ],
            capture_output=True,
            encoding="utf8",
        )
        rows = (
            [row for row in yaml.safe_load_all(result.stdout) if row]
            if result.returncode == 0
            else []
        )
        return result, rows


class AgentChartTests(unittest.TestCase):
    def test_reviewer_profile_and_client_pins_are_validated(self):
        profile = yaml.safe_load(
            (
                ROOT / "src/helm/env.d/aliyun-prod/values.work-review.yaml.dist"
            ).read_text()
        )
        filtered = checker.scoped_values(profile, fixture_values(), "workReview")
        self.assertEqual(
            filtered["workAgent"]["secrets"]["providerSecret"], "meet-ai-credentials"
        )
        self.assertNotIn("gatewayToken", filtered["workAgent"]["secrets"])
        self.assertEqual(
            filtered["workAgent"]["secrets"]["gatewaySecret"],
            "meet-work-review-gateway",
        )
        result, rows = render(profile)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(rows, [])
        agent = profile["workAgent"]
        agent["enabled"] = True
        env = profile["backend"]["envVars"]
        env["WORK_REVIEW_ENABLED"] = "True"
        for key in ("WORK_REVIEW_TOKEN", "WORK_REVIEW_CA_PEM"):
            env[key]["secretKeyRef"]["optional"] = False
        checker.check_client(profile, "meet")
        for key, value in (
            ("WORK_REVIEW_MODEL", "other-model"),
            ("WORK_REVIEW_URL", "https://other.invalid:8444"),
        ):
            changed = copy.deepcopy(profile)
            changed["backend"]["envVars"][key] = value
            with self.assertRaises(ValueError):
                checker.check_client(changed, "meet")
        env["WORK_REVIEW_TOKEN"]["secretKeyRef"]["optional"] = True
        with self.assertRaises(ValueError):
            checker.check_client(profile, "meet")

    def test_reviewer_reuses_existing_model_secret_without_copying_key(self):
        values = fixture_values()
        agent = values["workAgent"]
        agent.update(engine="pi", provider="qwen", model="qwen3.8-flash", port=8444)
        agent["secrets"].update(providerSecret="meet-ai-credentials", deepseekApiKey="")
        result, rows = render(values)
        self.assertEqual(result.returncode, 0, result.stderr)
        for secret in (row for row in rows if row["kind"] == "Secret"):
            self.assertNotEqual(secret["metadata"]["name"], "meet-ai-credentials")
            self.assertEqual(set(secret["stringData"]), {"WORK_AGENT_TOKEN"})
        pod = next(row for row in rows if row["kind"] == "Deployment")["spec"][
            "template"
        ]["spec"]
        env = {
            item["name"]: item["valueFrom"]["secretKeyRef"]
            for item in pod["containers"][0]["env"]
        }
        self.assertEqual(
            env["DASHSCOPE_API_KEY"],
            {"name": "meet-ai-credentials", "key": "DASHSCOPE_API_KEY"},
        )
        self.assertEqual(env["WORK_AGENT_TOKEN"]["name"], "meet-work-agent-gateway")
        agent["secrets"]["qwenApiKey"] = "sk-offline-unused-123456789012345"
        self.assertNotEqual(render(values)[0].returncode, 0)
        agent["secrets"]["qwenApiKey"] = ""
        for name in (
            "../invalid",
            agent["secrets"]["gatewaySecret"],
            agent["secrets"]["clientSecret"],
        ):
            agent["secrets"]["providerSecret"] = name
            self.assertNotEqual(render(values)[0].returncode, 0)

    def test_qwen_release_contains_only_qwen_gateway_credential(self):
        values = fixture_values()
        values["workAgent"].update(
            engine="pi",
            provider="qwen",
            model="qwen-plus",
            baseUrl="https://dashscope.aliyuncs.com/compatible-mode/v1",
            port=8444,
        )
        values["workAgent"]["secrets"]["qwenApiKey"] = (
            "sk-offline-qwen-fixture-123456789"
        )
        result, rows = render(values)
        self.assertEqual(result.returncode, 0, result.stderr)
        gateway = next(
            r
            for r in rows
            if r["kind"] == "Secret"
            and r["metadata"]["name"] == "meet-work-agent-gateway"
        )
        self.assertEqual(
            set(gateway["stringData"]), {"DASHSCOPE_API_KEY", "WORK_AGENT_TOKEN"}
        )
        self.assertNotIn("sk-offline-production-fixture", result.stdout)
        pod = next(r for r in rows if r["kind"] == "Deployment")["spec"]["template"][
            "spec"
        ]
        container = pod["containers"][0]
        self.assertEqual(
            {e["name"] for e in container["env"]},
            {"DASHSCOPE_API_KEY", "WORK_AGENT_TOKEN"},
        )
        self.assertEqual(
            container["args"][container["args"].index("--provider") + 1], "qwen"
        )
        self.assertEqual(
            container["args"][container["args"].index("--port") + 1], "8444"
        )
        self.assertEqual(container["ports"][0]["containerPort"], 8444)
        service = next(r for r in rows if r["kind"] == "Service")
        self.assertEqual(service["spec"]["ports"][0]["port"], 8444)
        probe = container["readinessProbe"]["exec"]["command"]
        self.assertEqual(probe[probe.index("--port") + 1], "8444")
        values["workAgent"]["engine"] = "dsh"
        self.assertNotEqual(render(values)[0].returncode, 0)

    def test_disabled_chart_creates_nothing_even_with_local_credentials(self):
        values = fixture_values()
        values["workAgent"]["enabled"] = False
        result, rows = render(values)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(rows, [])
        self.assertNotIn("offline-gateway-token", result.stdout)

    def test_separate_release_and_credentials_are_scoped(self):
        source = fixture_values()
        filtered = checker.scoped_values(source, source)
        self.assertNotIn("backend", filtered)
        result, rows = render(filtered)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("business-only-canary", result.stdout)
        secrets = {
            r["metadata"]["name"]: r["stringData"]
            for r in rows
            if r["kind"] == "Secret"
        }
        self.assertEqual(set(secrets["meet-work-agent-client"]), {"WORK_AGENT_TOKEN"})
        self.assertEqual(
            set(secrets["meet-work-agent-gateway"]),
            {"WORK_AGENT_TOKEN", "DEEPSEEK_API_KEY"},
        )
        self.assertEqual(
            secrets["meet-work-agent-client"]["WORK_AGENT_TOKEN"],
            secrets["meet-work-agent-gateway"]["WORK_AGENT_TOKEN"],
        )
        deployment = next(r for r in rows if r["kind"] == "Deployment")
        self.assertEqual(deployment["spec"]["replicas"], 1)
        self.assertEqual(deployment["spec"]["strategy"]["type"], "Recreate")
        pod = deployment["spec"]["template"]["spec"]
        self.assertEqual(
            pod["nodeSelector"],
            {"kubernetes.io/hostname": "offline-runner", "work-agent": "dedicated"},
        )
        self.assertTrue(pod["hostNetwork"])
        self.assertFalse(pod["automountServiceAccountToken"])
        container = pod["containers"][0]
        self.assertEqual(
            {e["name"] for e in container["env"]},
            {"DEEPSEEK_API_KEY", "WORK_AGENT_TOKEN"},
        )
        self.assertIn("--tls-cert", container["args"])
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        self.assertNotIn("livenessProbe", container)
        self.assertEqual(
            container["readinessProbe"]["exec"], container["startupProbe"]["exec"]
        )
        mounts = {m["name"]: m["mountPath"] for m in container["volumeMounts"]}
        state = next(v for v in pod["volumes"] if v["name"] == "state")
        self.assertEqual(state["hostPath"]["path"], mounts["state"])
        self.assertEqual(state["hostPath"]["type"], "Directory")
        self.assertEqual(
            next(r for r in rows if r["kind"] == "Service")["spec"]["type"], "ClusterIP"
        )

    def test_enabled_chart_rejects_missing_runtime_and_production_prerequisites(self):
        mutations = (
            ("runtime", "dedicatedNodeAcknowledged", False),
            ("runtime", "nodeHostname", "REPLACE_NODE"),
            ("runtime", "stateDirectory", "/"),
            ("runtime", "workerImage", "worker:latest"),
            ("image", "digest", "latest"),
            ("tls", "existingSecret", ""),
            ("secrets", "gatewayToken", "REPLACE_WORK_AGENT_RANDOM_TOKEN"),
            ("secrets", "deepseekApiKey", "REPLACE_PRODUCTION_DEEPSEEK_API_KEY"),
            ("secrets", "clientSecret", "meet-work-agent-gateway"),
        )
        for section, key, value in mutations:
            with self.subTest(section=section, key=key):
                data = fixture_values()
                data["workAgent"][section][key] = value
                result, _ = render(data)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(
                    data["workAgent"]["secrets"]["gatewayToken"], result.stderr
                )

    def test_external_secret_mode_generates_no_secret_and_rejects_literals(self):
        data = fixture_values()
        data["workAgent"]["secrets"].update(
            create=False, gatewayToken="", deepseekApiKey=""
        )
        result, rows = render(data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(r["kind"] == "Secret" for r in rows))
        data["workAgent"]["secrets"]["deepseekApiKey"] = (
            "sk-must-not-be-retained-in-external-mode"
        )
        self.assertNotEqual(render(data)[0].returncode, 0)

    def test_meet_release_receives_references_without_gateway_or_provider_key(self):
        profile = yaml.safe_load(
            (ROOT / "src/helm/env.d/aliyun-prod/values.work-agent.yaml.dist").read_text(
                encoding="utf8"
            )
        )
        result, rows = render(
            profile, "meet", "--set", "workWorker.enabled=true,celeryBeat.enabled=true"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("meet-backend", "meet-celery-work", "meet-celery-beat"):
            deployment = next(
                r
                for r in rows
                if r["kind"] == "Deployment" and r["metadata"]["name"] == name
            )
            env = {
                e["name"]: e
                for e in deployment["spec"]["template"]["spec"]["containers"][0]["env"]
            }
            self.assertNotIn("DEEPSEEK_API_KEY", env)
            self.assertEqual(env["WORK_AGENT_ENABLED"]["value"], "False")
            self.assertEqual(
                env["WORK_AGENT_TOKEN"]["valueFrom"]["secretKeyRef"]["name"],
                "meet-work-agent-client",
            )
            self.assertTrue(
                env["WORK_AGENT_CA_PEM"]["valueFrom"]["secretKeyRef"]["optional"]
            )
        self.assertFalse(any(r["metadata"]["name"] == "meet-work-agent" for r in rows))


class PreparationTests(unittest.TestCase):
    def test_business_only_export_does_not_depend_on_inactive_gateway_runtime(self):
        data = fixture_values()
        data["workAgent"]["runtime"]["nodeHostname"] = (
            "REPLACE_NODE_NOT_YET_PROVISIONED"
        )
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.yaml"
            target = Path(directory) / "business.yaml"
            source.write_text(json.dumps(data), encoding="utf8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "deploy/aliyun/check-work-agent.py"),
                    "--secrets-file",
                    str(source),
                    "--values-file",
                    str(source),
                    "--export-business-secrets",
                    str(target),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("workAgent", yaml.safe_load(target.read_text()))
            self.assertIn("independent agent release unchanged", result.stdout)

    def test_private_export_refuses_an_unignored_repository_path(self):
        target = ROOT / "docs/reviews/work-agent-private-export-should-not-exist.yaml"
        self.assertFalse(target.exists())
        with self.assertRaises(ValueError):
            prepare.write_private(target, "private-export-canary")
        self.assertFalse(target.exists())

    def test_exports_exclude_the_other_release_and_never_print_secrets(self):
        data = fixture_values()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.yaml"
            source.write_text(json.dumps(data), encoding="utf8")
            gateway = root / "agent.local.yaml"
            business = root / "business.local.yaml"
            overlay = root / "overlay.local.yaml"
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "deploy/aliyun/check-work-agent.py"),
                    "--secrets-file",
                    str(source),
                    "--values-file",
                    str(source),
                    "--export-values",
                    str(gateway),
                    "--export-business-secrets",
                    str(business),
                    "--export-business-overlay",
                    str(overlay),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            for canary in (
                "business-only-canary",
                data["workAgent"]["secrets"]["gatewayToken"],
                data["workAgent"]["secrets"]["deepseekApiKey"],
            ):
                self.assertNotIn(canary, result.stdout + result.stderr)
            self.assertEqual(set(yaml.safe_load(gateway.read_text())), {"workAgent"})
            self.assertNotIn("business-only-canary", gateway.read_text())
            for path in (business, overlay):
                self.assertNotIn("workAgent", yaml.safe_load(path.read_text()))
                self.assertNotIn(
                    data["workAgent"]["secrets"]["deepseekApiKey"], path.read_text()
                )

    def test_secrets_prepare_preserves_business_text_and_token_on_repeat(self):
        original = (
            "# comments must survive\nbackend:\n  envVars:\n"
            "    DB_PASSWORD: 'business-only-canary'\n"
        )
        once = prepare.prepare_secret_text(original)
        self.assertTrue(once.startswith(original))
        parsed = yaml.safe_load(once)
        self.assertGreaterEqual(len(parsed["workAgent"]["secrets"]["gatewayToken"]), 24)
        self.assertEqual(
            parsed["workAgent"]["secrets"]["deepseekApiKey"],
            "REPLACE_PRODUCTION_DEEPSEEK_API_KEY",
        )
        twice = prepare.prepare_secret_text(once)
        self.assertEqual(yaml.safe_load(once), yaml.safe_load(twice))
        self.assertEqual(
            yaml.safe_load(twice)["backend"], yaml.safe_load(original)["backend"]
        )

    def test_existing_external_secrets_are_not_generated(self):
        text = "workAgent:\n  secrets:\n    create: false\nbackend:\n  envVars: {}\n"
        self.assertEqual(prepare.prepare_secret_text(text), text)

    def test_prepare_keeps_rollout_flags_disabled_and_never_overwrites_existing_profile(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            secrets = Path(directory) / "secrets.yaml"
            values = Path(directory) / "values.yaml"
            prepare.prepare(secrets, values, "test-meet")
            config = yaml.safe_load(values.read_text())
            self.assertFalse(config["workAgent"]["enabled"])
            self.assertEqual(
                config["backend"]["envVars"]["WORK_AGENT_ENABLED"], "False"
            )
            self.assertIn(
                ".test-meet.svc.", config["backend"]["envVars"]["WORK_AGENT_URL"]
            )
            existing = values.read_bytes()
            prepare.prepare(secrets, values, "different-namespace")
            self.assertEqual(existing, values.read_bytes())

    def test_client_enable_requires_same_gateway_tls_and_non_optional_references(self):
        data = fixture_values()
        data["workAgent"]["fullname"] = "meet-work-agent"
        data["backend"]["envVars"] = {
            "WORK_AGENT_ENABLED": "True",
            "WORK_AGENT_URL": "https://meet-work-agent.meet.svc.cluster.local:8443",
            "WORK_AGENT_TOKEN": {
                "secretKeyRef": {
                    "name": "meet-work-agent-client",
                    "key": "WORK_AGENT_TOKEN",
                    "optional": False,
                }
            },
            "WORK_AGENT_CA_PEM": {
                "secretKeyRef": {
                    "name": "fixture-tls",
                    "key": "ca.crt",
                    "optional": False,
                }
            },
        }
        checker.check_client(data, "meet")
        wrong = copy.deepcopy(data)
        wrong["backend"]["envVars"]["WORK_AGENT_TOKEN"]["secretKeyRef"]["optional"] = (
            True
        )
        with self.assertRaises(ValueError):
            checker.check_client(wrong, "meet")
        wrong = copy.deepcopy(data)
        wrong["backend"]["envVars"]["DEEPSEEK_API_KEY"] = "provider-canary"
        with self.assertRaises(ValueError):
            checker.check_client(wrong, "meet")


def tls_fixture(directory):
    """Throwaway CA/certificate generated in the test directory, never committed."""
    now = datetime.now(timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "Offline Work Test CA")]
    )
    ca = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=None,
                decipher_only=None,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
        .issuer_name(ca_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    ca_pem = ca.public_bytes(serialization.Encoding.PEM).decode()
    (directory / "ca.crt").write_text(ca_pem, encoding="ascii")
    (directory / "tls.crt").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (directory / "tls.key").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return ca_pem


class TLSBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.proxy = patch.dict(
            os.environ,
            {"NO_PROXY": "localhost,127.0.0.1", "no_proxy": "localhost,127.0.0.1"},
        )
        self.proxy.start()
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.ca = tls_fixture(root)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(root / "tls.crt", root / "tls.key")
        self.token = "offline-tls-gateway-token-123456"
        self.gateway = Gateway(
            Config("fixture", root / "state", self.token, execution="fixture"),
            tls_context=context,
        )
        self.gateway.start()
        self.url = self.gateway.url.replace("127.0.0.1", "localhost")

    def tearDown(self):
        self.gateway.close()
        self.temp.cleanup()
        self.proxy.stop()

    def test_trusted_https_job_delivery_and_authenticated_readiness(self):
        client = AgentClient(self.url, self.token, ca_pem=self.ca)
        self.assertEqual(client.capabilities()["contract"], "work-agent/v1")
        import uuid

        run_id = str(uuid.uuid4())
        client.submit(run_id, "fixture", {"input.md": "offline TLS input"})
        for _ in range(100):
            job = client.get(run_id)
            if job["state"] == "succeeded":
                break
            time.sleep(0.05)
        self.assertEqual(job["state"], "succeeded")
        with patch.dict(os.environ, {"WORK_AGENT_TOKEN": self.token}):
            probe(
                "127.0.0.1",
                self.gateway.http.server_port,
                "localhost",
                str(Path(self.temp.name) / "ca.crt"),
            )

    def test_untrusted_ca_hostname_mismatch_and_wrong_token_fail_closed(self):
        for url, token, ca in (
            (self.url, self.token, ""),
            (self.gateway.url, self.token, self.ca),
            (self.url, "wrong", self.ca),
        ):
            with self.subTest(
                url=url, token_valid=token == self.token, ca_present=bool(ca)
            ):
                with self.assertRaises(AgentBoundaryError):
                    AgentClient(url, token, ca_pem=ca).capabilities()

    def test_idle_handshake_and_machine_proxy_do_not_block_private_gateway(self):
        with socket.create_connection(
            ("127.0.0.1", self.gateway.http.server_port), timeout=3
        ):
            with patch.dict(
                os.environ,
                {"HTTPS_PROXY": "http://127.0.0.1:1", "NO_PROXY": "", "no_proxy": ""},
            ):
                self.assertEqual(
                    AgentClient(
                        self.url, self.token, timeout=3, ca_pem=self.ca
                    ).capabilities()["contract"],
                    "work-agent/v1",
                )

    def test_cli_rejects_remote_plaintext_or_partial_tls_before_loading_secrets(self):
        with self.assertRaisesRegex(ValueError, "non-loopback listeners require TLS"):
            Gateway(self.gateway.config, host="0.0.0.0")
        script = ROOT / "src/work-agent/work_agent/server.py"
        for arguments in (
            ("--host", "0.0.0.0"),
            ("--tls-cert", "not-a-real-certificate"),
        ):
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "work_agent.server",
                    "--engine",
                    "fixture",
                    "--state-dir",
                    self.temp.name,
                    *arguments,
                ],
                cwd=script.parents[1],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("missing DEEPSEEK_API_KEY", result.stderr)


@unittest.skipUnless(
    os.environ.get("WORK_AGENT_GATEWAY_TEST_IMAGE"), "gateway image smoke opt-in"
)
class GatewayImageTests(unittest.TestCase):
    def test_read_only_image_https_probe_docker_cli_and_sigterm_shutdown(self):
        import uuid

        image = os.environ["WORK_AGENT_GATEWAY_TEST_IMAGE"]
        name = "work-agent-tls-fixture-" + str(uuid.uuid4())
        token = "offline-container-gateway-token-123456"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ca = tls_fixture(root)
            subprocess.run(
                [
                    "docker",
                    "run",
                    "-d",
                    "--name",
                    name,
                    "--read-only",
                    "--cap-drop=ALL",
                    "--security-opt=no-new-privileges",
                    "--mount",
                    f"type=bind,source={root},target=/tls,readonly",
                    "--tmpfs",
                    "/var/lib/we-meet-work-agent:rw,size=64m",
                    "--tmpfs",
                    "/tmp:rw,size=64m",
                    "-p",
                    "127.0.0.1::8443",
                    "-e",
                    f"WORK_AGENT_TOKEN={token}",
                    image,
                    "--engine",
                    "fixture",
                    "--state-dir",
                    "/var/lib/we-meet-work-agent",
                    "--host",
                    "0.0.0.0",
                    "--port",
                    "8443",
                    "--tls-cert",
                    "/tls/tls.crt",
                    "--tls-key",
                    "/tls/tls.key",
                ],
                check=True,
                capture_output=True,
                timeout=30,
            )
            try:
                mapping = subprocess.check_output(
                    ["docker", "port", name, "8443/tcp"], text=True
                ).strip()
                client = AgentClient(
                    f"https://localhost:{mapping.rsplit(':', 1)[1]}",
                    token,
                    timeout=2,
                    ca_pem=ca,
                )
                for _ in range(30):
                    try:
                        self.assertEqual(
                            client.capabilities()["contract"], "work-agent/v1"
                        )
                        break
                    except AgentBoundaryError:
                        time.sleep(0.2)
                else:
                    self.fail("gateway image did not become ready")
                subprocess.run(
                    [
                        "docker",
                        "exec",
                        name,
                        "python",
                        "-m",
                        "work_agent.health",
                        "--server-name",
                        "localhost",
                        "--ca-file",
                        "/tls/ca.crt",
                    ],
                    check=True,
                    capture_output=True,
                    timeout=10,
                )
                result = subprocess.check_output(
                    ["docker", "exec", name, "docker", "--version"], text=True
                )
                self.assertIn("28.5.1", result)
                run_id = str(uuid.uuid4())
                client.submit(
                    run_id, "fixture", {"input.md": "offline container HTTPS input"}
                )
                for _ in range(100):
                    job = client.get(run_id)
                    if job["state"] == "succeeded":
                        break
                    time.sleep(0.05)
                self.assertEqual(job["state"], "succeeded")
                subprocess.run(
                    ["docker", "stop", "--time", "5", name],
                    check=True,
                    capture_output=True,
                    timeout=15,
                )
                state = json.loads(
                    subprocess.check_output(
                        ["docker", "inspect", "--format", "{{json .State}}", name]
                    )
                )
                self.assertEqual(state["ExitCode"], 0)
                self.assertFalse(state["OOMKilled"])
            finally:
                subprocess.run(
                    ["docker", "rm", "-f", name], capture_output=True, timeout=15
                )


if __name__ == "__main__":
    unittest.main()
