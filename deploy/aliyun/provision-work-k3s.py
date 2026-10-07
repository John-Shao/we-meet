"""Explicit first-install provisioning of the independent Work K3s Gateway.

Run as root on the reviewed node. Provider keys and private TLS never leave it.
The public bundle is base64 JSON containing the chart archive and scoped values.
"""

import argparse
import base64
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import tarfile
import time
from urllib.parse import urlsplit
import uuid

K = ["kubectl", "--kubeconfig=/etc/rancher/k3s/k3s.yaml", "--request-timeout=10s"]
ROOT = Path("/var/lib/we-meet-work-maintenance/gateway-release")
GATEWAY = "meet-work-review"
TASKS = "meet-work-review-tasks"
REGISTRY = "jusi-cn-guangzhou.cr.volces.com"
NODE_UID = "6c67a844-37f0-4eff-85fe-0420137b6f5f"
OWNER = "work-agent-release-id"


class ProvisionError(RuntimeError):
    pass


def require(value, code):
    if not value:
        raise ProvisionError(code)


def run(args, body=None, timeout=25):
    result = subprocess.run(args, input=body, capture_output=True, timeout=timeout)
    require(result.returncode == 0, "command_failed:" + args[0])
    return result.stdout


def api(*args, body=None):
    result = run(K + list(args), body)
    require(len(result) < 8_000_000, "response_too_large")
    return json.loads(result)


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def private_json(path, value):
    with path.open("w", encoding="utf8") as stream:
        json.dump(value, stream, indent=2)
    os.chmod(path, 0o600)


def scoped_registry(data):
    value = json.loads(base64.b64decode(data[".dockerconfigjson"]))
    matches = {}
    for name, entry in value.get("auths", {}).items():
        endpoint = urlsplit(name if "://" in name else "https://" + name)
        if (
            endpoint.hostname == REGISTRY
            and not endpoint.username
            and not endpoint.password
        ):
            require(isinstance(entry, dict) and bool(entry), "invalid_registry_entry")
            matches[name] = entry
    require(bool(matches), "registry_credential_missing")
    return {
        ".dockerconfigjson": base64.b64encode(
            json.dumps({"auths": matches}).encode()
        ).decode()
    }


def unpack_chart(data, directory):
    raw = base64.b64decode(data, validate=True)
    require(len(raw) < 1_000_000, "chart_too_large")
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        total = 0
        for member in archive.getmembers():
            path = Path(member.name)
            require(
                not path.is_absolute()
                and ".." not in path.parts
                and path.parts[0] == "work-agent-k8s",
                "unsafe_chart_path",
            )
            require(member.isfile() or member.isdir(), "unsafe_chart_member")
            total += member.size
            require(total < 2_000_000, "chart_too_large")
            target = directory / path
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())
                target.chmod(0o600)
    return directory / "work-agent-k8s"


def baseline():
    nodes = api("get", "nodes", "-o", "json")["items"]
    require(
        len(nodes) == 1 and nodes[0]["metadata"]["uid"] == NODE_UID,
        "node_identity_mismatch",
    )
    node = nodes[0]
    conditions = {c["type"]: c["status"] for c in node["status"]["conditions"]}
    require(
        conditions.get("Ready") == "True"
        and all(
            conditions.get(c) == "False"
            for c in ("MemoryPressure", "PIDPressure", "DiskPressure")
        ),
        "node_not_healthy",
    )
    cfg = api(
        "get", "--raw=/api/v1/nodes/" + node["metadata"]["name"] + "/proxy/configz"
    )
    require(cfg["kubeletconfig"]["podPidsLimit"] == 512, "pid_precondition_failed")
    pods = api("get", "pods", "--all-namespaces", "-o", "json")["items"]
    services = [
        p
        for p in pods
        if p["status"].get("phase") not in ("Succeeded", "Failed")
        and not any(
            o["kind"] == "Job" for o in p["metadata"].get("ownerReferences", [])
        )
    ]
    require(
        all(
            any(
                c["type"] == "Ready" and c["status"] == "True"
                for c in p["status"].get("conditions", [])
            )
            for p in services
        ),
        "business_baseline_unready",
    )
    used = 0
    for pod in pods:
        if pod["status"].get("phase") in ("Succeeded", "Failed"):
            continue
        for container in pod["spec"].get("containers", []) + pod["spec"].get(
            "initContainers", []
        ):
            value = container.get("resources", {}).get("requests", {}).get("cpu", "0")
            used += float(value[:-1]) if value.endswith("m") else float(value) * 1000
    return services, used


