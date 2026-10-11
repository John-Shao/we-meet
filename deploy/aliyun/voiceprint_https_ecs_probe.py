"""Exercise the rendered encoder Deployment with ephemeral synthetic fixtures.

Requires a uniquely owned staging directory and preloaded image. Secrets are
read into memory and passed to kubectl stdin, never printed or put in argv.
"""

import argparse
import base64
import copy
import hashlib
import json
import re
import shutil
import time
from pathlib import Path

from voiceprint_network_policy_probe import apply, command


def secret(namespace, name, data, *, kind="Opaque"):
    apply(
        {
            "apiVersion": "v1",
            "kind": "Secret",
            "type": kind,
            "metadata": {"name": name, "namespace": namespace},
            "data": {
                key: base64.b64encode(value).decode() for key, value in data.items()
            },
        }
    )


def put_model(namespace, root):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        claim = json.loads(
            command("get", "pvc", "encoder-model", "-n", namespace, "-o", "json")
        )
        if claim.get("status", {}).get("phase") == "Bound":
            break
        time.sleep(1)
    else:
        raise RuntimeError("model_pvc_unbound")
    name = claim["spec"]["volumeName"]
    volume = json.loads(command("get", "pv", name, "-o", "json"))
    assert volume["spec"]["claimRef"]["uid"] == claim["metadata"]["uid"]
    assert volume["spec"]["claimRef"]["namespace"] == namespace
    destination = Path(
        volume["spec"].get("hostPath", volume["spec"].get("local", {}))["path"]
    ).resolve(strict=True)
    config = json.loads(
        command(
            "get", "configmap", "local-path-config", "-n", "kube-system", "-o", "json"
        )
    )
    roots = [
        Path(path).resolve(strict=True)
        for row in json.loads(config["data"]["config.json"])["nodePathMap"]
        for path in row["paths"]
    ]
    assert any(
        destination != path and destination.is_relative_to(path) for path in roots
    )
    assert (
        namespace in destination.name and claim["metadata"]["uid"] in destination.name
    )
    for filename in ("encoder.safetensors", "manifest.json"):
        target = destination / filename
        assert not target.exists()
        shutil.copyfile(root / "model" / filename, target)
        target.chmod(0o444)
    (destination / "ready").write_text("public-model-ready")
    (destination / "ready").chmod(0o444)
    return name


def client_pod(namespace, release, image):
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": "client",
            "namespace": namespace,
            "labels": {
                "app.kubernetes.io/instance": release,
                "app.kubernetes.io/component": "backend",
            },
        },
        "spec": {
            "automountServiceAccountToken": False,
            "restartPolicy": "Never",
            "activeDeadlineSeconds": 850,
            "terminationGracePeriodSeconds": 5,
            "securityContext": {
                "runAsUser": 10001,
                "runAsGroup": 10001,
                "runAsNonRoot": True,
                "fsGroup": 10001,
                "seccompProfile": {"type": "RuntimeDefault"},
            },
            "containers": [
                {
                    "name": "client",
                    "image": image,
                    "imagePullPolicy": "Never",
                    "command": [
                        "/opt/venv/bin/python",
                        "-c",
                        "import signal,sys,time; signal.signal(signal.SIGTERM,lambda *args:sys.exit(0)); time.sleep(800)",
                    ],
                    "securityContext": {
                        "allowPrivilegeEscalation": False,
                        "readOnlyRootFilesystem": True,
                        "capabilities": {"drop": ["ALL"]},
                    },
                    "resources": {
                        "requests": {"cpu": "50m", "memory": "128Mi"},
                        "limits": {"cpu": "250m", "memory": "256Mi"},
                    },
                    "volumeMounts": [
                        {"name": "code", "mountPath": "/probe", "readOnly": True},
                        {
                            "name": "private",
                            "mountPath": "/run/fixture",
                            "readOnly": True,
                        },
                    ],
                }
            ],
            "volumes": [
                {
                    "name": "private",
                    "secret": {"secretName": "client-private", "defaultMode": 0o440},
                },
                {
                    "name": "code",
                    "configMap": {
                        "name": "client-code",
                        "defaultMode": 0o444,
                        "items": [
                            {"key": "client.py", "path": "client.py"},
                            {
                                "key": "transport.py",
                                "path": "core/services/voiceprint_encoder.py",
                            },
                            {"key": "core-init", "path": "core/__init__.py"},
                            {
                                "key": "services-init",
                                "path": "core/services/__init__.py",
                            },
                        ],
                    },
                },
            ],
        },
    }


