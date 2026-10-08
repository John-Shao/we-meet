"""Upgrade the independent gateway only while its account cohort is closed."""

import argparse
import copy
import importlib.util
import json
import os
import re
from pathlib import Path


def target_for(current, gateway_image, worker_image):
    for family, image in (("gateway", gateway_image), ("pi", worker_image)):
        if not re.fullmatch(
            r"jusi-cn-guangzhou\.cr\.volces\.com/we-meet/work-agent-"
            + family
            + r"@sha256:[a-f0-9]{64}",
            image,
        ):
            raise RuntimeError("immutable_agent_image_required")
    target = copy.deepcopy(current)
    containers = target["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1:
        raise RuntimeError("unexpected_gateway_sidecar")
    container = containers[0]
    arguments = container.get("args", [])
    if arguments.count("--image") != 1 or arguments.index("--image") + 1 >= len(
        arguments
    ):
        raise RuntimeError("unexpected_worker_reference")
    container["image"] = gateway_image
    arguments[arguments.index("--image") + 1] = worker_image
    return target


def main():
    import fcntl

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--gateway-image", required=True)
    parser.add_argument("--worker-image", required=True)
    parser.add_argument("--adapter-version", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.adapter_version):
        raise RuntimeError("invalid_adapter_version")
    prefix = "gateway-" + args.adapter_version
    spec = importlib.util.spec_from_file_location(
        "cohort", Path(__file__).with_name("work-account-cohort.py")
    )
    c = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(c)
    c.require(os.geteuid() == 0, "root_required")
    c.ROOT = c.release_root(args.release_id)
    c.require(
        all(not p.is_symlink() for p in (c.ROOT, *c.ROOT.parents)),
        "unsafe_state_parent",
    )
    r = c.load_runtime()
    lock = c.ROOT.parent / "cohort-e92f9eec4.lock"
    c.require(not lock.is_symlink(), "unsafe_lock")
    with lock.open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = r.read_private("state.json")
        c.require(
            state["phase"] in {"close", "closed"} and not state.get("in_flight"),
            "close_cohort_first",
        )
        c.verify(r)
        c.require(
            not (c.ROOT / (prefix + "-runtime-before.json")).exists(),
            "gateway_upgrade_already_started",
        )
        current = r.api(
            "get",
            "deployment",
            "meet-work-review",
            "-n",
            "meet-work-review",
            "-o",
            "json",
        )
        target = target_for(current, args.gateway_image, args.worker_image)
        patch = c.patch_for(current, current, target)
        pods = r.api(
            "get",
            "pods",
            "-n",
            "meet-work-review",
            "-l",
            "app.kubernetes.io/name=meet-work-review",
            "-o",
            "json",
        )["items"]
        c.require(len(pods) == 1, "gateway_pod_count_changed")
        backup_code = """import json,sqlite3,os,hashlib
from pathlib import Path
from contextlib import closing
root=Path('/var/lib/we-meet-work-review')
backup=root/BACKUP_NAME
assert not backup.exists()
os.umask(0o077)
uri='file:'+str(root/'jobs.sqlite3')+'?mode=ro'
with closing(sqlite3.connect(uri,uri=True)) as db:
 active="SELECT COUNT(*) FROM jobs WHERE state IN ('running','queued')"
 assert db.execute(active).fetchone()[0]==0
 with closing(sqlite3.connect(backup)) as destination:db.backup(destination)
with closing(sqlite3.connect(backup)) as db:
 assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
print('UPGRADE_JSON'+json.dumps({'quiescent':True,'quick_check':'ok',
 'sha256':hashlib.sha256(backup.read_bytes()).hexdigest()}))
"""
        backup_code = backup_code.replace(
            "BACKUP_NAME", repr("upgrade-" + args.adapter_version + "-before.db")
        )
        output = r.run(
            r.K
            + [
                "exec",
                "-i",
                "-n",
                "meet-work-review",
                pods[0]["metadata"]["name"],
                "--",
                "python",
                "-",
            ],
            backup_code.encode(),
            timeout=30,
        )
        backup = json.loads(
            next(
                line[12:]
                for line in output.decode().splitlines()
                if line.startswith("UPGRADE_JSON")
            )
        )
        r.write_private(prefix + "-database-backup.json", backup)
        r.write_private(prefix + "-runtime-before.json", current)
        r.write_private(prefix + "-runtime-target.json", target)
        applied = r.api(
            "patch",
            "deployment",
            "meet-work-review",
            "-n",
            "meet-work-review",
            "--type=json",
            "--patch-file=/dev/stdin",
            "-o",
            "json",
            body=json.dumps(patch).encode(),
        )
        c.require(applied["spec"] == target["spec"], "gateway_patch_mismatch")
        try:
            r.run(
                r.K
                + [
                    "rollout",
                    "status",
                    "deployment/meet-work-review",
                    "-n",
                    "meet-work-review",
                    "--timeout=180s",
                ],
                timeout=200,
            )
            caps = c.exec_json(
                r,
                """import json,configurations
configurations.setup()
from django.conf import settings
from work.agent_client import AgentClient
x=AgentClient(settings.WORK_REVIEW_URL,settings.WORK_REVIEW_TOKEN,
 ca_pem=settings.WORK_REVIEW_CA_PEM).capabilities()
print('COHORT_JSON'+json.dumps(x))
""",
            )
            c.require(
                caps["contract"] == "work-agent/v1"
                and caps["adapter_version"] == args.adapter_version
                and caps["runtime_version"] == "1.0.4"
                and caps["engine"] == "pi"
                and caps["model"] == "qwen3.8-flash"
                and caps["image"] == args.worker_image
                and "readonly_review_v1" in caps["features"],
                "new_gateway_contract_mismatch",
            )
        except Exception:
            live = r.api(
                "get",
                "deployment",
                "meet-work-review",
                "-n",
                "meet-work-review",
                "-o",
                "json",
            )
            reverse = c.patch_for(live, applied, current)
            r.api(
                "patch",
                "deployment",
                "meet-work-review",
                "-n",
                "meet-work-review",
                "--type=json",
                "--patch-file=/dev/stdin",
                "-o",
                "json",
                body=json.dumps(reverse).encode(),
            )
            r.run(
                r.K
                + [
                    "rollout",
                    "status",
                    "deployment/meet-work-review",
                    "-n",
                    "meet-work-review",
                    "--timeout=180s",
                ],
                timeout=200,
            )
            raise
        history = state.setdefault("gateway_history", [])
        if not history and state.get("gateway_previous"):
            history.append(state["gateway_previous"])
        history.append(state["gateway"])
        state["gateway_previous"] = state["gateway"]
        state["gateway"] = c.gateway(r)
        r.write_private("state.json", state)
        r.write_private(
            prefix + "-runtime-upgrade.json",
            {
                "gateway_image": args.gateway_image,
                "worker_image": args.worker_image,
                "caps": caps,
            },
        )
        result = c.verify(r)
        result.update(
            gateway_image=args.gateway_image,
            worker_image=args.worker_image,
            adapter_version=caps["adapter_version"],
            gateway_upgraded=True,
            provider_calls=0,
            gateway_backup=backup,
        )
    print("PUBLIC_RESULT_BEGIN")
    print(json.dumps(result, indent=2))
    print("PUBLIC_RESULT_END")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(
            json.dumps(
                {
                    "failed": True,
                    "reason": "gateway_upgrade_failed_inspect_private_state",
                    "cohort_remains_closed": True,
                }
            )
        )
        raise SystemExit(1) from None
