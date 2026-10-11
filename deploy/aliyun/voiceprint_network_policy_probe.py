"""Exercise a rendered encoder NetworkPolicy in uniquely owned namespaces.

Only synthetic TCP listeners are created. No real encoder, audio, credentials,
business endpoint, workload change, image pull, or database access is involved.
"""

import argparse
import hashlib
import json
import re
import subprocess
import time
from pathlib import Path


KUBECTL = ["/usr/local/bin/k3s", "kubectl"]
SERVER = """
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import time
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'synthetic-network-probe')
    def log_message(self, *args):
        pass
for port in (8093, 8094):
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
while True:
    time.sleep(1)
"""
CONNECT = """
import json, socket, sys
try:
    with socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=1.5):
        result = {'connected': True}
except (OSError, TimeoutError):
    result = {'connected': False}
print(json.dumps(result))
"""


def command(*args, body=None, timeout=30):
    result = subprocess.run(
        [*KUBECTL, *args],
        input=json.dumps(body) if body is not None else None,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"kubectl_failed:{result.stderr[:300]}")
    return result.stdout


def apply(body):
    command("apply", "-f", "-", body=body)


def pod(namespace, name, labels, image):
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"namespace": namespace, "name": name, "labels": labels},
        "spec": {
            "automountServiceAccountToken": False,
            "restartPolicy": "Never",
            "activeDeadlineSeconds": 240,
            "securityContext": {
                "runAsUser": 10001,
                "runAsGroup": 10001,
                "runAsNonRoot": True,
                "seccompProfile": {"type": "RuntimeDefault"},
            },
            "containers": [
                {
                    "name": "probe",
                    "image": image,
                    "imagePullPolicy": "Never",
                    "command": ["/usr/local/bin/python", "-c", SERVER],
                    "ports": [{"name": "https", "containerPort": 8093}],
                    "securityContext": {
                        "readOnlyRootFilesystem": True,
                        "allowPrivilegeEscalation": False,
                        "capabilities": {"drop": ["ALL"]},
                    },
                    "resources": {
                        "requests": {"cpu": "20m", "memory": "32Mi"},
                        "limits": {"cpu": "100m", "memory": "96Mi"},
                    },
                    "readinessProbe": {
                        "tcpSocket": {"port": 8093},
                        "periodSeconds": 1,
                    },
                }
            ],
        },
    }


