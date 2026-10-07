"""Scoped, one-batch production acceptance: no business materials or enablement.

At most five synthetic requests, each with one supplier call and 4096 output
tokens. Persist request IDs before admission; never replay a lost POST.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

ROOT = Path("/var/lib/we-meet-work-maintenance/gateway-release")
GW = "meet-work-review"
TASKS = "meet-work-review-tasks"
FQDN = GW + "." + GW + ".svc.cluster.local"
K = ["kubectl", "--kubeconfig=/etc/rancher/k3s/k3s.yaml", "--request-timeout=10s"]
OWNER = "work-agent-release-id"


class AcceptanceError(RuntimeError):
    pass


def require(value, code):
    if not value:
        raise AcceptanceError(code)


def run(args, body=None, timeout=25):
    result = subprocess.run(args, input=body, capture_output=True, timeout=timeout)
    require(result.returncode == 0, "command_failed:" + args[0])
    return result.stdout


def api(*args, body=None):
    return json.loads(run(K + list(args), body))


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def save(report):
    temp = ROOT / "acceptance.tmp"
    with temp.open("w") as stream:
        json.dump(report, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, ROOT / "acceptance.json")


def pod(name, namespace, image, marker, client=False, task=False):
    labels = {OWNER: marker, "work-agent-acceptance": "true"}
    if task:
        labels["app.kubernetes.io/component"] = "agent-task"
    spec = {
        "restartPolicy": "Never",
        "automountServiceAccountToken": False,
        "activeDeadlineSeconds": 1200,
        "terminationGracePeriodSeconds": 1,
        "imagePullSecrets": [
            {
                "name": "work-agent-registry"
                if namespace == TASKS
                else "meet-dockerconfig"
            }
        ],
        "securityContext": {
            "runAsNonRoot": True,
            "runAsUser": 10001,
            "runAsGroup": 10001,
            "fsGroup": 10001,
            "seccompProfile": {"type": "RuntimeDefault"},
        },
        "containers": [
            {
                "name": "probe",
                "image": image,
                "imagePullPolicy": "IfNotPresent",
                "command": [
                    "python",
                    "-m",
                    "http.server",
                    "8080",
                    "--directory",
                    "/tmp",
                ],
                "securityContext": {
                    "readOnlyRootFilesystem": True,
                    "allowPrivilegeEscalation": False,
                    "capabilities": {"drop": ["ALL"]},
                },
                "resources": {
                    "requests": {
                        "cpu": "10m",
                        "memory": "32Mi",
                        "ephemeral-storage": "8Mi",
                    },
                    "limits": {
                        "cpu": "100m",
                        "memory": "64Mi",
                        "ephemeral-storage": "16Mi",
                    },
                },
                "volumeMounts": [
                    {"name": "ca", "mountPath": "/trust/ca", "readOnly": True}
                ],
            }
        ],
        "volumes": [
            {
                "name": "ca",
                ("configMap" if task else "secret"): {
                    ("name" if task else "secretName"): "work-agent-ca"
                    if task
                    else "meet-work-review-client-ca"
                },
            }
        ],
    }
    if client:
        spec["volumes"].append(
            {"name": "token", "secret": {"secretName": "meet-work-review-client"}}
        )
        spec["containers"][0]["volumeMounts"].append(
            {"name": "token", "mountPath": "/trust/token", "readOnly": True}
        )
    if task:
        spec["serviceAccountName"] = "work-agent-task"
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": name, "namespace": namespace, "labels": labels},
        "spec": spec,
    }


def create_probe(resource, marker):
    name = resource["metadata"]["name"]
    namespace = resource["metadata"]["namespace"]
    try:
        created = api(
            "create", "-f", "-", "-o", "json", body=json.dumps(resource).encode()
        )
    except (AcceptanceError, subprocess.TimeoutExpired):
        created = api("get", "pod", name, "-n", namespace, "-o", "json")
    require(
        created["metadata"].get("labels", {}).get(OWNER) == marker,
        "probe_creation_unknown",
    )
    return {"name": name, "namespace": namespace, "uid": created["metadata"]["uid"]}


def cleanup(item, marker):
    pod_ = api("get", "pod", item["name"], "-n", item["namespace"], "-o", "json")
    require(
        pod_["metadata"]["uid"] == item["uid"]
        and pod_["metadata"].get("labels", {}).get(OWNER) == marker,
        "cleanup_ownership_mismatch",
    )
    body = json.dumps(
        {
            "apiVersion": "v1",
            "kind": "DeleteOptions",
            "gracePeriodSeconds": 1,
            "preconditions": {"uid": item["uid"]},
        }
    ).encode()
    run(
        K
        + [
            "delete",
            "--raw=/api/v1/namespaces/" + item["namespace"] + "/pods/" + item["name"],
            "-f",
            "-",
        ],
        body,
    )


def wait_probe(item):
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        value = api("get", "pod", item["name"], "-n", item["namespace"], "-o", "json")
        require(value["metadata"]["uid"] == item["uid"], "probe_uid_changed")
        if value["status"].get("phase") == "Running" and all(
            c.get("ready") for c in value["status"].get("containerStatuses", [])
        ):
            return value
        require(
            value["status"].get("phase") not in ("Succeeded", "Failed"),
            "probe_terminated",
        )
        time.sleep(2)
    raise AcceptanceError("probe_ready_timeout")


def python(item, code):
    return run(
        K + ["exec", "-i", "-n", item["namespace"], item["name"], "--", "python", "-"],
        code.encode(),
    )


def call(client, method, path, body=None):
    # The bearer stays in the mounted Secret; never appears in host args or code.
    code = (
        """import json,ssl,urllib.request,urllib.error,pathlib
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile='/trust/ca/ca.crt')))
token=pathlib.Path('/trust/token/WORK_AGENT_TOKEN').read_text().strip()
"""
        + f"request=urllib.request.Request({('https://' + FQDN + ':8444' + path)!r},method={method!r},data={json.dumps(body).encode() if body is not None else None!r},headers={{'Authorization':'Bearer '+token,'Content-Type':'application/json'}})\n"
        + """try:
 with opener.open(request,timeout=6) as response: print(json.dumps({'status':response.status,'body':json.loads(response.read())}))
