"""Preserve live Work settings across ordinary business releases.

Snapshots and exports are private. Only fixed error codes/counts go to logs.
Agent setting changes use the separately fenced cohort operation first.
"""

import argparse
import copy
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path

import yaml

SUFFIXES = (
    "-backend",
    "-backend-ai",
    "-celery-backend",
    "-celery-beat",
    "-celery-work",
    "-backend-docs-profiles",
    "-backend-reminders",
)
FLAGS = {
    "WORK_AGENT_ENABLED",
    "WORK_LOCAL_AGENT_ENABLED",
    "WORK_REMOTE_AGENT_ENABLED",
    "WORK_REVIEW_ENABLED",
}


def controlled(name):
    return name.startswith(("WORK_AGENT_", "WORK_REVIEW_")) or name in FLAGS


def normalize(value):
    result = copy.deepcopy(value)
    if isinstance(result, dict):
        for ref in ("secretKeyRef", "configMapKeyRef"):
            if (
                isinstance(result.get(ref), dict)
                and result[ref].get("optional") is False
            ):
                result[ref].pop("optional")
    return result


def agent_env(resource):
    spec = resource["spec"]
    if resource["kind"] == "CronJob":
        spec = spec["jobTemplate"]["spec"]
    containers = spec["template"]["spec"]["containers"]
    if len(containers) != 1:
        raise ValueError("cohort_unexpected_sidecar")
    result = {}
    for entry in containers[0].get("env", []):
        name = entry["name"]
        if controlled(name):
            if name in result:
                raise ValueError("cohort_duplicate_env")
            value = entry.get("valueFrom", entry.get("value", ""))
            if name.endswith("_TOKEN") and isinstance(value, str) and value:
                raise ValueError("cohort_inline_credentials_forbidden")
            result[name] = normalize(value)
    return result


def consumers(snapshot, release, namespace):
    names = {release + s for s in SUFFIXES}
    rows = {}
    for row in snapshot["items"]:
        name = row["metadata"]["name"]
        if name not in names or row["kind"] not in ("Deployment", "CronJob"):
            continue
        if row["metadata"].get("namespace") != namespace or name in rows:
            raise ValueError("cohort_consumer_identity_mismatch")
        rows[name] = row
    if release + "-backend" not in rows:
        raise ValueError("cohort_backend_missing")
    return rows


def settings(snapshot, release, namespace):
    rows = consumers(snapshot, release, namespace)
    expected = agent_env(rows[release + "-backend"])
    if any(agent_env(row) != expected for row in rows.values()):
        raise ValueError("cohort_consumer_settings_drift")
    configured = (
        any(str(expected.get(k, "")).lower() in ("true", "1") for k in FLAGS)
        or expected.get("WORK_AGENT_ROLLOUT_MODE", "closed") != "closed"
        or any(expected.get(k) for k in ("WORK_AGENT_URL", "WORK_REVIEW_URL"))
    )
    if configured and len(rows) != len(SUFFIXES):
        raise ValueError("cohort_consumer_missing")
    return rows, expected, configured


def check(snapshot, values, release="meet", namespace="meet"):
    rows, expected, configured = settings(snapshot, release, namespace)
    if values is None:
        if configured:
            raise ValueError("cohort_complete_overlay_required")
    else:
        if not isinstance(values, dict) or not isinstance(values.get("backend"), dict):
            raise ValueError("cohort_overlay_scope_invalid")
        actual = values.get("backend", {}).get("envVars", {})
        if not isinstance(actual, dict) or any(not controlled(k) for k in actual):
            raise ValueError("cohort_overlay_scope_invalid")
        if {k: normalize(v) for k, v in actual.items()} != expected:
            raise ValueError("cohort_overlay_does_not_match_live_settings")
    return rows, expected


def check_live(original, current, release, namespace):
    old, _, _ = settings(original, release, namespace)
    new, _, _ = settings(current, release, namespace)
    if old.keys() != new.keys() or any(
        old[name]["metadata"]["uid"] != new[name]["metadata"]["uid"]
        or agent_env(old[name]) != agent_env(new[name])
        for name in old
    ):
        raise ValueError("cohort_changed_since_snapshot")


def check_render(resources, snapshot, release, namespace):
    rows, expected, _ = settings(snapshot, release, namespace)
    rendered = consumers({"items": resources}, release, namespace)
    if rows.keys() != rendered.keys() or any(
        agent_env(row) != expected for row in rendered.values()
    ):
        raise ValueError("cohort_rendered_settings_changed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--values-file")
    parser.add_argument("--release", default="meet")
    parser.add_argument("--namespace", default="meet")
    parser.add_argument("--check-live", action="store_true")
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--export")
    args = parser.parse_args()
    try:
        snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf8"))
        if args.export:
            _, expected, _ = settings(snapshot, args.release, args.namespace)
            target = Path(args.export)
            if any(p.is_symlink() for p in (target, *target.parents)):
                raise ValueError("cohort_unsafe_export_path")
            temp = target.with_name(target.name + "." + secrets.token_hex(8) + ".tmp")
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf8") as stream:
                json.dump({"backend": {"envVars": expected}}, stream)
            temp.replace(target)
        else:
            path = Path(args.values_file) if args.values_file else None
            values = (
                yaml.safe_load(path.read_text(encoding="utf8"))
                if path and path.is_file()
                else None
            )
            rows, _ = check(snapshot, values, args.release, args.namespace)
            if args.check_live:
                live = subprocess.run(
                    [
                        "kubectl",
                        "-n",
                        args.namespace,
                        "get",
                        "deployment,cronjob",
                        "-o",
                        "json",
                    ],
                    check=True,
                    capture_output=True,
                    timeout=20,
                )
                check_live(
                    snapshot, json.loads(live.stdout), args.release, args.namespace
                )
            if args.render:
                resources = [v for v in yaml.safe_load_all(sys.stdin) if v]
                check_render(resources, snapshot, args.release, args.namespace)
                sys.stdout.write(yaml.safe_dump_all(resources, sort_keys=False))
            else:
                print(
                    json.dumps(
                        {"work_settings_preserved": True, "consumers": len(rows)}
                    )
                )
    except (
        ValueError,
        KeyError,
        TypeError,
        OSError,
        subprocess.SubprocessError,
    ) as error:
        code = (
            str(error)
            if isinstance(error, ValueError) and str(error).startswith("cohort_")
            else "cohort_check_failed"
        )
        parser.exit(1, code + "\n")


if __name__ == "__main__":
    main()
