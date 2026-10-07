"""Helm post-renderer: preserve unselected backend specs, omit backend DB hooks.

Snapshots contain environment values. Store them in an operator-only temporary
directory on the release host, never print or check them into source control.
"""

import argparse
import copy
import json
import subprocess
import sys
from pathlib import Path

import yaml


def preserve(resources, snapshot, release):
    names = {
        release + suffix
        for suffix in (
            "-backend",
            "-backend-ai",
            "-celery-backend",
            "-celery-beat",
            "-celery-work",
            "-backend-docs-profiles",
            "-backend-reminders",
        )
    }
    originals = {
        (row["kind"], row["metadata"]["name"]): row
        for row in snapshot["items"]
        if row["metadata"]["name"] in names
    }
    if ("Deployment", release + "-backend") not in originals:
        raise ValueError("backend_snapshot_missing")
    result = []
    matched = set()
    for resource in resources:
        key = (resource["kind"], resource["metadata"]["name"])
        if resource["kind"] == "Job" and resource["metadata"]["name"] in (
            release + "-backend-migrate",
            release + "-backend-createsuperuser",
        ):
            continue
        if key in originals:
            original = originals[key]
            if resource["metadata"].get("namespace") != original["metadata"].get(
                "namespace"
            ):
                raise ValueError("backend_snapshot_namespace_mismatch")
            resource = copy.deepcopy(resource)
            resource["spec"] = copy.deepcopy(original["spec"])
            matched.add(key)
        elif resource["metadata"]["name"] in names and resource["kind"] in (
            "Deployment",
            "CronJob",
        ):
            raise ValueError("unselected_backend_resource_would_be_created")
        result.append(resource)
    if matched != set(originals):
        raise ValueError("backend_rendered_consumer_missing")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--namespace")
    parser.add_argument("--expected-image", required=True)
    parser.add_argument("--check-live", action="store_true")
    args = parser.parse_args()
    resources = [value for value in yaml.safe_load_all(sys.stdin) if value]
    try:
        snapshot = json.loads(Path(args.snapshot).read_text())
        backend = next(
            (
                row
                for row in snapshot["items"]
                if row["kind"] == "Deployment"
                and row["metadata"]["name"] == args.release + "-backend"
            ),
            None,
        )
        if (
            backend is None
            or backend["spec"]["template"]["spec"]["containers"][0]["image"]
            != args.expected_image
        ):
            raise ValueError("backend_image_changed_since_provenance_check")
        result = preserve(resources, snapshot, args.release)
        if args.check_live:
            current = subprocess.run(
                [
                    "kubectl",
                    "-n",
                    args.namespace,
                    "get",
                    "deployment,cronjob",
                    "-o",
                    "json",
                ],
                check=False,
                capture_output=True,
                timeout=20,
            )
            if current.returncode:
                raise ValueError("backend_live_check_failed")
            original = {
                (r["kind"], r["metadata"]["name"]): r for r in snapshot["items"]
            }
            live = {
                (r["kind"], r["metadata"]["name"]): r
                for r in json.loads(current.stdout)["items"]
            }
            for resource in result:
                key = (resource["kind"], resource["metadata"]["name"])
                if (
                    key in original
                    and resource.get("spec") == original[key].get("spec")
                    and (
                        key not in live
                        or live[key]["metadata"]["uid"]
                        != original[key]["metadata"]["uid"]
                        or live[key]["spec"] != original[key]["spec"]
                    )
                ):
                    raise ValueError("unselected_backend_changed_since_snapshot")
    except ValueError as exc:
        parser.exit(1, str(exc) + "\n")
    sys.stdout.write(yaml.safe_dump_all(result, sort_keys=False))


if __name__ == "__main__":
    main()