def main(task):  # noqa: PLR0915 -- Keep mutation and cleanup in one ownership scope.
    identifier = task["task_id"]
    if not re.fullmatch(r"[0-9a-f]{12}", identifier):
        raise ValueError("invalid_task_id")
    namespace = "vp-network-probe-" + identifier
    outside = namespace + "-outside"
    policy = task["policy"]
    if (
        policy["kind"] != "NetworkPolicy"
        or policy["metadata"]["namespace"] != namespace
        or policy["spec"]["policyTypes"] != ["Ingress", "Egress"]
        or policy["spec"]["egress"] != []
    ):
        raise ValueError("invalid_rendered_policy")
    release = task["release"]
    selector = policy["spec"]["podSelector"]["matchLabels"]
    owner = {"app.kubernetes.io/managed-by": "codex", "voiceprint-test-id": identifier}
    result = {
        "status": "failed",
        "task_id": identifier,
        "namespaces": [namespace, outside],
        "scope": "synthetic_tcp_network_policy_only",
        "human_audio_used": False,
        "policy_sha256": hashlib.sha256(
            json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
        "checks": [],
        "cleanup": {},
    }
    created = []
    try:
        image = task["image_reference"]
        if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", image) and image != (
            "localhost/we-meet-voiceprint-bench:ecs-" + identifier
        ):
            raise ValueError("cached_image_digest_required")
        result["cached_image_reference"] = image
        for ns in (namespace, outside):
            # Refuse an existing name; never adopt someone else's namespace.
            existing = command(
                "get", "namespace", ns, "--ignore-not-found", "-o", "name"
            )
            if existing.strip():
                raise RuntimeError("namespace_already_exists")
            command(
                "create",
                "-f",
                "-",
                body={
                    "apiVersion": "v1",
                    "kind": "Namespace",
                    "metadata": {"name": ns, "labels": owner},
                },
            )
            created.append(ns)
            apply(
                {
                    "apiVersion": "v1",
                    "kind": "ResourceQuota",
                    "metadata": {"name": "probe-budget", "namespace": ns},
                    "spec": {
                        "hard": {
                            "pods": "2",
                            "requests.cpu": "40m",
                            "requests.memory": "64Mi",
                            "limits.cpu": "200m",
                            "limits.memory": "192Mi",
                        }
                    },
                }
            )
        caller_labels = {
            "app.kubernetes.io/instance": release,
            "app.kubernetes.io/component": "backend",
        }
        apply(pod(namespace, "receiver", selector, image))
        apply(pod(namespace, "caller", caller_labels, image))
        apply(pod(outside, "caller", caller_labels, image))
        service = task["service"]
        if (
            service["metadata"]["namespace"] != namespace
            or service["spec"]["selector"] != selector
            or service["spec"]["type"] != "ClusterIP"
            or service["spec"]["ports"]
            != [{"name": "https", "port": 8093, "targetPort": "https"}]
        ):
            raise ValueError("invalid_rendered_service")
        apply(service)
        for ns, name in (
            (namespace, "receiver"),
            (namespace, "caller"),
            (outside, "caller"),
        ):
            command(
                "wait",
                "-n",
                ns,
                "--for=condition=Ready",
                "pod/" + name,
                "--timeout=45s",
                timeout=50,
            )
        receiver = json.loads(
            command("get", "pod", "receiver", "-n", namespace, "-o", "json")
        )
        caller = json.loads(
            command("get", "pod", "caller", "-n", namespace, "-o", "json")
        )
        service_ip = json.loads(
            command(
                "get",
                "service",
                service["metadata"]["name"],
                "-n",
                namespace,
                "-o",
                "json",
            )
        )["spec"]["clusterIP"]
        result["runtime_image_id"] = receiver["status"]["containerStatuses"][0][
            "imageID"
        ]
        targets = {"pod": receiver["status"]["podIP"], "service": service_ip}
        time.sleep(2)

        def check(label, source_ns, source_pod, host, port, expected):
            outcomes = []
            for _ in range(3):
                response = command(
                    "exec",
                    "-n",
                    source_ns,
                    source_pod,
                    "--",
                    "/usr/local/bin/python",
                    "-c",
                    CONNECT,
                    host,
                    str(port),
                    timeout=8,
                )
                outcomes.append(json.loads(response)["connected"])
            result["checks"].append(
                {"case": label, "expected_connected": expected, "observed": outcomes}
            )
            if outcomes != [expected] * 3:
                raise RuntimeError("network_expectation_failed:" + label)

        for kind, host in targets.items():
            check(
                "baseline_same_namespace_" + kind, namespace, "caller", host, 8093, True
            )
            check(
                "baseline_other_namespace_" + kind, outside, "caller", host, 8093, True
            )
        check("baseline_other_port", namespace, "caller", targets["pod"], 8094, True)
        check(
            "baseline_receiver_egress",
            namespace,
            "receiver",
            caller["status"]["podIP"],
            8093,
            True,
        )
        apply(policy)
        time.sleep(2)
        actual = json.loads(
            command(
                "get",
                "networkpolicy",
                policy["metadata"]["name"],
                "-n",
                namespace,
                "-o",
                "json",
            )
        )
        actual["spec"].setdefault("egress", [])
        if actual["spec"] != policy["spec"]:
            raise RuntimeError("installed_policy_changed")
        for component in ("backend", "backend-ai", "celery-voiceprint"):
            command(
                "label",
                "pod",
                "caller",
                "-n",
                namespace,
                "app.kubernetes.io/component=" + component,
                "--overwrite",
            )
            time.sleep(2)
            for kind, host in targets.items():
                check(
                    "allowed_" + component + "_" + kind,
                    namespace,
                    "caller",
                    host,
                    8093,
                    True,
                )
        for kind, host in targets.items():
            check(
                "denied_other_namespace_" + kind, outside, "caller", host, 8093, False
            )
        check("denied_other_port", namespace, "caller", targets["pod"], 8094, False)
        check(
            "denied_receiver_egress",
            namespace,
            "receiver",
            caller["status"]["podIP"],
            8093,
            False,
        )
        for key, value, label in (
            ("app.kubernetes.io/component", "frontend", "wrong_component"),
            ("app.kubernetes.io/instance", release + "-other", "wrong_release"),
        ):
            command(
                "label",
                "pod",
                "caller",
                "-n",
                namespace,
                "app.kubernetes.io/component=backend",
                "app.kubernetes.io/instance=" + release,
                "--overwrite",
            )
            command(
                "label",
                "pod",
                "caller",
                "-n",
                namespace,
                key + "=" + value,
                "--overwrite",
            )
            time.sleep(2)
            for kind, host in targets.items():
                check(
                    "denied_" + label + "_" + kind,
                    namespace,
                    "caller",
                    host,
                    8093,
                    False,
                )
        command(
            "label",
            "pod",
            "caller",
            "-n",
            namespace,
            "app.kubernetes.io/component=backend",
            "app.kubernetes.io/instance=" + release,
            "--overwrite",
        )
        time.sleep(2)
        for kind, host in targets.items():
            check(
                "final_allowed_control_" + kind, namespace, "caller", host, 8093, True
            )
        result["status"] = "passed"
    except Exception as exc:  # noqa: BLE001 -- Preserve diagnostics and always clean owned namespaces.
        result["error"] = str(exc)[:400]
        for ns in created:
            try:
                result.setdefault("diagnostics", {})[ns] = command(
                    "get", "pods", "-n", ns, "-o", "wide"
                )
                result.setdefault("events", {})[ns] = command(
                    "get", "events", "-n", ns, "--sort-by=.metadata.creationTimestamp"
                )
            except Exception:
                pass
    finally:
        for ns in reversed(created):
            try:
                current = json.loads(command("get", "namespace", ns, "-o", "json"))
                if any(
                    current["metadata"].get("labels", {}).get(k) != v
                    for k, v in owner.items()
                ):
                    raise RuntimeError("namespace_ownership_changed")
                command(
                    "delete",
                    "namespace",
                    ns,
                    "--wait=true",
                    "--timeout=60s",
                    timeout=65,
                )
                result["cleanup"][ns] = not command(
                    "get", "namespace", ns, "--ignore-not-found", "-o", "name"
                ).strip()
            except Exception as exc:
                result["cleanup"][ns] = False
                result.setdefault("cleanup_errors", {})[ns] = str(exc)[:300]
        if len(created) != 2 or not all(result["cleanup"].values()):
            result["status"] = "failed"
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-file", type=Path, required=True)
    main(json.loads(parser.parse_args().task_file.read_text()))