def create(resource, state):
    resource["metadata"].setdefault("labels", {})[OWNER] = state["id"]
    try:
        result = api(
            "create", "-f", "-", "-o", "json", body=json.dumps(resource).encode()
        )
    except (ProvisionError, subprocess.TimeoutExpired):
        metadata = resource["metadata"]
        args = ["get", resource["kind"], metadata["name"]]
        if metadata.get("namespace"):
            args += ["-n", metadata["namespace"]]
        result = api(*args, "-o", "json")
        require(
            result["metadata"].get("labels", {}).get(OWNER) == state["id"],
            "resource_creation_unknown",
        )
        # Lost acknowledgement can only adopt our exact credential payload.
        if resource["kind"] == "Secret":
            require(
                result.get("data") == resource.get("data"), "secret_creation_unknown"
            )
    require(
        result["metadata"].get("labels", {}).get(OWNER) == state["id"],
        "resource_ownership_mismatch",
    )
    state["resources"].append(
        {
            "kind": resource["kind"],
            "namespace": resource["metadata"].get("namespace", ""),
            "name": resource["metadata"]["name"],
            "uid": result["metadata"]["uid"],
        }
    )
    private_json(ROOT / "state.json", state)
    return result


def secret(name, namespace, data, state, type_="Opaque"):
    return create(
        {
            "apiVersion": "v1",
            "kind": "Secret",
            "type": type_,
            "metadata": {"name": name, "namespace": namespace},
            "data": data,
        },
        state,
    )


def encode(value):
    return base64.b64encode(value).decode()


