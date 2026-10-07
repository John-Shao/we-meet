"""Scoped, phase-by-phase execution of the reviewed Work schema/image alignment.

Run on the production Linux host as root with the public reviewed candidate JSON.
Full resource snapshots and PostgreSQL archives remain root-only on that host.
"""

import argparse
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time

K = ["kubectl", "--kubeconfig=/etc/rancher/k3s/k3s.yaml", "--request-timeout=10s"]
ROOT = Path("/var/lib/we-meet-work-maintenance/business-align-41dd33f0a")
NODE_UID = "6c67a844-37f0-4eff-85fe-0420137b6f5f"
DB_UID = "b7d93f63-1f98-435a-8db3-54e0b41c8660"
JOB = "work-schema-align-41dd33f0a"
OWNER = "work-business-align"
RELEASE = "41dd33f0a"
FLAGS = (
    "WORK_AGENT_ENABLED",
    "WORK_LOCAL_AGENT_ENABLED",
    "WORK_REMOTE_AGENT_ENABLED",
    "WORK_REVIEW_ENABLED",
)


class AlignmentError(RuntimeError):
    pass


def require(value, code):
    if not value:
        raise AlignmentError(code)


def run(args, body=None, timeout=30):
    result = subprocess.run(args, input=body, capture_output=True, timeout=timeout)
    require(result.returncode == 0, "command_failed:" + args[0])
    return result.stdout


def api(*args, body=None):
    return json.loads(run(K + list(args), body))


def write_private(name, value):
    path = ROOT / name
    require(not path.is_symlink(), "unsafe_private_path")
    temp = ROOT / (name + ".tmp")
    with temp.open("w", encoding="utf8") as stream:
        json.dump(value, stream)
    os.chmod(temp, 0o600)
    temp.replace(path)


def read_private(name):
    path = ROOT / name
    require(not path.is_symlink() and path.stat().st_uid == 0, "unsafe_private_state")
    return json.loads(path.read_text())


def pod_spec(item):
    spec = item["spec"]
    if item["kind"] == "CronJob":
        spec = spec["jobTemplate"]["spec"]
    return spec["template"]["spec"]


def normalized_spec(item):
    """Ignore controller status/RV, preserve every user-managed spec field."""
    return item["spec"]


def changed_spec(item, image):
    result = copy.deepcopy(item)
    container = pod_spec(result)["containers"][0]
    require(len(pod_spec(result)["containers"]) == 1, "unexpected_sidecar")
    container["image"] = image
    env = container.setdefault("env", [])
    require(not set(FLAGS) & {entry["name"] for entry in env}, "unexpected_flags")
    env.extend({"name": name, "value": "False"} for name in FLAGS)
    return result


def fenced_patch(current, old, image):
    require(current["metadata"]["uid"] == old["metadata"]["uid"], "resource_recreated")
    require(normalized_spec(current) == normalized_spec(old), "business_spec_drift")
    prefix = (
        "/spec/jobTemplate/spec/template/spec"
        if current["kind"] == "CronJob"
        else "/spec/template/spec"
    )
    container = pod_spec(current)["containers"][0]
    changed = changed_spec(current, image)
    return [
        {"op": "test", "path": "/metadata/uid", "value": current["metadata"]["uid"]},
        {
            "op": "test",
            "path": "/metadata/resourceVersion",
            "value": current["metadata"]["resourceVersion"],
        },
        {
            "op": "test",
            "path": prefix + "/containers/0/image",
            "value": container["image"],
        },
        {"op": "replace", "path": prefix + "/containers/0/image", "value": image},
        {
            "op": "replace",
            "path": prefix + "/containers/0/env",
            "value": pod_spec(changed)["containers"][0]["env"],
        },
    ]


def node_check():
    nodes = api("get", "nodes", "-o", "json")["items"]
    require(
        len(nodes) == 1 and nodes[0]["metadata"]["uid"] == NODE_UID,
        "node_identity_changed",
    )
    require(
        any(
            c["type"] == "Ready" and c["status"] == "True"
            for c in nodes[0]["status"]["conditions"]
        ),
        "node_unready",
    )
    return nodes[0]


