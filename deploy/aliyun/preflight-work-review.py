"""Read-only Kubernetes prerequisites for a proposed Pi reviewer release."""

import argparse
import base64
import copy
import hmac
import importlib.util
import json
import os
import re
import ssl
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "check_work_agent", Path(__file__).with_name("check-work-agent.py")
)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class PreflightError(ValueError):
    """A public code, never a Kubernetes response or secret value."""


def dns_name(value, limit=253):
    return (
        isinstance(value, str)
        and len(value) <= limit
        and bool(re.fullmatch(r"[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?", value))
    )


class ClusterReader:
    def __init__(self, context, namespace):
        if (
            not context
            or context.startswith("-")
            or len(context) > 512
            or any(ord(c) < 32 for c in context)
        ):
            raise PreflightError("invalid_context")
        if not dns_name(namespace, 63) or "." in namespace:
            raise PreflightError("invalid_namespace")
        self.context = context
        self.namespace = namespace

    def get(self, resource, *arguments):
        if resource not in {"namespace", "nodes", "pods", "secret"}:
            raise PreflightError("unsupported_read")
        try:
            result = subprocess.run(
                [
                    "kubectl",
                    f"--context={self.context}",
                    f"--namespace={self.namespace}",
                    "--request-timeout=10s",
                    "get",
                    resource,
                    *arguments,
                    "--output=json",
                ],
                capture_output=True,
                timeout=15,
                check=False,
            )
            if result.returncode or len(result.stdout) > 4_000_000:
                raise PreflightError("cluster_read_failed")
            return json.loads(result.stdout)
        except (OSError, subprocess.TimeoutExpired, ValueError):
            raise PreflightError("cluster_read_failed") from None


def profile_agent(profile, namespace):
    try:
        agent = copy.deepcopy(profile["workAgent"])
        if agent.get("enabled") is not True or agent.get("engine") != "pi":
            raise PreflightError("reviewer_profile_required")
        secrets = agent["secrets"]
        if secrets.get("create") is not False:
            raise PreflightError("external_secrets_required")
        names = [
            secrets["gatewaySecret"],
            secrets["clientSecret"],
            agent["tls"]["existingSecret"],
        ]
        if secrets.get("providerSecret"):
            names.append(secrets["providerSecret"])
        if any(not dns_name(name) for name in names) or len(set(names)) != len(names):
            raise PreflightError("invalid_secret_references")
        if not dns_name(agent["runtime"]["nodeHostname"]):
            raise PreflightError("invalid_node_hostname")
        if (
            str(
                profile["backend"]["envVars"].get("WORK_REVIEW_ENABLED", "False")
            ).lower()
            != "true"
        ):
            raise PreflightError("proposed_review_client_required")
        checker.check_client(profile, namespace)
        checker.render_agent({"workAgent": agent}, namespace)
        agent["port"] = int(agent["port"])
        return agent
    except PreflightError:
        raise
    except Exception:
        raise PreflightError("invalid_reviewer_profile") from None


def check_node(nodes, agent):
    rows = nodes.get("items", [])
    if len(rows) != 1:
        raise PreflightError("dedicated_node_not_unique")
    node = rows[0]
    labels = node.get("metadata", {}).get("labels", {})
    if (
        labels.get("work-agent") != "dedicated"
        or labels.get("kubernetes.io/hostname") != agent["runtime"]["nodeHostname"]
    ):
        raise PreflightError("dedicated_node_labels_missing")
    conditions = {
        item["type"]: item["status"]
        for item in node.get("status", {}).get("conditions", [])
    }
    if (
        node.get("spec", {}).get("unschedulable")
        or conditions.get("Ready") != "True"
        or any(
            conditions.get(key) == "True"
            for key in (
                "MemoryPressure",
                "DiskPressure",
                "PIDPressure",
                "NetworkUnavailable",
            )
        )
    ):
        raise PreflightError("dedicated_node_unready")
    taints = node.get("spec", {}).get("taints", [])
    if {
        "key": "work-agent",
        "value": "dedicated",
        "effect": "NoSchedule",
    } not in taints:
        raise PreflightError("dedicated_node_taint_missing")
    tolerations = agent.get(
        "tolerations",
        [
            {
                "key": "work-agent",
                "operator": "Equal",
                "value": "dedicated",
                "effect": "NoSchedule",
            }
        ],
    )
    for taint in taints:
        if taint.get("effect") not in {"NoSchedule", "NoExecute"}:
            continue
        if not any(
            (not item.get("effect") or item["effect"] == taint["effect"])
            and (
                item.get("key") == taint["key"]
                or not item.get("key")
                and item.get("operator") == "Exists"
            )
            and (
                item.get("operator", "Equal") == "Exists"
                or item.get("value", "") == taint.get("value", "")
            )
            for item in tolerations
        ):
            raise PreflightError("dedicated_node_untolerated_taint")
    name = node.get("metadata", {}).get("name")
    if not dns_name(name):
        raise PreflightError("invalid_node_identity")
    return name