except urllib.error.HTTPError as error:
 print(json.dumps({'status':error.code,'body':json.loads(error.read())}))
"""
    )
    return json.loads(python(client, code))


def request(goal, text="", budget=False):
    files = (
        []
        if not text
        else [
            {
                "name": "result.md",
                "text": text,
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
            }
        ]
    )
    return {
        "contract": "work-agent/v1",
        "run_id": str(uuid.uuid4()),
        "operation": "review",
        "goal": goal,
        "files": files,
        "timeout_seconds": 120,
        "limits": {
            "max_model_calls": 1,
            "max_total_tokens": 1 if budget else 20000,
            "max_output_tokens": 1 if budget else 4096,
        },
    }


def submit(client, body):
    result = call(client, "POST", "/v1/jobs", body)
    require(result["status"] in (200, 202), "task_admission_failed")
    return body["run_id"]


def poll(client, run_id):
    deadline = time.monotonic() + 160
    while time.monotonic() < deadline:
        result = call(client, "GET", "/v1/jobs/" + run_id)
        require(result["status"] == 200, "task_poll_failed")
        value = result["body"]
        if value["state"] in ("succeeded", "failed", "cancelled"):
            return value
        time.sleep(2)
    raise AcceptanceError("task_poll_timeout")


def gateway_pod():
    values = api(
        "get", "pods", "-n", GW, "-l", "app.kubernetes.io/name=" + GW, "-o", "json"
    )["items"]
    require(
        len(values) == 1 and values[0]["status"].get("phase") == "Running",
        "gateway_not_running",
    )
    return {
        "name": values[0]["metadata"]["name"],
        "namespace": GW,
        "uid": values[0]["metadata"]["uid"],
    }


def pid_limit(uid):
    for path in Path("/sys/fs/cgroup").rglob("pids.max"):
        if re.search(
            r"pod" + re.escape(uid).replace(r"\-", "[-_]") + r"(?:\.slice)?$",
            path.parent.name,
        ):
            require(path.read_text().strip() == "512", "actual_pid_limit_mismatch")
            return 512
    raise AcceptanceError("actual_pid_limit_missing")


def business_health(state):
    values = api("get", "pods", "--all-namespaces", "-o", "json")["items"]
    current = {p["metadata"]["uid"]: p for p in values}
    for old in state["baseline"]:
        require(old["uid"] in current, "business_pod_replaced")
        pod_ = current[old["uid"]]
        require(
            any(
                c["type"] == "Ready" and c["status"] == "True"
                for c in pod_["status"].get("conditions", [])
            ),
            "business_unready",
        )
        require(
            sum(
                c.get("restartCount", 0)
                for c in pod_["status"].get("containerStatuses", [])
            )
            == old["restarts"],
            "business_restart_count_changed",
        )
    return {"preserved_pods": len(state["baseline"]), "restart_count_unchanged": True}


def execute():
    require(os.name == "posix" and os.geteuid() == 0, "linux_root_required")
    os.umask(0o077)
    state = json.loads((ROOT / "state.json").read_text())
    require(state["phase"] == "ready", "provision_not_ready")
    require(not (ROOT / "acceptance.json").exists(), "acceptance_already_started")
    marker = state["id"]
    values = json.loads((ROOT / "values.json").read_text())
    deployment = api("get", "deployment", GW, "-n", GW, "-o", "json")
    require(
        deployment["metadata"]["uid"] == state["deployment_uid"], "gateway_uid_changed"
    )
    report = {
        "schema": "work-k3s-production-acceptance/v1",
        "release_id": marker,
        "phase": "preflight",
        "supplier_call_ceiling": 5,
        "supplier_calls": 0,
        "samples": [],
        "probes": [],
        "business_before": business_health(state),
    }
    save(report)
    active = []
    admitted = []
    client = None
    try:
        for role, namespace, client_, task_ in (
            ("client", "meet", True, False),
            ("peer", "meet", False, False),
            ("network", TASKS, False, True),
        ):
            item = create_probe(
                pod(
                    "wa-" + role + "-" + marker[:8],
                    namespace,
                    values["workAgent"]["image"]["repository"]
                    + "@"
                    + values["workAgent"]["image"]["digest"],
                    marker,
                    client_,
                    task_,
                ),
                marker,
            )
            active.append(item)
            report["probes"].append(item)
            save(report)
            wait_probe(item)
            if role == "client":
                client = item
            elif role == "peer":
                peer = item
            else:
                network = item
        report["actual_probe_pids_max"] = pid_limit(network["uid"])
        caps = call(client, "GET", "/v1/capabilities")
        require(
            caps["status"] == 200
            and caps["body"]["engine"] == "pi"
            and caps["body"]["model"] == "qwen3.8-flash"
            and caps["body"]["runtime_version"] == "1.0.4"
            and caps["body"]["execution"] == "kubernetes",
            "capabilities_mismatch",
        )
        report["capabilities"] = caps["body"]
        client_ip = api("get", "pod", client["name"], "-n", "meet", "-o", "json")[
            "status"
        ]["podIP"]
        # Positive controls use a different business Pod and the same endpoints.
        positive = json.loads(
            python(
                peer,
                f"""import json,socket