def backend_pod():
    deployment = api("get", "deployment", "meet-backend", "-n", "meet", "-o", "json")
    selector = ",".join(
        k + "=" + v for k, v in deployment["spec"]["selector"]["matchLabels"].items()
    )
    pods = api("get", "pod", "-n", "meet", "-l", selector, "-o", "json")["items"]
    ready = [
        p
        for p in pods
        if not p["metadata"].get("deletionTimestamp")
        and any(
            c["type"] == "Ready" and c["status"] == "True"
            for c in p["status"].get("conditions", [])
        )
    ]
    require(len(ready) == 1, "backend_ready_pod_ambiguous")
    return ready[0]["metadata"]["name"]


def schema():
    code = """import json,configurations
configurations.setup()
from django.db import connection,transaction
with transaction.atomic():
 with connection.cursor() as c:
  c.execute('SET TRANSACTION READ ONLY')
  c.execute('SELECT app,name FROM django_migrations ORDER BY app,name');rows=c.fetchall()
  c.execute('SELECT current_database(),pg_database_size(current_database())');name,size=c.fetchone()
print('ALIGN_SCHEMA'+json.dumps({'rows':rows,'database_name':name,'database_size':size}))
"""
    output = run(
        K + ["exec", "-i", "-n", "meet", backend_pod(), "--", "python", "-"],
        code.encode(),
    )
    return json.loads(
        next(
            line[len("ALIGN_SCHEMA") :]
            for line in output.decode().splitlines()
            if line.startswith("ALIGN_SCHEMA")
        )
    )


def headroom(required_m):
    node = node_check()
    alloc = float(node["status"]["allocatable"]["cpu"]) * 1000
    pods = api("get", "pods", "-A", "-o", "json")["items"]
    used = 0
    for pod in pods:
        if pod["status"].get("phase") in ("Succeeded", "Failed"):
            continue
        # Conservatively sum init requests too; never force nodeName scheduling.
        for c in pod["spec"].get("containers", []) + pod["spec"].get(
            "initContainers", []
        ):
            value = c.get("resources", {}).get("requests", {}).get("cpu", "0")
            used += float(value[:-1]) if value.endswith("m") else float(value) * 1000
    require(alloc - used >= required_m, "cpu_requests_headroom_insufficient")
    return used


def prepare(candidate):
    require(not ROOT.exists(), "release_state_already_exists")
    node_check()
    status = json.loads(
        run(
            [
                "helm",
                "--kubeconfig=/etc/rancher/k3s/k3s.yaml",
                "status",
                "meet",
                "-n",
                "meet",
                "-o",
                "json",
            ]
        )
    )
    require(
        status["version"] == candidate["helm_revision_at_inventory"]
        and status["info"]["status"] == "deployed",
        "helm_release_changed",
    )
    snapshots = []
    expected = {(s["kind"], s["name"]): s for s in candidate["controller_snapshots"]}
    resources = api(
        "get", "deployment,statefulset,daemonset,cronjob", "-n", "meet", "-o", "json"
    )["items"]
    consumers = [
        item
        for item in resources
        if any(
            "/we-meet/meet-backend" in c["image"]
            for c in pod_spec(item).get("containers", [])
        )
    ]
    require(
        {(s["kind"], s["metadata"]["name"]) for s in consumers} == set(expected),
        "consumer_set_changed",
    )
    for item in consumers:
        reviewed = expected[(item["kind"], item["metadata"]["name"])]
        require(item["metadata"]["uid"] == reviewed["uid"], "consumer_uid_changed")
        require(
            [c["image"] for c in pod_spec(item)["containers"]]
            == [c["image"] for c in reviewed["containers"]],
            "consumer_image_changed",
        )
        changed_spec(item, candidate["immutable_image"])
        snapshots.append(item)
    baseline = schema()
    require(
        [name for app, name in baseline["rows"] if app == "work"]
        == ["0001_initial", "0002_workmaterial_locations_worktask_workrun_and_more"],
        "work_baseline_changed",
    )
    require(baseline["database_name"] == "meet", "unexpected_database")
    pg = api("get", "pod", "postgresql-0", "-n", "meet", "-o", "json")
    require(pg["metadata"]["uid"] == DB_UID, "database_pod_changed")
    require(
        shutil.disk_usage(ROOT.parent).free
        > baseline["database_size"] * 2 + 100_000_000,
        "backup_space_insufficient",
    )
    ROOT.mkdir(mode=0o700)
    write_private("snapshot.json", snapshots)
    write_private("candidate.json", candidate)
    write_private(
        "state.json", {"phase": "backup_started", "updated": [], "baseline": baseline}
    )
    return backup_database()


