"""Reviewed seven-controller account rollout; no Helm upgrade or DB migration.

Run as root on the production host. Snapshots and account identifiers stay private.
Use prepare, then closed/open/close, then verify. Each rollout is RV/spec fenced.
"""

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path

STATE_PARENT = Path("/var/lib/we-meet-work-maintenance")
DEFAULT_RELEASE_ID = "cohort-e92f9eec4"
ROOT = STATE_PARENT / DEFAULT_RELEASE_ID
FLAGS = (
    "WORK_AGENT_ENABLED",
    "WORK_LOCAL_AGENT_ENABLED",
    "WORK_REMOTE_AGENT_ENABLED",
    "WORK_REVIEW_ENABLED",
)
ORDER = (
    "meet-celery-work",
    "meet-celery-backend",
    "meet-celery-beat",
    "meet-backend-docs-profiles",
    "meet-backend-reminders",
    "meet-backend-ai",
    "meet-backend",
)
ACCOUNT_HASH = "ada9bbbb960ea8fdc825a05b31265b5b9c9eab7334d677244ea555af491dc7e5"


def require(value, code):
    if not value:
        raise RuntimeError(code)


def release_root(release_id):
    require(
        isinstance(release_id, str)
        and re.fullmatch(r"cohort-[a-z0-9][a-z0-9-]{0,62}", release_id) is not None,
        "invalid_release_id",
    )
    return STATE_PARENT / release_id