targets=[({client_ip!r},8080),({FQDN!r},8444),('dashscope.aliyuncs.com',443)]
for host,port in targets: socket.create_connection((host,port),timeout=3).close()
print(json.dumps({{'business_peer_tcp_positive':True}}))
""",
            )
        )
        denied = json.loads(
            python(
                network,
                f"""import json,socket,ssl,urllib.request,urllib.error,pathlib
assert not pathlib.Path('/var/run/secrets/kubernetes.io/serviceaccount/token').exists()
opener=urllib.request.build_opener(urllib.request.ProxyHandler({{}}),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile='/trust/ca/ca.crt')))
try:opener.open(urllib.request.Request({("https://" + FQDN + ":8445/task/unknown/bootstrap")!r},method='POST',data=b'{{}}'),timeout=4)
except urllib.error.HTTPError as error:assert error.code==401
else:raise AssertionError('unauthorized broker accepted')
denied=[]
for host,port in [({client_ip!r},8080),({FQDN!r},8444),('dashscope.aliyuncs.com',443),('172.16.0.4',6443)]:
 try:socket.create_connection((host,port),timeout=2).close()
 except (TimeoutError,OSError):denied.append(port)
 else:raise AssertionError('forbidden connection allowed')
print(json.dumps({{'broker_tls':True,'broker_unauthorized':401,'blocked_ports':denied,'service_account_token':False}}))
""",
            )
        )
        report["network"] = {**positive, **denied}
        auth = []
        for verb, resource, namespace, sa, expected in (
            ("create", "pods", TASKS, "system:serviceaccount:" + GW + ":" + GW, "yes"),
            ("create", "pods", "meet", "system:serviceaccount:" + GW + ":" + GW, "no"),
            ("get", "secrets", GW, "system:serviceaccount:" + GW + ":" + GW, "no"),
            (
                "get",
                "secrets",
                TASKS,
                "system:serviceaccount:" + TASKS + ":work-agent-task",
                "no",
            ),
        ):
            result = subprocess.run(
                K + ["auth", "can-i", verb, resource, "-n", namespace, "--as=" + sa],
                capture_output=True,
                timeout=20,
            )
            require(result.stdout.decode().strip() == expected, "rbac_mismatch")
            auth.append(
                {
                    "verb": verb,
                    "resource": resource,
                    "namespace": namespace,
                    "allowed": expected == "yes",
                }
            )
        report["rbac"] = auth
        cleanup(network, marker)
        active.remove(network)
        emit("network_and_rbac_verified")
        save(report)
        body = request("Synthetic zero-supplier budget guard", budget=True)
        admitted.append(body["run_id"])
        report["zero_call_run_id"] = body["run_id"]
        save(report)
        submit(client, body)
        guard = poll(client, body["run_id"])
        require(
            guard["state"] == "failed"
            and guard.get("error_code") == "budget_exceeded"
            and guard["metering"]["calls"] == 0,
            "zero_supplier_guard_failed",
        )
        report["zero_supplier_guard"] = {
            "state": guard["state"],
            "error_code": guard["error_code"],
            "calls": guard["metering"]["calls"],
        }
        tombstone = request("Synthetic cancelled-before-admission proof", budget=True)
        cancellation = call(
            client, "POST", "/v1/jobs/" + tombstone["run_id"] + "/cancel", {}
        )
        require(cancellation["status"] == 200, "cancellation_failed")
        submit(client, tombstone)
        cancelled = poll(client, tombstone["run_id"])
        require(
            cancelled["state"] == "cancelled" and cancelled["metering"]["calls"] == 0,
            "cancellation_fence_failed",
        )
        report["cancelled_run_id"] = tombstone["run_id"]
        save(report)
        gateway = gateway_pod()
        report["backup"] = json.loads(
            python(
                gateway,
                """import json,sqlite3,shutil,hashlib