def backup_database():
    state = read_private("state.json")
    require(
        state["phase"] == "backup_started", "backup_retry_requires_pre_migration_state"
    )
    require(schema()["rows"] == state["baseline"]["rows"], "backup_baseline_changed")
    pg = api("get", "pod", "postgresql-0", "-n", "meet", "-o", "json")
    require(pg["metadata"]["uid"] == DB_UID, "database_pod_changed")
    backup = ROOT / "database-before.dump"
    if backup.exists():
        require(
            not backup.is_symlink() and backup.stat().st_uid == 0, "unsafe_backup_path"
        )
        previous = ROOT / ("database-failed-" + str(time.time_ns()) + ".dump")
        backup.rename(previous)
    # Use the proven live application connection, not a possibly stale admin file.
    code = """import json,configurations
configurations.setup()
from django.conf import settings
d=settings.DATABASES['default']
print('BACKUP_CONFIG'+json.dumps({n:d[n] for n in ('NAME','USER','PASSWORD','HOST')}))
"""
    output = run(
        K + ["exec", "-i", "-n", "meet", backend_pod(), "--", "python", "-"],
        code.encode(),
    )
    database = json.loads(
        next(
            line[len("BACKUP_CONFIG") :]
            for line in output.decode().splitlines()
            if line.startswith("BACKUP_CONFIG")
        )
    )
    require(
        database["NAME"] == "meet"
        and database["HOST"]
        in (
            "postgresql",
            "postgresql.meet",
            "postgresql.meet.svc",
            "postgresql.meet.svc.cluster.local",
        ),
        "backup_database_destination_mismatch",
    )
    # Password travels only via stdin, never CLI, logs, files or public receipts.
    shell = 'set -eu; read -r encoded_password; export PGPASSWORD; PGPASSWORD="$(printf %s "$encoded_password" | base64 -d)"; exec pg_dump -h 127.0.0.1 -U "$1" -d meet -Fc --no-owner --no-acl --serializable-deferrable'
    with backup.open("xb") as stream:
        os.chmod(backup, 0o600)
        result = subprocess.run(
            K
            + [
                "exec",
                "-i",
                "-n",
                "meet",
                "postgresql-0",
                "--",
                "sh",
                "-c",
                shell,
                "backup",
                database["USER"],
            ],
            input=base64.b64encode(database["PASSWORD"].encode()) + b"\n",
            stdout=stream,
            stderr=subprocess.PIPE,
            timeout=180,
        )
    write_private(
        "backup-result.json",
        {"returncode": result.returncode, "stderr": result.stderr.decode()},
    )
    require(
        result.returncode == 0 and backup.stat().st_size > 0, "database_backup_failed"
    )
    return validate_backup()