def main(task):  # noqa: PLR0915 -- One ownership scope covers setup, rotation and cleanup.
    identifier = task["task_id"]
    assert re.fullmatch(r"[0-9a-f]{12}", identifier)
    namespace = "vp-https-probe-" + identifier
    root = Path(task["stage_dir"]).resolve(strict=True)
    assert (
        root.parent == Path("/home/johnshao")
        and root.name == "vp-encoder-bench-" + identifier
    )
    assert json.loads((root / "owner.json").read_text()) == {"task_id": identifier}
    assert task["image"] == "localhost/we-meet-voiceprint-bench:ecs-" + identifier
    for resource in task["resources"]:
        assert resource["metadata"]["namespace"] == namespace
    owner = {"app.kubernetes.io/managed-by": "codex", "voiceprint-test-id": identifier}
    result = {
        "status": "failed",
        "task_id": identifier,
        "scope": "synthetic_private_https_only",
        "human_audio_used": False,
        "identity_accuracy_verified": False,
        "phases": [],
        "cleanup": {},
    }
    created = False
    pv = None
    stage = "namespace"
    try:
        assert not command(
            "get", "namespace", namespace, "--ignore-not-found", "-o", "name"
        ).strip()
        command(
            "create",
            "-f",
            "-",
            body={
                "apiVersion": "v1",
                "kind": "Namespace",
                "metadata": {"name": namespace, "labels": owner},
            },
        )
        created = True
        apply(
            {
                "apiVersion": "v1",
                "kind": "ResourceQuota",
                "metadata": {"name": "probe-budget", "namespace": namespace},
                "spec": {
                    "hard": {
                        "pods": "3",
                        "requests.cpu": "300m",
                        "requests.memory": "640Mi",
                        "limits.cpu": "2250m",
                        "limits.memory": "2304Mi",
                        "persistentvolumeclaims": "1",
                        "requests.storage": "1Gi",
                    }
                },
            }
        )
        stage = "private_fixtures"
        material = {
            phase: {
                name: (root / "fixture" / (phase + "-" + name)).read_bytes()
                for name in ("token", "key", "tls.crt", "tls.key", "ca.crt")
            }
            for phase in ("a", "b")
        }

        def install_private(phase):
            secret(
                namespace,
                "encoder-private",
                {
                    "api-token": material[phase]["token"],
                    "permit-key": material[phase]["key"],
                },
            )
            secret(
                namespace,
                "encoder-tls",
                {
                    "tls.crt": material[phase]["tls.crt"],
                    "tls.key": material[phase]["tls.key"],
                },
                kind="kubernetes.io/tls",
            )

        install_private("a")
        secret(
            namespace,
            "client-private",
            {
                phase + "-" + name: material[phase][name]
                for phase in ("a", "b")
                for name in ("token", "key", "ca.crt")
            },
        )
        source = (root / "voiceprint_https_client_probe.py").read_text()
        transport = (root / "voiceprint_encoder.py").read_text()
        assert (
            hashlib.sha256(source.encode()).hexdigest() == task["client_source_sha256"]
        )
        assert (
            hashlib.sha256(transport.encode()).hexdigest()
            == task["backend_transport_sha256"]
        )
        apply(
            {
                "apiVersion": "v1",
                "kind": "ConfigMap",
                "metadata": {"name": "client-code", "namespace": namespace},
                "data": {
                    "client.py": source,
                    "transport.py": transport,
                    "core-init": "",
                    "services-init": "",
                },
            }
        )
        apply(
            {
                "apiVersion": "v1",
                "kind": "PersistentVolumeClaim",
                "metadata": {"name": "encoder-model", "namespace": namespace},
                "spec": {
                    "accessModes": ["ReadWriteOnce"],
                    "storageClassName": "local-path",
                    "resources": {"requests": {"storage": "1Gi"}},
                },
            }
        )
        deployment = copy.deepcopy(
            next(r for r in task["resources"] if r["kind"] == "Deployment")
        )
        name = deployment["metadata"]["name"]
        pod = deployment["spec"]["template"]["spec"]
        assert deployment["spec"]["strategy"] == {"type": "Recreate"}
        container = pod["containers"][0]
        assert container["resources"] == {
            "requests": {"cpu": "250m", "memory": "512Mi"},
            "limits": {"cpu": 2, "memory": "2Gi"},
        }
        container["image"] = task["image"]
        container["imagePullPolicy"] = "Never"
        pod["initContainers"] = [
            {
                "name": "wait-for-public-model",
                "image": task["image"],
                "imagePullPolicy": "Never",
                "command": [
                    "/usr/local/bin/python",
                    "-c",
                    "from pathlib import Path; import time;\nwhile not Path('/models/qwen/ready').exists(): time.sleep(0.2)",
                ],
                "resources": {
                    "requests": {"cpu": "50m", "memory": "32Mi"},
                    "limits": {"cpu": "50m", "memory": "64Mi"},
                },
                "securityContext": container["securityContext"],
                "volumeMounts": [
                    {
                        "name": "qwen-model",
                        "mountPath": "/models/qwen",
                        "readOnly": True,
                    }
                ],
            }
        ]
        for resource in task["resources"]:
            if resource["kind"] != "Deployment":
                apply(resource)
        stage = "deployment_server_dryrun"
        invalid = copy.deepcopy(deployment)
        invalid["spec"]["template"]["spec"]["activeDeadlineSeconds"] = 1
        try:
            command("apply", "--dry-run=server", "-f", "-", body=invalid)
        except RuntimeError as exc:
            assert "activeDeadlineSeconds" in str(exc)
            result["unsupported_deployment_deadline_rejected"] = True
        else:
            raise AssertionError("unsupported_deployment_deadline_accepted")
        command("apply", "--dry-run=server", "-f", "-", body=deployment)
        result["deployment_server_dryrun"] = True
        stage = "model_and_readiness"
        apply(deployment)
        pv = put_model(namespace, root)
        apply(client_pod(namespace, task["release"], task["image"]))
        # Only the own encoder and in-cluster DNS are reachable from the test caller.
        apply(
            {
                "apiVersion": "networking.k8s.io/v1",
                "kind": "NetworkPolicy",
                "metadata": {"name": "client-boundaries", "namespace": namespace},
                "spec": {
                    "podSelector": {
                        "matchLabels": {"app.kubernetes.io/component": "backend"}
                    },
                    "policyTypes": ["Ingress", "Egress"],
                    "ingress": [],
                    "egress": [
                        {
                            "to": [{"podSelector": deployment["spec"]["selector"]}],
                            "ports": [{"protocol": "TCP", "port": 8093}],
                        },
                        {
                            "to": [
                                {
                                    "namespaceSelector": {
                                        "matchLabels": {
                                            "kubernetes.io/metadata.name": "kube-system"
                                        }
                                    },
                                    "podSelector": {
                                        "matchLabels": {"k8s-app": "kube-dns"}
                                    },
                                }
                            ],
                            "ports": [
                                {"protocol": "UDP", "port": 53},
                                {"protocol": "TCP", "port": 53},
                            ],
                        },
                    ],
                },
            }
        )
        command(
            "rollout",
            "status",
            "deployment/" + name,
            "-n",
            namespace,
            "--timeout=100s",
            timeout=110,
        )
        command(
            "wait",
            "pod/client",
            "-n",
            namespace,
            "--for=condition=Ready",
            "--timeout=45s",
            timeout=50,
        )
        service = next(r for r in task["resources"] if r["kind"] == "Service")
        ip = json.loads(
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
        ids = []
        for phase in ("a", "b"):
            stage = "phase_" + phase
            if phase == "b":
                install_private("b")
                deployment["spec"]["template"]["metadata"]["annotations"][
                    "meet.voiceprint/configuration-revision"
                ] = "rotated-b"
                apply(deployment)
                command(
                    "rollout",
                    "status",
                    "deployment/" + name,
                    "-n",
                    namespace,
                    "--timeout=100s",
                    timeout=110,
                )
            output = command(
                "exec",
                "client",
                "-n",
                namespace,
                "--",
                "/opt/venv/bin/python",
                "/probe/client.py",
                "--phase",
                phase,
                "--base",
                "https://" + task["service_dns"] + ":8093",
                "--service-ip",
                ip,
                timeout=60,
            )
            report = json.loads(output)
            result["phases"].append(report)
            assert (
                report["status"] == "passed"
                and report["backend_transport_sha256"]
                == task["backend_transport_sha256"]
            )
            selector = ",".join(
                key + "=" + value
                for key, value in deployment["spec"]["selector"]["matchLabels"].items()
            )
            pods = json.loads(
                command("get", "pods", "-n", namespace, "-l", selector, "-o", "json")
            )["items"]
            ready = [
                p
                for p in pods
                if any(
                    c["type"] == "Ready" and c["status"] == "True"
                    for c in p["status"].get("conditions", [])
                )
            ]
            assert len(ready) == 1
            encoder_pod = ready[0]
            ids.append(encoder_pod["metadata"]["uid"])
            filesystem = json.loads(
                command(
                    "exec",
                    encoder_pod["metadata"]["name"],
                    "-n",
                    namespace,
                    "-c",
                    "voiceprint-encoder",
                    "--",
                    "/usr/local/bin/python",
                    "-c",
                    "import json,os,stat; from pathlib import Path; paths=['/run/voiceprint-private/api-token','/run/voiceprint-private/permit-key','/run/voiceprint-tls/tls.crt','/run/voiceprint-tls/tls.key']; print(json.dumps({'uid':os.getuid(),'model_read_only':bool(os.statvfs('/models/qwen').f_flag & os.ST_RDONLY),'secret_read_only':bool(os.statvfs('/run/voiceprint-private').f_flag & os.ST_RDONLY),'secret_permissions':[{'mode':stat.S_IMODE(Path(p).stat().st_mode),'gid':Path(p).stat().st_gid} for p in paths]}))",
                )
            )
            assert (
                filesystem["uid"] == 10001
                and filesystem["model_read_only"]
                and filesystem["secret_read_only"]
            )
            assert all(
                p["mode"] == 0o440 and p["gid"] == 10001
                for p in filesystem["secret_permissions"]
            )
            result.setdefault("server_snapshots", []).append(
                {
                    "phase": phase,
                    "pod_uid": ids[-1],
                    "node": encoder_pod["spec"]["nodeName"],
                    "image_id": encoder_pod["status"]["containerStatuses"][0][
                        "imageID"
                    ],
                    "security": encoder_pod["spec"]["securityContext"],
                    "resources": encoder_pod["spec"]["containers"][0]["resources"],
                    "filesystem": filesystem,
                }
            )
        assert ids[0] != ids[1]
        result["recreate_rotation_verified"] = True
        result["status"] = "passed"
    except Exception as exc:  # noqa: BLE001 -- No exception message can expose Secret data.
        result["failed_stage"] = stage
        result["error_type"] = type(exc).__name__
        if stage in ("deployment_server_dryrun", "model_and_readiness"):
            result["public_deployment_error"] = str(exc)[:600]
        if created:
            result["pod_diagnostics"] = command(
                "get", "pods", "-n", namespace, "-o", "wide"
            )
    finally:
        if created:
            current = json.loads(command("get", "namespace", namespace, "-o", "json"))
            assert all(
                current["metadata"]["labels"].get(key) == value
                for key, value in owner.items()
            )
            command(
                "delete",
                "namespace",
                namespace,
                "--wait=true",
                "--timeout=60s",
                timeout=65,
            )
            result["cleanup"]["namespace_deleted"] = not command(
                "get", "namespace", namespace, "--ignore-not-found", "-o", "name"
            ).strip()
        if pv:
            deadline = time.monotonic() + 60
            while (
                time.monotonic() < deadline
                and command("get", "pv", pv, "--ignore-not-found", "-o", "name").strip()
            ):
                time.sleep(1)
            result["cleanup"]["owned_model_pv_deleted"] = not command(
                "get", "pv", pv, "--ignore-not-found", "-o", "name"
            ).strip()
        if not created or not all(result["cleanup"].values()):
            result["status"] = "failed"
    return result


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-file", type=Path, required=True)
    report = main(json.loads(parser.parse_args().task_file.read_text()))
    print(json.dumps(report), flush=True)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(cli())