def digest(spec):
    return hashlib.sha256(
        json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def changed(item, image, stage, account):
    require(stage in ("closed", "open", "close", "rollback"), "unknown_stage")
    result = copy.deepcopy(item)
    spec = result["spec"]
    pod = (
        spec["jobTemplate"]["spec"]["template"]["spec"]
        if item["kind"] == "CronJob"
        else spec["template"]["spec"]
    )
    require(len(pod["containers"]) == 1, "unexpected_sidecar")
    container = pod["containers"][0]
    container["image"] = image
    values = {name: "False" for name in FLAGS}
    values.update(WORK_AGENT_ROLLOUT_MODE="closed", WORK_AGENT_ALLOWED_USER_IDS="")
    if stage == "open":
        require(
            hashlib.sha256(account.encode()).hexdigest() == ACCOUNT_HASH,
            "account_not_reviewed",
        )
        values.update(
            WORK_LOCAL_AGENT_ENABLED="True",
            WORK_REMOTE_AGENT_ENABLED="True",
            WORK_AGENT_ROLLOUT_MODE="allowlist",
            WORK_AGENT_ALLOWED_USER_IDS=account,
            WORK_AGENT_MAX_CALLS="5",
            WORK_AGENT_TOKEN_BUDGET="20000",
        )
    env = container.setdefault("env", [])
    require(len({entry["name"] for entry in env}) == len(env), "duplicate_env")
    # Build from the original to preserve order and every unrelated value/valueFrom.
    original = (
        item["spec"]["jobTemplate"]["spec"]["template"]["spec"]
        if item["kind"] == "CronJob"
        else item["spec"]["template"]["spec"]
    )["containers"][0].get("env", [])
    entry_for = lambda name: {
        "name": name,
        **({"value": values[name]} if values[name] else {}),
    }
    container["env"] = [
        (entry_for(e["name"]) if e["name"] in values else copy.deepcopy(e))
        for e in original
    ]
    existing = {e["name"] for e in original}
    container["env"].extend(entry_for(name) for name in values if name not in existing)
    return result


def patch_for(current, expected, target):
    require(
        current["metadata"]["uid"] == expected["metadata"]["uid"], "resource_recreated"
    )
    require(current["spec"] == expected["spec"], "full_spec_drift")
    require(
        target["metadata"]["uid"] == expected["metadata"]["uid"],
        "target_identity_changed",
    )
    return [
        {"op": "test", "path": "/metadata/uid", "value": current["metadata"]["uid"]},
        {
            "op": "test",
            "path": "/metadata/resourceVersion",
            "value": current["metadata"]["resourceVersion"],
        },
        {"op": "test", "path": "/spec", "value": current["spec"]},
        {"op": "replace", "path": "/spec", "value": target["spec"]},
    ]


def load_runtime():
    spec = importlib.util.spec_from_file_location(
        "alignment", Path(__file__).with_name("align-work-business.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = ROOT
    return module


def exec_json(r, code):
    output = r.run(
        r.K + ["exec", "-i", "-n", "meet", r.backend_pod(), "--", "python", "-"],
        code.encode(),
        timeout=45,
    )
    return json.loads(
        next(
            line[11:]
            for line in output.decode().splitlines()
            if line.startswith("COHORT_JSON")
        )
    )


def account_check(r, account=None):
    account = account or r.read_private("state.json")["account"]
    require(
        hashlib.sha256(account.encode()).hexdigest() == ACCOUNT_HASH,
        "account_not_reviewed",
    )
    value = exec_json(
        r,
        """import json,configurations
configurations.setup()
from django.db import transaction,connection
from core.models import User
with transaction.atomic():
 with connection.cursor() as c:c.execute('SET TRANSACTION READ ONLY')
 rows=list(User.objects.filter(pk="""
        + repr(account)
        + """).values('id','is_active','sub','is_device')[:3])
 assert len(rows)==1 and rows[0]['is_active'] and rows[0]['sub'] and not rows[0]['is_device']
print('COHORT_JSON'+json.dumps({'account':str(rows[0]['id'])}))
""",
    )
    require(
        hashlib.sha256(value["account"].encode()).hexdigest() == ACCOUNT_HASH,
        "account_identity_changed",
    )
    return value["account"]


def gateway(r):
    rows = r.api("get", "deployment", "-n", "meet-work-review", "-o", "json")["items"]
    rows = [
        row
        for row in rows
        if row["metadata"]["uid"] == "d042e27f-608f-46a7-82d6-672ca2bc30f7"
    ]
    require(len(rows) == 1, "gateway_identity_changed")
    value = rows[0]
    return {"uid": value["metadata"]["uid"], "spec_sha256": digest(value["spec"])}


def prepare(r, candidate):
    require(not ROOT.exists(), "release_state_exists")
    r.node_check()
    account = account_check(r, candidate["verified_account_uuid"])
    baseline = r.schema()
    require(
        len([row for row in baseline["rows"] if row[0] == "work"]) == 7,
        "work_schema_not_0007",
    )
    resources = r.api("get", "deployment,cronjob", "-n", "meet", "-o", "json")["items"]
    rows = {
        row["metadata"]["name"]: row
        for row in resources
        if row["metadata"]["name"] in ORDER
    }
    require(set(rows) == set(ORDER), "consumer_set_changed")
    reviewed = {
        row["name"]: row for row in candidate["production_baseline"]["consumers"]
    }
    for name, row in rows.items():
        require(
            row["metadata"]["uid"] == reviewed[name]["uid"]
            and digest(row["spec"]) == reviewed[name]["spec_sha256"],
            "reviewed_baseline_changed",
        )
    helm = json.loads(
        r.run(
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
        helm["version"] == 457 and helm["info"]["status"] == "deployed",
        "helm_revision_changed",
    )
    ROOT.mkdir(mode=0o700, exist_ok=True)
    require(not ROOT.is_symlink() and ROOT.stat().st_uid == 0, "unsafe_root")
    os.chmod(ROOT, 0o700)
    r.write_private("snapshot.json", rows)
    r.write_private("candidate.json", candidate)
    r.write_private(
        "state.json",
        {
            "phase": "prepared",
            "expected": rows,
            "account": account,
            "schema": baseline["rows"],
            "gateway": gateway(r),
            "completed": [],
        },
    )
    return {
        "phase": "prepared",
        "controllers": 7,
        "account_verified": True,
        "database_migrations": 0,
    }


def rollout(r, stage):
    state = r.read_private("state.json")
    allowed = {
        "closed": ("prepared", "installing"),
        "open": ("closed",),
        "close": ("open", "closed", "opening", "closing"),
        "rollback": ("close",),
    }
    require(state["phase"] in allowed[stage], "stage_transition_rejected")
    require(not state.get("in_flight"), "in_flight_requires_inspection")
    require(account_check(r) == state["account"], "account_changed")
    require(gateway(r) == state["gateway"], "gateway_changed")
    image = r.read_private("candidate.json")["release_candidate"]["immutable_image"]
    snapshots = r.read_private("snapshot.json")
    completed = (
        state["completed"]
        if stage == "closed" and state["phase"] == "installing"
        else []
    )
    state.update(
        phase={
            "closed": "installing",
            "open": "opening",
            "close": "closing",
            "rollback": "rolling_back",
        }[stage],
        completed=completed,
    )
    r.write_private("state.json", state)
    for name in ORDER:
        if name in state["completed"]:
            continue
        expected = state["expected"][name]
        current = r.api("get", expected["kind"], name, "-n", "meet", "-o", "json")
        if expected["kind"] == "Deployment":
            require(expected["spec"].get("replicas") == 1, "replica_count_changed")
            request = r.pod_spec(expected)["containers"][0]["resources"]["requests"][
                "cpu"
            ]
            r.wait_headroom(
                float(request[:-1]) if request.endswith("m") else float(request) * 1000
            )
        target = changed(expected, image, stage, state["account"])
        if stage == "rollback":
            target = changed(
                snapshots[name],
                r.pod_spec(snapshots[name])["containers"][0]["image"],
                stage,
                "",
            )
        patch = patch_for(current, expected, target)
        state["in_flight"] = {"name": name, "target": target}
        r.write_private("state.json", state)
        applied = r.api(
            "patch",
            expected["kind"],
            name,
            "-n",
            "meet",
            "--type=json",
            "--patch-file=/dev/stdin",
            "-o",
            "json",
            body=json.dumps(patch).encode(),
        )
        require(applied["spec"] == target["spec"], "unexpected_patch_result")
        state["expected"][name] = applied
        r.write_private("state.json", state)
        if expected["kind"] == "Deployment":
            r.run(
                r.K
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
        state.pop("in_flight")
        state["completed"].append(name)
        r.write_private("state.json", state)
        print(
            json.dumps({"event": "controller_updated", "stage": stage, "name": name}),
            flush=True,
        )
    state["phase"] = stage
    r.write_private("state.json", state)
    export_values(r, state)
    return {"phase": stage, "controllers": 7, "cloud_and_pi_closed": True}


def export_values(r, state):
    env = r.pod_spec(state["expected"]["meet-backend"])["containers"][0]["env"]
    values = {
        e["name"]: e.get("valueFrom", e.get("value", ""))
        for e in env
        if e["name"].startswith(("WORK_AGENT_", "WORK_REVIEW_"))
        or e["name"] in ("WORK_LOCAL_AGENT_ENABLED", "WORK_REMOTE_AGENT_ENABLED")
    }
    r.write_private("values.work-cohort.yaml", {"backend": {"envVars": values}})
    return values


def recover(r):
    """Resolve only the known Kubernetes empty EnvVar canonicalization case."""
    state = r.read_private("state.json")
    require(
        state["phase"] == "installing" and state.get("in_flight"),
        "recovery_not_applicable",
    )
    flight = state["in_flight"]
    name = flight["name"]
    target = copy.deepcopy(flight["target"])
    env = r.pod_spec(target)["containers"][0]["env"]
    for entry in env:
        if entry["name"] == "WORK_AGENT_ALLOWED_USER_IDS" and entry.get("value") == "":
            entry.pop("value")
    current = r.api("get", target["kind"], name, "-n", "meet", "-o", "json")
    require(
        current["metadata"]["uid"] == target["metadata"]["uid"]
        and current["spec"] == target["spec"],
        "recovery_spec_drift",
    )
    require(
        all(
            next(e.get("value") for e in env if e["name"] == flag) == "False"
            for flag in FLAGS
        ),
        "recovery_not_closed",
    )
    if target["kind"] == "Deployment":
        r.run(
            r.K
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
    state["expected"][name] = current
    state["completed"].append(name)
    state.pop("in_flight")
    r.write_private("state.json", state)
    return {
        "phase": "installing",
        "canonicalization_recovered": name,
        "flags_closed": True,
    }


def verify(r, *, review_enabled=False):
    require(type(review_enabled) is bool, "invalid_review_verification")
    state = r.read_private("state.json")
    require(
        state["phase"] in ("closed", "open", "close", "rollback")
        and not state.get("in_flight"),
        "incomplete_stage",
    )
    require(r.schema()["rows"] == state["schema"], "migration_history_changed")
    r.node_check()
    require(gateway(r) == state["gateway"], "gateway_changed")
    pods = []
    for name, expected in state["expected"].items():
        current = r.api("get", expected["kind"], name, "-n", "meet", "-o", "json")
        require(
            current["metadata"]["uid"] == expected["metadata"]["uid"]
            and current["spec"] == expected["spec"],
            "post_rollout_drift",
        )
        if current["kind"] == "Deployment":
            require(
                current["status"].get("observedGeneration")
                == current["metadata"]["generation"]
                and current["status"].get("readyReplicas")
                == current["status"].get("updatedReplicas")
                == current["status"].get("availableReplicas")
                == 1,
                "controller_unready",
            )
            selector = ",".join(
                k + "=" + v
                for k, v in current["spec"]["selector"]["matchLabels"].items()
            )
            listing = r.api("get", "pods", "-n", "meet", "-l", selector, "-o", "json")[
                "items"
            ]
            ready = [
                p
                for p in listing
                if not p["metadata"].get("deletionTimestamp")
                and any(
                    c["type"] == "Ready" and c["status"] == "True"
                    for c in p["status"].get("conditions", [])
                )
            ]
            require(len(ready) == 1, "ready_pod_ambiguous")
            p = ready[0]
            ids = [c["imageID"] for c in p["status"]["containerStatuses"]]
            require(
                ids == [r.pod_spec(expected)["containers"][0]["image"]],
                "runtime_image_mismatch",
            )
            pods.append({"name": name, "pod": p["metadata"]["name"], "image_ids": ids})
    rollout_import = (
        "from work import rollout"
        if state["phase"] != "rollback"
        else "rollout=SimpleNamespace(allows=lambda user:False)"
    )
    value = exec_json(
        r,
        """import json,configurations
configurations.setup()
from django.conf import settings
from core.models import User
from types import SimpleNamespace
"""
        + rollout_import
        + """
from meet.celery_app import app
u=User.objects.get(id="""
        + repr(state["account"])
        + """)
outsider=SimpleNamespace(is_authenticated=True,is_active=True,sub='synthetic-only',is_device=False,pk='00000000-0000-0000-0000-000000000001')
reply=app.control.inspect(timeout=5).ping() or {}
print('COHORT_JSON'+json.dumps({'mode':getattr(settings,'WORK_AGENT_ROLLOUT_MODE','closed'),'allowed_users':len(getattr(settings,'WORK_AGENT_ALLOWED_USER_IDS',[])),'flags':{name:getattr(settings,name) for name in """
        + repr(FLAGS)
        + """},'owner_admitted':rollout.allows(u),'outsider_admitted':rollout.allows(outsider),'celery_pong_count':sum(v.get('ok')=='pong' for v in reply.values())}))
""",
    )
    require(
        value["outsider_admitted"] is False and value["celery_pong_count"] >= 2,
        "cohort_or_workers_failed",
    )
    require(
        value["owner_admitted"] == (state["phase"] == "open"),
        "owner_admission_mismatch",
    )
    require(
        value["flags"]["WORK_AGENT_ENABLED"] is False
        and value["flags"]["WORK_REVIEW_ENABLED"]
        is (review_enabled and state["phase"] == "open"),
        "cloud_or_pi_enabled",
    )
    if state["phase"] != "open":
        require(
            not any(value["flags"].values())
            and value["mode"] == "closed"
            and value["allowed_users"] == 0,
            "finish_not_closed",
        )
    else:
        require(
            value["flags"]["WORK_LOCAL_AGENT_ENABLED"]
            and value["flags"]["WORK_REMOTE_AGENT_ENABLED"]
            and value["mode"] == "allowlist"
            and value["allowed_users"] == 1,
            "open_state_mismatch",
        )
    health = []
    for pod in pods:
        if pod["name"] not in ("meet-backend", "meet-backend-ai"):
            continue
        port = r.pod_spec(state["expected"][pod["name"]])["containers"][0]["ports"][0][
            "containerPort"
        ]
        code = (
            "import json,socket,urllib.request\nhealth={}\nfor path in ('/__heartbeat__','/__lbheartbeat__'):\n req=urllib.request.Request('http://127.0.0.1:"
            + str(port)
            + "'+path,headers={'Host':socket.gethostbyname(socket.gethostname())})\n with urllib.request.urlopen(req,timeout=10) as response:health[path]=response.status\nassert all(v==200 for v in health.values())\nprint(json.dumps(health))\n"
        )
        r.run(
            r.K + ["exec", "-i", "-n", "meet", pod["pod"], "--", "python", "-"],
            code.encode(),
        )
        health.append({"deployment": pod["name"], "both_health_checks": 200})
    return {
        "phase": state["phase"],
        "controllers_verified": 7,
        "pods": pods,
        "runtime": value,
        "health": health,
        "gateway_unchanged": True,
        "schema_unchanged": True,
        "provider_calls_by_rollout": 0,
    }


def main():
    global ROOT
    import fcntl

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "phase",
        choices=("prepare", "closed", "open", "close", "rollback", "verify", "recover"),
    )
    parser.add_argument("--candidate")
    parser.add_argument("--release-id", default=DEFAULT_RELEASE_ID)
    args = parser.parse_args()
    require(os.geteuid() == 0, "root_required")
    ROOT = release_root(args.release_id)
    require(
        all(not path.is_symlink() for path in (ROOT, *ROOT.parents)),
        "unsafe_state_parent",
    )
    r = load_runtime()
    parent = ROOT.parent
    require(parent.is_dir() and not parent.is_symlink(), "unsafe_parent")
    # Keep the legacy lock shared across releases; fresh snapshots cannot overlap.
    lock_path = parent / "cohort-e92f9eec4.lock"
    require(not lock_path.is_symlink(), "unsafe_lock")
    with lock_path.open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.phase == "prepare":
            result = prepare(r, json.loads(Path(args.candidate).read_text()))
        elif args.phase == "verify":
            result = verify(r)
        elif args.phase == "recover":
            result = recover(r)
        else:
            result = rollout(r, args.phase)
    print("PUBLIC_RESULT_BEGIN", flush=True)
    print(json.dumps(result, indent=2), flush=True)
    print("PUBLIC_RESULT_END", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - redact all sensitive subprocess failures
        # Never emit Kubernetes response/stdout/stderr, env, OTP or account IDs.
        print(
            json.dumps(
                {
                    "failed": True,
                    "error_type": type(error).__name__,
                    "reason": str(error)
                    if type(error) is RuntimeError
                    else "operation_failed",
                }
            ),
            flush=True,
        )
        raise SystemExit(1)