def validate_backup():
    state = read_private("state.json")
    require(
        state["phase"] == "backup_started", "validation_requires_pre_migration_state"
    )
    require(
        read_private("backup-result.json")["returncode"] == 0,
        "successful_dump_required",
    )
    backup = ROOT / "database-before.dump"
    require(not backup.is_symlink() and backup.stat().st_uid == 0, "unsafe_backup_path")
    require(
        0 < backup.stat().st_size < 256_000_000,
        "backup_validation_size_exceeds_reviewed_limit",
    )
    with backup.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    folder = "/tmp/work-business-align-" + RELEASE
    archive = folder + "/database-before.dump"
    # tar's bounded archive stream avoids pg_restore waiting for stdin EOF.
    run(
        K
        + [
            "exec",
            "-n",
            "meet",
            "postgresql-0",
            "--",
            "sh",
            "-c",
            'umask 077; test ! -e "$1" && mkdir -m 700 "$1"',
            "validate",
            folder,
        ]
    )
    run(K + ["cp", "--no-preserve=true", str(backup), "meet/postgresql-0:" + archive], timeout=60)
    output = run(K + ["exec", "-n", "meet", "postgresql-0", "--", "sha256sum", archive])
    require(output.decode().split()[0] == checksum, "validation_copy_checksum_mismatch")
    output = run(
        K
        + ["exec", "-n", "meet", "postgresql-0", "--", "pg_restore", "--list", archive],
        timeout=30,
    )
    require(b"TABLE DATA" in output, "backup_toc_invalid")
    run(
        K
        + [
            "exec",
            "-n",
            "meet",
            "postgresql-0",
            "--",
            "pg_restore",
            "--file=/dev/null",
            archive,
        ],
        timeout=60,
    )
    run(
        K
        + [
            "exec",
            "-n",
            "meet",
            "postgresql-0",
            "--",
            "sh",
            "-c",
            'set -eu; test "$(sha256sum "$1" | cut -d " " -f 1)" = "$3"; rm -- "$1"; rmdir -- "$2"',
            "cleanup",
            archive,
            folder,
            checksum,
        ]
    )
    state = read_private("state.json")
    state.update(
        phase="prepared", backup_sha256=checksum, backup_bytes=backup.stat().st_size
    )
    write_private("state.json", state)
    return {
        "phase": "prepared",
        "backup_sha256": checksum,
        "backup_bytes": backup.stat().st_size,
        "backup_toc_and_full_payload_valid": True,
        "backup_downloaded": False,
        "restore_drill_performed": False,
        "consumer_snapshots": len(read_private("snapshot.json")),
    }


def migration_job(old, image):
    original = pod_spec(old)
    env = [
        copy.deepcopy(e)
        for e in original["containers"][0].get("env", [])
        if e["name"] in ("DB_HOST", "DB_NAME", "DB_PORT", "DB_USER", "DB_PASSWORD")
    ]
    require(
        {e["name"] for e in env} >= {"DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"},
        "database_env_incomplete",
    )
    env += [
        {"name": "DJANGO_SETTINGS_MODULE", "value": "meet.settings"},
        {"name": "DJANGO_CONFIGURATION", "value": "Production"},
        {"name": "DJANGO_SECRET_KEY", "value": secrets.token_urlsafe(48)},
    ]
    env += [{"name": name, "value": "False"} for name in FLAGS]
    command = """import io,json
from django.core.management import call_command
import configurations
configurations.setup()
out=io.StringIO();call_command('migrate_work_upgrade',stdout=out);print('ALIGN_PLAN'+out.getvalue().strip(),flush=True)
out=io.StringIO();call_command('migrate_work_upgrade',apply=True,stdout=out);print('ALIGN_APPLIED'+out.getvalue().strip(),flush=True)
"""
    pod = {
        "restartPolicy": "Never",
        "automountServiceAccountToken": False,
        "containers": [
            {
                "name": "migration",
                "image": image,
                "imagePullPolicy": "IfNotPresent",
                "command": ["python", "-c", command],
                "env": env,
                "resources": {
                    "requests": {"cpu": "100m", "memory": "128Mi"},
                    "limits": {"cpu": "500m", "memory": "512Mi"},
                },
            }
        ],
    }
    for name in ("imagePullSecrets", "securityContext", "nodeSelector", "tolerations"):
        if name in original:
            pod[name] = copy.deepcopy(original[name])
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": JOB, "namespace": "meet", "labels": {OWNER: RELEASE}},
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": 180,
            "template": {"metadata": {"labels": {OWNER: RELEASE}}, "spec": pod},
        },
    }


