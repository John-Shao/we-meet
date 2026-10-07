"""Explicit, root-only K3s PID maintenance; requires separately authorized downtime.

Runs on the node, never restores a datastore or changes a business workload.
Receipts and backups may contain credentials: keep the root-private directory local.
"""

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import tarfile
import time
import uuid

TARGET = Path("/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/90-work-agent-pids.conf")
DB = Path("/var/lib/rancher/k3s/server/db/state.db")
BACKUPS = Path("/var/lib/we-meet-work-maintenance")
K = ["kubectl", "--kubeconfig=/etc/rancher/k3s/k3s.yaml", "--request-timeout=10s"]
IDENTITY = Path("/etc/rancher/k3s/config.yaml.d/90-work-maintenance-node-identity.yaml")
PAYLOAD = b'{\n  "apiVersion": "kubelet.config.k8s.io/v1beta1",\n  "kind": "KubeletConfiguration",\n  "podPidsLimit": 512\n}\n'


class MaintenanceError(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise MaintenanceError(code)


def run(argv, body=None, timeout=20):
    result = subprocess.run(argv, input=body, capture_output=True, timeout=timeout)
    require(result.returncode == 0, "command_failed:" + argv[0])
    return result.stdout


def api(*args, body=None):
    raw = run(K + list(args), body)
    require(len(raw) < 8_000_000, "api_response_too_large")
    return json.loads(raw)


def emit(event, **values):
    try:
        print(json.dumps({"event": event, **values}), flush=True)
    except BrokenPipeError:
        # The root-private receipt survives a disconnected SSH client.
        pass


def private_json(path, value):
    temp = path.with_suffix(".tmp")
    fd = os.open(temp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def sqlite_backup(source, destination):
    require(source.is_file() and not source.is_symlink(), "unsafe_sqlite_source")
    fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    deadline = time.monotonic() + 60

    def progress(*_):
        require(time.monotonic() < deadline, "sqlite_backup_timeout")

    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as src:
        with closing(sqlite3.connect(destination)) as dst:
            src.backup(dst, pages=256, progress=progress)
            require(
                dst.execute("PRAGMA quick_check").fetchall() == [("ok",)],
                "backup_integrity_failed",
            )
    return destination.stat().st_size


def healthy(pod):
    states = pod.get("status", {}).get("containerStatuses", [])
    return (
        pod.get("status", {}).get("phase") == "Running"
        and not pod["metadata"].get("deletionTimestamp")
        and len(states) == len(pod["spec"]["containers"])
        and all(c.get("ready") for c in states)
        and any(
            c["type"] == "Ready" and c["status"] == "True"
            for c in pod["status"].get("conditions", [])
        )
    )


def service_pods(pods, excluded_uid=None):
    return [
        p
        for p in pods
        if p["status"].get("phase") not in ("Succeeded", "Failed")
        and p["metadata"]["uid"] != excluded_uid
        and not any(
            o["kind"] == "Job" for o in p["metadata"].get("ownerReferences", [])
        )
    ]


def node_state(name, uid):
    nodes = api("get", "nodes", "-o", "json")["items"]
    require(len(nodes) == 1, "single_node_required")
    node = nodes[0]
    require(
        node["metadata"]["name"] == name and node["metadata"]["uid"] == uid,
        "wrong_node",
    )
    conditions = {c["type"]: c["status"] for c in node["status"]["conditions"]}
    require(conditions.get("Ready") == "True", "node_not_ready")
    require(
        all(
            conditions.get(c) == "False"
            for c in ("MemoryPressure", "DiskPressure", "PIDPressure")
        ),
        "node_pressure",
    )
    cfg = api("get", "--raw=/api/v1/nodes/" + name + "/proxy/configz")
    return cfg["kubeletconfig"]["podPidsLimit"]


def wait_health(name, uid, baseline, limit, timeout=180, excluded_uid=None):
    deadline = time.monotonic() + timeout
    while True:
        try:
            require(node_state(name, uid) == limit, "pid_configuration_mismatch")
            pods = service_pods(
                api("get", "pods", "--all-namespaces", "-o", "json")["items"],
                excluded_uid,
            )
            current = {p["metadata"]["uid"]: p for p in pods}
            require(
                all(puid in current and healthy(current[puid]) for puid in baseline),
                "baseline_pods_unready_or_replaced",
            )
            require(all(healthy(p) for p in pods), "service_pods_unready")
            return {
                "service_pods_ready": len(pods),
                "baseline_uids_preserved": len(baseline),
                "container_restarts": sum(
                    c.get("restartCount", 0)
                    for p in pods
                    for c in p["status"]["containerStatuses"]
                ),
            }
        except (MaintenanceError, subprocess.TimeoutExpired, ValueError, KeyError):
            if time.monotonic() >= deadline:
                raise MaintenanceError("health_verification_timeout") from None
            emit("waiting_for_health")
            time.sleep(5)


def remove_owned_target(path, expected_inode, expected_hash):
    require(
        not path.is_symlink() and path.is_file(), "rollback_target_missing_or_symlink"
    )
    require(path.stat().st_ino == expected_inode, "rollback_target_replaced")
    require(
        hashlib.sha256(path.read_bytes()).hexdigest() == expected_hash,
        "rollback_target_changed",
    )
    path.unlink()


def verify_restart_identity(node, service):
    hostname = run(["hostname"]).decode().strip().lower()
    if hostname == node:
        return
    # A changed OS hostname must not silently register a second Kubernetes node.
    # The explicit recovery pin is intentionally narrow; other layouts need review.
    require(
        IDENTITY.is_file()
        and not IDENTITY.is_symlink()
        and IDENTITY.read_text() == "node-name: " + node + "\n",
        "hostname_node_identity_drift",
    )
    require(
        not re.search(r"--(?:node-name|config)(?:=|\s)", service),
        "identity_argument_requires_review",
    )
    environment = run(
        ["systemctl", "show", "k3s", "-p", "Environment", "--value"]
    ).decode()
    require(
        not re.search(r"K3S_(?:NODE_NAME|CONFIG_FILE)=", environment),
        "identity_environment_requires_review",
    )
    paths = [
        Path("/etc/rancher/k3s/config.yaml"),
        Path("/etc/systemd/system/k3s.service.env"),
    ]
    paths += list(IDENTITY.parent.glob("*.yaml"))
    for path in paths:
        if path != IDENTITY and path.exists():
            require(
                not re.search(
                    r"(?m)^\s*(?:node-name\s*:|K3S_(?:NODE_NAME|CONFIG_FILE)\s*=)",
                    path.read_text(),
                ),
                "competing_node_identity_configuration",
            )


def delete_owned_pod(name, uid, owner):
    raw = run(K + ["get", "--raw=/api/v1/namespaces/meet/pods/" + name])
    pod = json.loads(raw)
    require(
        pod["metadata"]["uid"] == uid
        and pod["metadata"].get("labels", {}).get("work-maintenance-id") == owner,
        "pod_ownership_mismatch",
    )
    body = json.dumps(
        {
            "apiVersion": "v1",
            "kind": "DeleteOptions",
            "gracePeriodSeconds": 1,
            "preconditions": {"uid": uid},
        }
    ).encode()
    run(K + ["delete", "--raw=/api/v1/namespaces/meet/pods/" + name, "-f", "-"], body)
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        pods = api(
            "get",
            "pods",
            "-n",
            "meet",
            "-l",
            "work-maintenance-id=" + owner,
            "-o",
            "json",
        )["items"]
        if not pods:
            return
        require(
            all(p["metadata"]["uid"] == uid for p in pods), "pod_ownership_mismatch"
        )
        time.sleep(2)
    raise MaintenanceError("synthetic_cleanup_timeout")


def probe_pid(
    name, owner, image, receipt, receipt_path, expected_limit=512, pull_secrets=None
):
    pod_name = "work-agent-pid-check-" + owner[:12] + "-" + uuid.uuid4().hex[:8]
    pod = {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": pod_name,
            "namespace": "meet",
            "labels": {"work-maintenance-id": owner},
        },
        "spec": {
            "nodeName": name,
            "restartPolicy": "Never",
            "activeDeadlineSeconds": 120,
            "automountServiceAccountToken": False,
            "securityContext": {
                "runAsNonRoot": True,
                "runAsUser": 10001,
                "runAsGroup": 10001,
                "seccompProfile": {"type": "RuntimeDefault"},
            },
            "containers": [
                {
                    "name": "pid-check",
                    "image": image,
                    "imagePullPolicy": "IfNotPresent",
                    "command": ["python", "-c", "import time; time.sleep(90)"],
                    "securityContext": {
                        "readOnlyRootFilesystem": True,
                        "allowPrivilegeEscalation": False,
                        "capabilities": {"drop": ["ALL"]},
                    },
                    "resources": {
                        "requests": {"cpu": "10m", "memory": "32Mi"},
                        "limits": {"cpu": "100m", "memory": "64Mi"},
                    },
                }
            ],
        },
    }
    if pull_secrets:
        pod["spec"]["imagePullSecrets"] = pull_secrets
    receipt["synthetic_name"] = pod_name
    receipt["synthetic_deleted"] = False
    private_json(receipt_path, receipt)
    try:
        created = api("create", "-f", "-", "-o", "json", body=json.dumps(pod).encode())
    except (MaintenanceError, subprocess.TimeoutExpired):
        # Lost acknowledgement: read this fixed name, never repeat POST.
        created = api("get", "pod", pod_name, "-n", "meet", "-o", "json")
    require(
        created["metadata"].get("labels", {}).get("work-maintenance-id") == owner,
        "probe_ownership_mismatch",
    )
    pod_uid = created["metadata"]["uid"]
    require(re.fullmatch(r"[a-f0-9-]{36}", pod_uid), "invalid_pod_uid")
    receipt["synthetic_uid"] = pod_uid
    private_json(receipt_path, receipt)
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            running = api("get", "pod", pod_name, "-n", "meet", "-o", "json")
            require(running["metadata"]["uid"] == pod_uid, "probe_uid_changed")
            if running["status"].get("phase") == "Running":
                for path in Path("/sys/fs/cgroup").rglob("pids.max"):
                    if re.search(
                        r"pod"
                        + re.escape(pod_uid).replace(r"\-", "[-_]")
                        + r"(?:\.slice)?$",
                        path.parent.name,
                    ):
                        value = path.read_text().strip()
                        expected = (
                            "max" if expected_limit == -1 else str(expected_limit)
                        )
                        require(value == expected, "actual_pod_pid_limit_mismatch")
                        return {"pod_pids_max": value, "pod_uid": pod_uid}
            require(
                running["status"].get("phase") not in ("Failed", "Succeeded"),
                "probe_terminated",
            )
            time.sleep(2)
        raise MaintenanceError("probe_start_timeout")
    finally:
        delete_owned_pod(pod_name, pod_uid, owner)
        receipt["synthetic_deleted"] = True
        private_json(receipt_path, receipt)


def apply(args):
    require(os.name == "posix" and os.geteuid() == 0, "linux_root_required")
    import fcntl

    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    require(
        not BACKUPS.is_symlink()
        and BACKUPS.stat().st_uid == 0
        and BACKUPS.stat().st_mode & 0o077 == 0,
        "unsafe_backup_directory",
    )
    with (BACKUPS / "maintenance.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        return execute(args)


def execute(args):
    require(
        args.sha256 == hashlib.sha256(PAYLOAD).hexdigest(), "candidate_sha_mismatch"
    )
    require(
        re.fullmatch(r"[a-z0-9.-]+", args.node)
        and re.fullmatch(r"[a-f0-9-]{36}", args.node_uid),
        "invalid_node_identity",
    )
    require(
        re.fullmatch(r"[a-z0-9./_-]+@sha256:[a-f0-9]{64}", args.image),
        "immutable_probe_image_required",
    )
    require(
        TARGET.parent.is_dir() and not TARGET.exists() and not TARGET.is_symlink(),
        "target_exists_or_directory_missing",
    )
    require(all(not p.is_symlink() for p in TARGET.parents), "symlink_target_parent")
    require(not Path("/var/lib/rancher/k3s/server/db/etcd").exists(), "sqlite_only")
    service = run(["systemctl", "show", "k3s", "-p", "ExecStart", "--value"]).decode()
    verify_restart_identity(args.node, service)
    require(
        not re.search(r"pod-max-pids|config-dir|kubelet-arg[^;]*config=", service),
        "overriding_kubelet_arguments",
    )
    old_limit = node_state(args.node, args.node_uid)
    pods = api("get", "pods", "--all-namespaces", "-o", "json")["items"]
    baseline = service_pods(pods)
    require(bool(baseline) and all(healthy(p) for p in baseline), "baseline_unhealthy")
    require(
        any(
            c["image"] == args.image for p in baseline for c in p["spec"]["containers"]
        ),
        "probe_image_not_in_running_baseline",
    )
    image_source = next(
        p
        for p in baseline
        if any(c["image"] == args.image for c in p["spec"]["containers"])
    )
    pull_secrets = image_source["spec"].get("imagePullSecrets", [])
    pids = []
    for path in Path("/sys/fs/cgroup").rglob("pids.current"):
        if re.search(r"pod[a-f0-9_-]{36}(?:\.slice)?$", path.parent.name):
            try:
                pids.append(int(path.read_text()))
            except FileNotFoundError:
                pass
    require(bool(pids) and max(pids) < 384, "pod_process_snapshot_unsafe")
    require(
        DB.is_file()
        and shutil.disk_usage(BACKUPS).free > DB.stat().st_size * 3 + 256 * 1024 * 1024,
        "insufficient_backup_space",
    )
    owner = uuid.uuid4().hex
    backup = BACKUPS / ("pid-" + owner)
    backup.mkdir(mode=0o700)
    receipt_path = backup / "receipt.json"
    receipt = {
        "schema": "work-k3s-pid-maintenance/v1",
        "id": owner,
        "node": args.node,
        "node_uid": args.node_uid,
        "old_limit": old_limit,
        "target_limit": 512,
        "candidate_sha256": args.sha256,
        "baseline_uids": [p["metadata"]["uid"] for p in baseline],
        "baseline_pid_max": max(pids),
        "baseline_restart_count": sum(
            c.get("restartCount", 0)
            for p in baseline
            for c in p["status"]["containerStatuses"]
        ),
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "phase": "backing_up",
    }
    private_json(receipt_path, receipt)
    archive = backup / "configuration-and-token.tar"
    fd = os.open(archive, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    sources = [
        "/etc/rancher/k3s",
        "/etc/systemd/system/k3s.service",
        "/etc/systemd/system/k3s.service.env",
        "/etc/systemd/system/k3s.service.d",
        str(TARGET.parent),
        "/var/lib/rancher/k3s/server/token",
    ]
    receipt["restart_identity_pinned"] = IDENTITY.is_file()
    require(Path(sources[-1]).is_file(), "server_token_missing")
    with tarfile.open(archive, "w") as tar:
        for source in sources:
            if Path(source).exists():
                tar.add(source, arcname=source.lstrip("/"))
    with tarfile.open(archive, "r") as tar:
        require(
            "var/lib/rancher/k3s/server/token" in tar.getnames(), "token_backup_missing"
        )
    receipt["sqlite_backup_bytes"] = sqlite_backup(DB, backup / "state.db")
    receipt["backup_integrity"] = "ok"
    receipt["phase"] = "backed_up"
    private_json(receipt_path, receipt)
    emit(
        "backup_verified",
        directory=str(backup),
        sqlite_bytes=receipt["sqlite_backup_bytes"],
        baseline_services=len(baseline),
        baseline_pid_max=max(pids),
    )
    # Prove CRI cache/pull access before any configuration write or restart.
    receipt["probe_before_change"] = probe_pid(
        args.node,
        owner,
        args.image,
        receipt,
        receipt_path,
        expected_limit=old_limit,
        pull_secrets=pull_secrets,
    )
    private_json(receipt_path, receipt)
    emit("probe_ready_before_change", **receipt["probe_before_change"])
    wait_health(
        args.node, args.node_uid, receipt["baseline_uids"], old_limit, timeout=30
    )
    inode = None
    try:
        fd = os.open(
            TARGET, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600
        )
        inode = os.fstat(fd).st_ino
        with os.fdopen(fd, "wb") as stream:
            stream.write(PAYLOAD)
            stream.flush()
            os.fsync(stream.fileno())
        require(
            hashlib.sha256(TARGET.read_bytes()).hexdigest() == args.sha256,
            "installed_hash_mismatch",
        )
        receipt.update(phase="restarting", target_inode=inode)
        private_json(receipt_path, receipt)
        emit("restarting_k3s")
        run(["systemctl", "restart", "k3s"], timeout=120)
        receipt["health_after_restart"] = wait_health(
            args.node, args.node_uid, receipt["baseline_uids"], 512
        )
        emit("business_health_restored", **receipt["health_after_restart"])
        receipt["probe"] = probe_pid(
            args.node,
            owner,
            args.image,
            receipt,
            receipt_path,
            pull_secrets=pull_secrets,
        )
        receipt["final_health"] = wait_health(
            args.node, args.node_uid, receipt["baseline_uids"], 512
        )
        receipt["phase"] = "verified"
        private_json(receipt_path, receipt)
        emit(
            "verified",
            directory=str(backup),
            pod_pids_limit=512,
            **receipt["probe"],
            **receipt["final_health"],
        )
    except BaseException as error:
        receipt["failure"] = (
            str(error) if isinstance(error, MaintenanceError) else type(error).__name__
        )
        if inode is not None:
            try:
                remove_owned_target(TARGET, inode, args.sha256)
                run(["systemctl", "restart", "k3s"], timeout=120)
                receipt["rollback_health"] = wait_health(
                    args.node,
                    args.node_uid,
                    receipt["baseline_uids"],
                    old_limit,
                    excluded_uid=receipt.get("synthetic_uid"),
                )
                receipt["phase"] = "rolled_back"
                emit("rolled_back", pod_pids_limit=old_limit)
            except BaseException as rollback_error:
                receipt["phase"] = "manual_attention_required"
                receipt["rollback_error"] = (
                    str(rollback_error)
                    if isinstance(rollback_error, MaintenanceError)
                    else type(rollback_error).__name__
                )
                emit("manual_attention_required", directory=str(backup))
        private_json(receipt_path, receipt)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--node-uid", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    try:
        apply(args)
    except (MaintenanceError, OSError, subprocess.SubprocessError, ValueError) as error:
        emit(
            "failed",
            reason=str(error)
            if isinstance(error, MaintenanceError)
            else type(error).__name__,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