from contextlib import closing
from pathlib import Path
root=Path('/var/lib/we-meet-work-review');source=root/'jobs.sqlite3';backup=root/'acceptance-backup.db';restored=root/'acceptance-restored.db'
with closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)) as src:
 with closing(sqlite3.connect(backup)) as dst:src.backup(dst)
shutil.copyfile(backup,restored)
with closing(sqlite3.connect(restored)) as dst:
 assert dst.execute('PRAGMA quick_check').fetchall()==[('ok',)]
 assert dst.execute("SELECT COUNT(*) FROM jobs WHERE state IN ('running','queued')").fetchone()[0]==0
 jobs=dst.execute('SELECT COUNT(*) FROM jobs').fetchone()[0]
 calls=dst.execute('SELECT COUNT(*) FROM model_calls').fetchone()[0];assert calls==0
print(json.dumps({'restore_copy_quick_check':'ok','restored_jobs':jobs,'model_calls':calls,'backup_sha256':hashlib.sha256(backup.read_bytes()).hexdigest()}))
""",
            )
        )
        require(
            report["backup"]["restored_jobs"] >= 2, "state_backup_missing_tombstone"
        )
        run(K + ["rollout", "restart", "deployment/" + GW, "-n", GW])
        run(
            K + ["rollout", "status", "deployment/" + GW, "-n", GW, "--timeout=140s"],
            timeout=155,
        )
        persisted = poll(client, tombstone["run_id"])
        require(
            persisted["state"] == "cancelled" and persisted["metering"]["calls"] == 0,
            "pvc_restart_state_lost",
        )
        report["persistence"] = {
            "gateway_pod_uid_before": gateway["uid"],
            "gateway_pod_uid_after": gateway_pod()["uid"],
            "cancelled_tombstone_preserved": True,
            "supplier_calls_before_restart": 0,
        }
        emit("zero_supplier_chain_and_persistence_verified")
        save(report)
        samples = [
            (
                "clean",
                "检查文档内的算术是否正确。仅使用给定文件，无需外部材料。",
                "# 合计\n2 + 2 = 4。\n",
                "no_issues",
            ),
            (
                "contradiction",
                "检查文档内的算术是否正确。仅使用给定文件，无需外部材料。",
                "# 合计\n2 + 2 = 5。\n",
                "needs_changes",
            ),
            (
                "missing_evidence",
                "验收目标为100人并发。检查文件是否提供了完成该目标的实测证据。",
                "# 状态\n尚未进行并发测试。\n",
                "inconclusive",
            ),
        ]
        report["phase"] = "synthetic_models"
        for name, goal, text, expected in samples:
            require(len(report["samples"]) < 5, "synthetic_call_ceiling")
            body = request(goal, text)
            record = {
                "name": name,
                "run_id": body["run_id"],
                "expected_verdict": expected,
                "request_sha256": hashlib.sha256(
                    json.dumps(body, sort_keys=True).encode()
                ).hexdigest(),
                "limits": body["limits"],
                "state": "admitting",
            }
            report["samples"].append(record)
            save(report)
            admitted.append(body["run_id"])
            submit(client, body)
            job = poll(client, body["run_id"])
            record.update(
                state=job["state"],
                error_code=job.get("error_code"),
                metering=job["metering"],
            )
            report["supplier_calls"] += job["metering"]["calls"]
            require(report["supplier_calls"] <= 5, "supplier_call_ceiling")
            save(report)
            require(
                job["state"] == "succeeded",
                "synthetic_task_failed:" + str(job.get("error_code")),
            )
            require(
                job["metering"]["calls"] == 1 and job["metering"]["complete"],
                "synthetic_usage_unknown",
            )
            artifact = next(
                a for a in job["result"]["artifacts"] if a["name"] == "pi-review.json"
            )
            require(
                hashlib.sha256(artifact["text"].encode()).hexdigest()
                == artifact["sha256"],
                "artifact_checksum_mismatch",
            )
            parsed = json.loads(artifact["text"])
            record.update(
                verdict=parsed["verdict"],
                artifact_sha256=artifact["sha256"],
                usage=job["result"]["usage"],
            )
            require(parsed["verdict"] == expected, "synthetic_verdict_mismatch")
            save(report)
            emit(
                "synthetic_sample_verified",
                name=name,
                calls=job["metering"]["calls"],
                verdict=parsed["verdict"],
            )
        report["business_after"] = business_health(state)
        report["phase"] = "verified"
        save(report)
    except BaseException as error:
        report["phase"] = "failed"
        report["failure"] = (
            str(error) if isinstance(error, AcceptanceError) else type(error).__name__
        )
        for run_id in admitted:
            try:
                call(client, "POST", "/v1/jobs/" + run_id + "/cancel", {})
            except Exception:
                pass
        save(report)
        emit("acceptance_failed", reason=report["failure"])
        raise
    finally:
        for item in reversed(active):
            try:
                cleanup(item, marker)
            except Exception:
                report.setdefault("cleanup_pending", []).append(item)
        report["probe_cleanup_requested"] = True
        save(report)
        print("PUBLIC_RESULT_BEGIN")
        print(json.dumps(report, indent=2))
        print("PUBLIC_RESULT_END")


if __name__ == "__main__":
    try:
        execute()
    except Exception as error:
        emit(
            "failed",
            reason=str(error)
            if isinstance(error, AcceptanceError)
            else type(error).__name__,
        )
        raise SystemExit(1)