def migrate():
    state = read_private("state.json")
    require(state["phase"] == "prepared", "migration_phase_requires_prepared_backup")
    with (ROOT / "database-before.dump").open("rb") as stream:
        require(
            hashlib.file_digest(stream, "sha256").hexdigest() == state["backup_sha256"],
            "backup_changed",
        )
    require(schema()["rows"] == state["baseline"]["rows"], "migration_history_drift")
    headroom(100)
    snapshots = read_private("snapshot.json")
    for old in snapshots:
        current = api(
            "get", old["kind"], old["metadata"]["name"], "-n", "meet", "-o", "json"
        )
        require(
            current["metadata"]["uid"] == old["metadata"]["uid"]
            and normalized_spec(current) == normalized_spec(old),
            "pre_migration_business_drift",
        )
    candidate = read_private("candidate.json")
    backend = next(s for s in snapshots if s["metadata"]["name"] == "meet-backend")
    job = api(
        "create",
        "-f",
        "-",
        "-o",
        "json",
        body=json.dumps(migration_job(backend, candidate["immutable_image"])).encode(),
    )
    state.update(phase="migration_started", job_uid=job["metadata"]["uid"])
    write_private("state.json", state)
    deadline = time.monotonic() + 220
    while time.monotonic() < deadline:
        current = api("get", "job", JOB, "-n", "meet", "-o", "json")
        require(
            current["metadata"]["uid"] == state["job_uid"], "migration_job_recreated"
        )
        if current["status"].get("succeeded"):
            break
        require(
            not any(
                c["type"] == "Failed" and c["status"] == "True"
                for c in current["status"].get("conditions", [])
            ),
            "migration_job_failed_no_retry",
        )
        time.sleep(3)
    else:
        raise AlignmentError("migration_job_timeout_no_retry")
    logs = run(K + ["logs", "job/" + JOB, "-n", "meet"])
    write_private("migration-log.json", {"output": logs.decode()})
    applied = json.loads(
        next(
            line[len("ALIGN_APPLIED") :]
            for line in logs.decode().splitlines()
            if line.startswith("ALIGN_APPLIED")
        )
    )
    require(
        applied["phase"] == "applied" and applied["atomic"],
        "unexpected_migration_result",
    )
    after = schema()
    expected = [n for a, n in state["baseline"]["rows"] if a == "work"] + candidate[
        "migration_plan"
    ]
    require(
        [n for a, n in after["rows"] if a == "work"] == expected,
        "migration_target_mismatch",
    )
    require(
        [r for r in after["rows"] if r[0] != "work"]
        == [r for r in state["baseline"]["rows"] if r[0] != "work"],
        "non_work_history_changed",
    )
    state.update(phase="migrated", schema=after)
    write_private("state.json", state)
    return {
        "phase": "migrated",
        "job_uid": state["job_uid"],
        "applied": applied,
        "non_work_history_unchanged": True,
    }


def rollout(name):
    state = read_private("state.json")
    require(state["phase"] in ("migrated", "rolling"), "rollout_requires_migration")
    require(not state.get("in_flight"), "previous_rollout_requires_inspection")
    require(name not in state["updated"], "resource_already_updated")
    candidate = read_private("candidate.json")
    old = next(
        (s for s in read_private("snapshot.json") if s["metadata"]["name"] == name),
        None,
    )
    require(old is not None, "resource_not_in_reviewed_scope")
    current = api("get", old["kind"], name, "-n", "meet", "-o", "json")
    if old["kind"] == "Deployment":
        require(old["spec"].get("replicas") == 1, "unexpected_replica_count")
        request = pod_spec(old)["containers"][0]["resources"]["requests"]["cpu"]
        headroom(
            float(request[:-1]) if request.endswith("m") else float(request) * 1000
        )
    patch = fenced_patch(current, old, candidate["immutable_image"])
    state.update(phase="rolling", in_flight=name)
    write_private("state.json", state)
    # Patch includes secret-bearing original env: stdin only, no CLI or public log.
    changed = api(
        "patch",
        old["kind"],
        name,
        "-n",
        "meet",
        "--type=json",
        "--patch-file=/dev/stdin",
        "-o",
        "json",
        body=json.dumps(patch).encode(),
    )
    require(
        normalized_spec(changed)
        == normalized_spec(changed_spec(old, candidate["immutable_image"])),
        "unexpected_patch_result",
    )
    write_private("applied-" + name + ".json", changed)
    if old["kind"] == "Deployment":
        run(
            K
            + [
                "rollout",
                "status",
                "deployment/" + name,
                "-n",
                "meet",
                "--timeout=180s",
            ],
            timeout=200,
        )
        current = api("get", "deployment", name, "-n", "meet", "-o", "json")
        require(
            current["status"].get("readyReplicas") == 1
            and current["status"].get("updatedReplicas") == 1,
            "deployment_not_ready",
        )
    state["updated"].append(name)
    state.pop("in_flight", None)
    write_private("state.json", state)
    return {
        "phase": "resource_updated",
        "name": name,
        "kind": old["kind"],
        "uid": changed["metadata"]["uid"],
        "image": candidate["immutable_image"],
        "new_flags": {n: False for n in FLAGS},
    }