def execute(bundle):
    require(os.name == "posix" and os.geteuid() == 0, "linux_root_required")
    require(
        not ROOT.exists() and not ROOT.is_symlink(), "existing_release_requires_review"
    )
    os.umask(0o077)
    require(all(not p.is_symlink() for p in ROOT.parents), "unsafe_state_parent")
    deadline = time.monotonic() + 100
    while True:
        services, used = baseline()
        if 4000 - used >= 200:
            break
        require(time.monotonic() < deadline, "cpu_requests_headroom_insufficient")
        emit("waiting_cpu_window", requests_m=used)
        time.sleep(5)
    namespaces = {
        n["metadata"]["name"] for n in api("get", "namespaces", "-o", "json")["items"]
    }
    require(not {GATEWAY, TASKS} & namespaces, "namespace_already_exists")
    agent = bundle["values"]["workAgent"]
    require(
        set(bundle["values"]) == {"workAgent"}
        and agent["fullname"] == GATEWAY
        and agent["tasks"]["namespace"] == TASKS
        and agent["businessNamespace"] == "meet"
        and agent["engine"] == "pi"
        and agent["provider"] == "qwen"
        and agent["model"] == "qwen3.8-flash"
        and agent["runtime"]["execution"] == "kubernetes"
        and not agent["secrets"]["create"],
        "invalid_scoped_bundle",
    )
    ROOT.mkdir(mode=0o700)
    state = {
        "schema": "work-k3s-gateway-provision/v1",
        "id": uuid.uuid4().hex,
        "phase": "preparing",
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "resources": [],
        "cpu_requests_before_m": used,
        "baseline": [
            {
                "uid": p["metadata"]["uid"],
                "name": p["metadata"]["name"],
                "namespace": p["metadata"]["namespace"],
                "restarts": sum(
                    c.get("restartCount", 0)
                    for c in p["status"].get("containerStatuses", [])
                ),
            }
            for p in services
        ],
    }
    private_json(ROOT / "state.json", state)
    chart = unpack_chart(bundle["chart_tar_gz_base64"], ROOT)
    try:
        for name in (GATEWAY, TASKS):
            labels = {OWNER: state["id"]}
            metadata = {"name": name, "labels": labels}
            if name == TASKS:
                labels.update(
                    {
                        "pod-security.kubernetes.io/enforce": "restricted",
                        "pod-security.kubernetes.io/enforce-version": "v1.30",
                        "app.kubernetes.io/managed-by": "Helm",
                    }
                )
                metadata["annotations"] = {
                    "meta.helm.sh/release-name": GATEWAY,
                    "meta.helm.sh/release-namespace": GATEWAY,
                }
            create(
                {"apiVersion": "v1", "kind": "Namespace", "metadata": metadata}, state
            )
        fqdn = GATEWAY + "." + GATEWAY + ".svc.cluster.local"
        run(
            [
                "openssl",
                "genpkey",
                "-algorithm",
                "EC",
                "-pkeyopt",
                "ec_paramgen_curve:P-256",
                "-out",
                str(ROOT / "ca.key"),
            ]
        )
        run(
            [
                "openssl",
                "req",
                "-x509",
                "-new",
                "-key",
                str(ROOT / "ca.key"),
                "-sha256",
                "-days",
                "1095",
                "-subj",
                "/CN=Work Gateway CA " + state["id"],
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-addext",
                "keyUsage=critical,keyCertSign,cRLSign",
                "-out",
                str(ROOT / "ca.crt"),
            ]
        )
        run(
            [
                "openssl",
                "genpkey",
                "-algorithm",
                "EC",
                "-pkeyopt",
                "ec_paramgen_curve:P-256",
                "-out",
                str(ROOT / "tls.key"),
            ]
        )
        run(
            [
                "openssl",
                "req",
                "-new",
                "-key",
                str(ROOT / "tls.key"),
                "-subj",
                "/CN=" + fqdn,
                "-out",
                str(ROOT / "tls.csr"),
            ]
        )
        (ROOT / "tls.ext").write_text(
            "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:"
            + fqdn
            + "\n"
        )
        run(
            [
                "openssl",
                "x509",
                "-req",
                "-in",
                str(ROOT / "tls.csr"),
                "-CA",
                str(ROOT / "ca.crt"),
                "-CAkey",
                str(ROOT / "ca.key"),
                "-CAcreateserial",
                "-days",
                "365",
                "-sha256",
                "-extfile",
                str(ROOT / "tls.ext"),
                "-out",
                str(ROOT / "tls.crt"),
            ]
        )
        run(
            [
                "openssl",
                "verify",
                "-CAfile",
                str(ROOT / "ca.crt"),
                "-verify_hostname",
                fqdn,
                str(ROOT / "tls.crt"),
            ]
        )
        ca = (ROOT / "ca.crt").read_bytes()
        secret(
            "meet-work-review-tls",
            GATEWAY,
            {
                k: encode((ROOT / k).read_bytes())
                for k in ("tls.crt", "tls.key", "ca.crt")
            },
            state,
        )
        token = secrets.token_urlsafe(48).encode()
        (ROOT / "gateway-token").write_bytes(token)
        secret(
            "meet-work-review-gateway-token",
            GATEWAY,
            {"WORK_AGENT_TOKEN": encode(token)},
            state,
        )
        provider = api(
            "get", "secret", "meet-ai-credentials", "-n", "meet", "-o", "json"
        )
        key = provider.get("data", {}).get("DASHSCOPE_API_KEY")
        require(
            isinstance(key, str) and bool(base64.b64decode(key)), "provider_key_missing"
        )
        secret("meet-work-review-provider", GATEWAY, {"DASHSCOPE_API_KEY": key}, state)
        del provider, key
        registry = api("get", "secret", "meet-dockerconfig", "-n", "meet", "-o", "json")
        registry_data = scoped_registry(registry["data"])
        for namespace in (GATEWAY, TASKS):
            secret(
                "work-agent-registry",
                namespace,
                registry_data,
                state,
                "kubernetes.io/dockerconfigjson",
            )
        del registry, registry_data
        secret(
            "meet-work-review-client",
            "meet",
            {"WORK_AGENT_TOKEN": encode(token)},
            state,
        )
        secret("meet-work-review-client-ca", "meet", {"ca.crt": encode(ca)}, state)
        del token
        agent["enabled"] = True
        agent["tasks"]["publicCA"] = ca.decode()
        private_json(ROOT / "values.json", bundle["values"])
        state["phase"] = "helm_installing"
        private_json(ROOT / "state.json", state)
        emit("credentials_and_tls_provisioned", release_id=state["id"])
        run(
            [
                "helm",
                "--kubeconfig=/etc/rancher/k3s/k3s.yaml",
                "upgrade",
                "--install",
                GATEWAY,
                str(chart),
                "-n",
                GATEWAY,
                "-f",
                str(ROOT / "values.json"),
                "--wait",
                "--timeout",
                "180s",
            ],
            timeout=195,
        )
        deployment = api("get", "deployment", GATEWAY, "-n", GATEWAY, "-o", "json")
        require(deployment["status"].get("readyReplicas") == 1, "gateway_not_ready")
        state.update(phase="ready", deployment_uid=deployment["metadata"]["uid"])
        private_json(ROOT / "state.json", state)
        emit("gateway_ready", deployment_uid=state["deployment_uid"])
        print("PUBLIC_RESULT_BEGIN")
        print(
            json.dumps(
                {
                    "release_id": state["id"],
                    "phase": state["phase"],
                    "deployment_uid": state["deployment_uid"],
                    "resource_count": len(state["resources"]),
                    "public_ca": ca.decode(),
                    "business_deployment_changed": False,
                },
                indent=2,
            )
        )
        print("PUBLIC_RESULT_END")
    except BaseException as error:
        state["phase"] = "provision_failed"
        state["failure"] = (
            str(error) if isinstance(error, ProvisionError) else type(error).__name__
        )
        private_json(ROOT / "state.json", state)
        emit("provision_failed", reason=state["failure"])
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", required=True)
    parser.add_argument("--bundle-base64", required=True)
    args = parser.parse_args()
    try:
        execute(json.loads(base64.b64decode(args.bundle_base64, validate=True)))
    except Exception as error:
        emit(
            "failed",
            reason=str(error)
            if isinstance(error, ProvisionError)
            else type(error).__name__,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