def check_workloads(pods, agent, namespace):
    for pod in pods.get("items", []):
        if pod.get("status", {}).get("phase") in {"Succeeded", "Failed"}:
            continue
        metadata = pod.get("metadata", {})
        labels = metadata.get("labels", {})
        system_daemon = metadata.get("namespace") == "kube-system" and any(
            owner.get("kind") == "DaemonSet"
            for owner in metadata.get("ownerReferences", [])
        )
        if not system_daemon and not (
            metadata.get("namespace") == namespace
            and labels.get("app.kubernetes.io/name") == "work-agent"
            and labels.get("app.kubernetes.io/component") == "gateway"
        ):
            raise PreflightError("dedicated_node_shared_with_other_workloads")
        same_gateway = not system_daemon and any(
            owner.get("kind") == "ReplicaSet"
            and owner.get("name", "").rsplit("-", 1)[0] == agent["fullname"]
            for owner in metadata.get("ownerReferences", [])
        )
        if same_gateway:
            continue
        pod_spec = pod.get("spec", {})
        for container in pod_spec.get("containers", []):
            for port in container.get("ports", []):
                if port.get("protocol", "TCP") != "TCP":
                    continue
                if (
                    port.get("hostPort") == agent["port"]
                    or pod_spec.get("hostNetwork")
                    and port.get("containerPort") == agent["port"]
                ):
                    raise PreflightError("gateway_host_port_conflict")
        if any(
            volume.get("hostPath", {}).get("path") == agent["runtime"]["stateDirectory"]
            for volume in pod_spec.get("volumes", [])
        ):
            raise PreflightError("gateway_state_directory_conflict")


def secret_value(secret, name, maximum=1_000_000):
    try:
        value = base64.b64decode(secret["data"][name], validate=True)
        if not value or len(value) > maximum:
            raise ValueError
        return value
    except (KeyError, ValueError, TypeError):
        raise PreflightError("secret_key_missing_or_invalid") from None


def check_credentials(secrets, agent):
    refs = agent["secrets"]
    gateway = secrets[refs["gatewaySecret"]]
    client = secrets[refs["clientSecret"]]
    token = secret_value(gateway, "WORK_AGENT_TOKEN", 4096)
    if (
        len(token) < 24
        or token.startswith(b"REPLACE_")
        or not hmac.compare_digest(
            token, secret_value(client, "WORK_AGENT_TOKEN", 4096)
        )
    ):
        raise PreflightError("gateway_client_token_mismatch")
    if set(client.get("data", {})) != {"WORK_AGENT_TOKEN"}:
        raise PreflightError("client_secret_not_scoped")
    provider_name = refs.get("providerSecret") or refs["gatewaySecret"]
    key = "DASHSCOPE_API_KEY" if agent["provider"] == "qwen" else "DEEPSEEK_API_KEY"
    provider = secret_value(secrets[provider_name], key, 4096)
    if not re.fullmatch(rb"sk-[A-Za-z0-9_-]{16,200}", provider):
        raise PreflightError("provider_key_missing_or_placeholder")
    allowed = (
        {"WORK_AGENT_TOKEN"}
        if refs.get("providerSecret")
        else {"WORK_AGENT_TOKEN", key}
    )
    if set(gateway.get("data", {})) != allowed:
        raise PreflightError("gateway_secret_not_scoped")


def check_tls(secret, hostname, scratch=None):
    """Verify actual chain, hostname and key using OpenSSL in memory, without network."""
    certificate = secret_value(secret, "tls.crt")
    private_key = secret_value(secret, "tls.key", 262144)
    ca = secret_value(secret, "ca.crt").decode("ascii")
    scratch = Path(scratch) if scratch else ROOT / ".work-acceptance"
    scratch.mkdir(parents=True, exist_ok=True)
    files = []
    try:
        for content in (certificate, private_key):
            with tempfile.NamedTemporaryFile(
                prefix=".review-preflight-", dir=scratch, delete=False
            ) as stream:
                path = Path(stream.name).resolve()
                if not path.is_relative_to(scratch.resolve()):
                    raise PreflightError("invalid_scratch_path")
                files.append(path)
                if os.name != "nt":
                    os.chmod(path, 0o600)
                stream.write(content)
        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.minimum_version = ssl.TLSVersion.TLSv1_2
        server_context.load_cert_chain(*files, password=lambda: "")
        client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        client_context.hostname_checks_common_name = False
        client_context.minimum_version = ssl.TLSVersion.TLSv1_2
        client_context.load_verify_locations(cadata=ca)
        client_in, client_out, server_in, server_out = (
            ssl.MemoryBIO() for _ in range(4)
        )
        client = client_context.wrap_bio(
            client_in, client_out, server_hostname=hostname
        )
        server = server_context.wrap_bio(server_in, server_out, server_side=True)
        complete = [False, False]
        for _ in range(32):
            for index, connection in enumerate((client, server)):
                if not complete[index]:
                    try:
                        connection.do_handshake()
                        complete[index] = True
                    except ssl.SSLWantReadError:
                        pass
            if client_out.pending:
                server_in.write(client_out.read())
            if server_out.pending:
                client_in.write(server_out.read())
            if all(complete):
                return client.getpeercert()["notAfter"]
        raise PreflightError("tls_validation_failed")
    except Exception:
        raise PreflightError("tls_validation_failed") from None
    finally:
        for path in files:
            path.unlink(missing_ok=True)