def verify():
    state = read_private("state.json")
    require(
        state["phase"] == "rolling" and not state.get("in_flight"),
        "verification_requires_finished_rollouts",
    )
    snapshots = read_private("snapshot.json")
    require(
        set(state["updated"]) == {s["metadata"]["name"] for s in snapshots},
        "incomplete_rollout",
    )
    candidate = read_private("candidate.json")
    controllers = []
    worker_pods = []
    http_pods = []
    for old in snapshots:
        name = old["metadata"]["name"]
        current = api("get", old["kind"], name, "-n", "meet", "-o", "json")
        require(
            current["metadata"]["uid"] == old["metadata"]["uid"]
            and normalized_spec(current)
            == normalized_spec(changed_spec(old, candidate["immutable_image"])),
            "post_release_drift",
        )
        if old["kind"] == "Deployment":
            require(
                current["status"].get("observedGeneration")
                == current["metadata"]["generation"]
                and current["status"].get("readyReplicas") == 1
                and current["status"].get("updatedReplicas") == 1
                and current["status"].get("availableReplicas") == 1,
                "post_release_deployment_unready",
            )
            selector = ",".join(
                k + "=" + v
                for k, v in current["spec"]["selector"]["matchLabels"].items()
            )
            pods = api("get", "pods", "-n", "meet", "-l", selector, "-o", "json")[
                "items"
            ]
            ready = [
                p
                for p in pods
                if not p["metadata"].get("deletionTimestamp")
                and any(
                    c["type"] == "Ready" and c["status"] == "True"
                    for c in p["status"].get("conditions", [])
                )
            ]
            require(len(ready) == 1, "post_release_pod_ambiguous")
            pod = ready[0]
            if name in ("meet-celery-backend", "meet-celery-work"):
                worker_pods.append(pod["metadata"]["name"])
            if name in ("meet-backend", "meet-backend-ai"):
                http_pods.append(
                    (
                        name,
                        pod["metadata"]["name"],
                        pod["spec"]["containers"][0]["ports"][0]["containerPort"],
                    )
                )
        controllers.append(
            {
                "kind": old["kind"],
                "name": name,
                "uid": current["metadata"]["uid"],
                "image": candidate["immutable_image"],
            }
        )
    require(schema()["rows"] == state["schema"]["rows"], "post_release_schema_drift")
    http_results = []
    for name, pod, port in http_pods:
        code = (
            """import json,socket,urllib.request,configurations
configurations.setup()
from django.conf import settings
from django.urls import resolve
flags={n:getattr(settings,n) for n in """
            + repr(FLAGS)
            + """}
assert not any(flags.values())
routes=['local/devices/','local/workspaces/','local/remote-tasks/','local/inbox/','runs/00000000-0000-0000-0000-000000000000/reviews/']
for route in routes:resolve('/api/'+settings.API_VERSION+'/work/'+route)
health={}
for endpoint in ('/__heartbeat__','/__lbheartbeat__'):
 request=urllib.request.Request('http://127.0.0.1:"""
            + str(port)
            + """'+endpoint,headers={'Host':socket.gethostbyname(socket.gethostname())})
 with urllib.request.urlopen(request,timeout=10) as response:health[endpoint]=response.status
assert all(value==200 for value in health.values())
print('VERIFY_HTTP'+json.dumps({'new_flags':flags,'resolved_new_routes':len(routes),'health':health}))
"""
        )
        output = run(
            K + ["exec", "-i", "-n", "meet", pod, "--", "python", "-"], code.encode()
        )
        value = json.loads(
            next(
                line[len("VERIFY_HTTP") :]
                for line in output.decode().splitlines()
                if line.startswith("VERIFY_HTTP")
            )
        )
        http_results.append({"deployment": name, **value})
    code = (
        """import json,configurations
configurations.setup()
from meet.celery_app import app
reply=app.control.inspect(timeout=5).ping() or {}
expected="""
        + repr(worker_pods)
        + """
assert all(any(name in key and value.get('ok')=='pong' for key,value in reply.items()) for name in expected)
print('VERIFY_WORKERS'+json.dumps({'expected_worker_pods':expected,'expected_workers_pong':True,'reply_count':len(reply)}))
"""
    )
    output = run(
        K + ["exec", "-i", "-n", "meet", backend_pod(), "--", "python", "-"],
        code.encode(),
    )
    workers = json.loads(
        next(
            line[len("VERIFY_WORKERS") :]
            for line in output.decode().splitlines()
            if line.startswith("VERIFY_WORKERS")
        )
    )
    pods = api("get", "pods", "-n", "meet", "-o", "json")["items"]
    business = [
        p
        for p in pods
        if not p["metadata"].get("deletionTimestamp")
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
            for p in business
        ),
        "business_pod_unready",
    )
    job = api("get", "job", JOB, "-n", "meet", "-o", "json")
    require(
        job["metadata"]["uid"] == state["job_uid"]
        and job["metadata"].get("labels", {}).get(OWNER) == RELEASE
        and job["status"].get("succeeded") == 1,
        "cleanup_ownership_mismatch",
    )
    body = json.dumps(
        {
            "apiVersion": "v1",
            "kind": "DeleteOptions",
            "propagationPolicy": "Foreground",
            "preconditions": {"uid": state["job_uid"]},
        }
    ).encode()
    run(
        K + ["delete", "--raw=/apis/batch/v1/namespaces/meet/jobs/" + JOB, "-f", "-"],
        body,
    )
    state["phase"] = "verified"
    write_private("state.json", state)
    return {
        "phase": "verified",
        "controllers": controllers,
        "http_checks": http_results,
        "celery_checks": workers,
        "business_non_job_pods_ready": len(business),
        "migration_job_cleanup_requested_with_uid": state["job_uid"],
        "backup_bytes": state["backup_bytes"],
        "backup_sha256": state["backup_sha256"],
        "supplier_calls_by_this_release": 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "phase",
        choices=(
            "prepare",
            "backup",
            "validate-backup",
            "migrate",
            "rollout",
            "verify",
        ),
    )
    parser.add_argument("--candidate")
    parser.add_argument("--candidate-json", help="Public reviewed JSON; no credentials")
    parser.add_argument("--name")
    args = parser.parse_args()
    require(os.name == "posix" and os.geteuid() == 0, "linux_root_required")
    require(
        all(not p.is_symlink() for p in (ROOT, *ROOT.parents)), "unsafe_state_parent"
    )
    os.umask(0o077)
    import fcntl

    ROOT.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (ROOT.parent / "business-align.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            if args.phase == "prepare":
                public = (
                    args.candidate_json
                    if args.candidate_json
                    else Path(args.candidate).read_text()
                )
                candidate = json.loads(public)["release_candidate"]
                result = prepare(candidate)
            elif args.phase == "backup":
                result = backup_database()
            elif args.phase == "validate-backup":
                result = validate_backup()
            elif args.phase == "migrate":
                result = migrate()
            elif args.phase == "verify":
                result = verify()
            else:
                result = rollout(args.name)
        except (AlignmentError, subprocess.TimeoutExpired) as exc:
            print("PUBLIC_RESULT_BEGIN")
            print(
                json.dumps(
                    {
                        "phase": args.phase,
                        "failed": True,
                        "reason": str(exc)
                        if isinstance(exc, AlignmentError)
                        else "command_timeout",
                    }
                )
            )
            print("PUBLIC_RESULT_END")
            raise SystemExit(1) from None
    print("PUBLIC_RESULT_BEGIN")
    print(json.dumps(result, indent=2))
    print("PUBLIC_RESULT_END")


if __name__ == "__main__":
    main()
