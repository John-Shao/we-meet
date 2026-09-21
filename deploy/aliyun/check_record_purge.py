"""Check every live backend/worker/beat pod before preparing permanent deletion."""

import argparse
import json
from pathlib import Path
import subprocess
import sys


def run(command, *, input=None):
    result = subprocess.run(
        command, input=input, capture_output=True, text=True, timeout=90
    )
    if result.returncode:
        # Only probe JSON is safe to relay; do not echo kubectl/provider stderr.
        for line in result.stdout.splitlines():
            if line.startswith('{"'):
                print(line)
        raise RuntimeError("command_failed (check kubectl access or probe result)")
    return result.stdout


def checked_pods(deployment, pods, expected_image):
    wanted = deployment["spec"].get("replicas", 1)
    status = deployment.get("status", {})
    if (
        wanted < 1
        or status.get("observedGeneration", 0) < deployment["metadata"]["generation"]
    ):
        raise RuntimeError("deployment_not_observed")
    if any(
        status.get(field, 0) != wanted
        for field in (
            "replicas",
            "updatedReplicas",
            "readyReplicas",
            "availableReplicas",
        )
    ):
        raise RuntimeError("deployment_not_fully_rolled_out")
    if len(pods) != wanted or any(p["metadata"].get("deletionTimestamp") for p in pods):
        raise RuntimeError("old_or_terminating_pods_present")
    results = []
    for pod in pods:
        if pod["status"].get("phase") != "Running" or not any(
            c["type"] == "Ready" and c["status"] == "True"
            for c in pod["status"].get("conditions", [])
        ):
            raise RuntimeError("pod_not_ready")
        containers = [
            c for c in pod["spec"]["containers"] if c["image"] == expected_image
        ]
        if len(containers) != 1:
            raise RuntimeError("unexpected_pod_image")
        container = containers[0]["name"]
        states = [
            s
            for s in pod["status"].get("containerStatuses", [])
            if s["name"] == container
        ]
        if (
            len(states) != 1
            or not states[0].get("ready")
            or not states[0].get("imageID")
        ):
            raise RuntimeError("container_not_ready")
        results.append((pod["metadata"]["name"], container, states[0]["imageID"]))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--namespace", default="meet")
    parser.add_argument("--release", default="meet")
    parser.add_argument("--expected-backend-tag", required=True)
    parser.add_argument("--expect-enabled", action="store_true")
    parser.add_argument(
        "--storage-canary",
        action="store_true",
        help="Create and delete only two fresh probe objects per API/worker pod",
    )
    args = parser.parse_args()
    kubectl = ["kubectl", "--request-timeout=20s", "-n", args.namespace]
    payload = (
        Path(__file__).with_name("record_purge_probe.py").read_text(encoding="utf-8")
    )
    digests = set()
    for component in ("backend", "celery-backend", "celery-beat"):
        name = f"{args.release}-{component}"
        dep = json.loads(run(kubectl + ["get", "deployment", name, "-o", "json"]))
        images = [
            c["image"]
            for c in dep["spec"]["template"]["spec"]["containers"]
            if c["image"].endswith(":" + args.expected_backend_tag)
        ]
        if len(images) != 1:
            raise RuntimeError("unexpected_deployment_image: " + name)
        labels = dep["spec"]["selector"]["matchLabels"]
        selector = ",".join(f"{key}={value}" for key, value in labels.items())
        pods = json.loads(run(kubectl + ["get", "pods", "-l", selector, "-o", "json"]))[
            "items"
        ]
        for pod, container, digest in checked_pods(dep, pods, images[0]):
            digests.add(digest)
            options = ["--expect-enabled"] if args.expect_enabled else []
            if component == "celery-backend":
                options.append("--worker")
            if args.storage_canary and component != "celery-beat":
                options.append("--canary")
            output = run(
                kubectl
                + ["exec", "-i", pod, "-c", container, "--", "python", "-", *options],
                input=payload,
            )
            reports = [
                json.loads(line)
                for line in output.splitlines()
                if line.startswith('{"ok":')
            ]
            if len(reports) != 1 or reports[0].get("ok") is not True:
                raise RuntimeError("probe_report_missing: " + pod)
            print(json.dumps({"pod": pod, **reports[0]}), flush=True)
            if component == "celery-beat":
                logs = run(
                    kubectl
                    + ["logs", pod, "-c", container, "--since=3m", "--tail=1000"]
                )
                if "Sending due task purge-requested-records" not in logs:
                    raise RuntimeError("recent_beat_dispatch_not_observed")
                print("Recent beat purge dispatch: confirmed")
    if len(digests) != 1:
        raise RuntimeError("backend_worker_beat_digest_mismatch")
    print("PASS: runtime prerequisites verified; no flags changed or records purged.")
    if not args.storage_canary:
        print(
            "Storage write/delete permissions NOT tested; rerun with --storage-canary before enabling."
        )


if __name__ == "__main__":
    try:
        main()
    except (
        RuntimeError,
        subprocess.TimeoutExpired,
        OSError,
        KeyError,
        ValueError,
    ) as exc:
        print(
            "BLOCKED: "
            + (str(exc) if type(exc) is RuntimeError else type(exc).__name__)
        )
        sys.exit(1)