def preflight(profile, reader):
    report = {
        "schema": "work-review-preflight/v1",
        "scope": "kubernetes-prerequisites",
        "context": reader.context,
        "namespace": reader.namespace,
        "passed": False,
        "deployment_performed": False,
        "checks": [],
        "not_checked": [
            "node Docker daemon and pinned worker image",
            "node state directory and backup",
            "registry image availability",
            "provider account availability and model access",
            "post-deploy HTTPS health and synthetic task",
        ],
    }

    def check(name, action):
        try:
            value = action()
            report["checks"].append({"check": name, "passed": True})
            return value
        except PreflightError as error:
            report["checks"].append(
                {"check": name, "passed": False, "code": str(error)}
            )
        except Exception:
            report["checks"].append(
                {"check": name, "passed": False, "code": "prerequisite_check_failed"}
            )
        return None

    agent = check("profile", lambda: profile_agent(profile, reader.namespace))
    if agent is None:
        return report

    def namespace_check():
        ns = reader.get("namespace", reader.namespace)
        if ns.get("status", {}).get("phase") != "Active":
            raise PreflightError("namespace_unavailable")
        return True

    if not check("namespace", namespace_check):
        return report
    node = check(
        "dedicated_node",
        lambda: check_node(
            reader.get(
                "nodes",
                f"--selector=kubernetes.io/hostname={agent['runtime']['nodeHostname']}",
            ),
            agent,
        ),
    )
    if node:
        check(
            "node_workloads",
            lambda: check_workloads(
                reader.get(
                    "pods", "--all-namespaces", f"--field-selector=spec.nodeName={node}"
                ),
                agent,
                reader.namespace,
            ),
        )
    names = list(
        dict.fromkeys(
            [
                agent["secrets"]["gatewaySecret"],
                agent["secrets"]["clientSecret"],
                agent["tls"]["existingSecret"],
                agent["secrets"].get("providerSecret")
                or agent["secrets"]["gatewaySecret"],
            ]
        )
    )

    def read_secrets():
        rows = reader.get("secret", *names)
        result = {row["metadata"]["name"]: row for row in rows.get("items", [])}
        if set(result) != set(names):
            raise PreflightError("referenced_secret_missing")
        return result

    secrets = check("referenced_secrets", read_secrets)
    if secrets:
        check("credentials", lambda: check_credentials(secrets, agent))
        expiry = check(
            "tls",
            lambda: check_tls(
                secrets[agent["tls"]["existingSecret"]],
                f"{agent['fullname']}.{reader.namespace}.svc.cluster.local",
            ),
        )
        if expiry:
            report["tls_not_after"] = expiry
    report["passed"] = all(item["passed"] for item in report["checks"])
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--values-file", type=Path, required=True)
    parser.add_argument(
        "--report", type=Path, help="Optional private local JSON report"
    )
    args = parser.parse_args(argv)
    try:
        reader = ClusterReader(args.context, args.namespace)
        profile = yaml.safe_load(args.values_file.read_text("utf-8-sig"))
        report = preflight(profile, reader)
        encoded = json.dumps(report, indent=2) + "\n"
        if args.report:
            prepare_spec = importlib.util.spec_from_file_location(
                "prepare_work_agent", Path(__file__).with_name("prepare-work-agent.py")
            )
            prepare = importlib.util.module_from_spec(prepare_spec)
            prepare_spec.loader.exec_module(prepare)
            prepare.write_private(args.report, encoded)
        print(encoded, end="")
        return 0 if report["passed"] else 1
    except Exception:
        print(
            json.dumps(
                {
                    "passed": False,
                    "code": "preflight_failed",
                    "deployment_performed": False,
                }
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
