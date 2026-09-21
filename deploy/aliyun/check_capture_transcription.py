"""Read one capture ASR receipt without exposing content, credentials or URLs."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def counts_report(job, inputs=None):
    """Project known receipt fields; never return raw provider reports or inputs."""
    inputs = (job.inputs or {}) if inputs is None else inputs
    receipt = job.report or {}
    chunks = inputs.get("chunks", [])
    tasks = receipt.get("tasks", [])
    expected_samples = sum(c["duration_ms"] * 16 for c in chunks)
    observed_samples = sum(t["input_samples"] for t in tasks)
    return {
        "job_id": str(job.pk),
        "capture_id": str(job.capture_id),
        "status": job.status,
        "mode": "live" if job.configuration.get("mode") == "live" else "sealed",
        "started": job.started_at is not None,
        "terminal_receipt_present": bool(job.finish_hash),
        "input_count": len(chunks),
        "acknowledged_inputs": job.acknowledged_inputs,
        "final_count": job.final_sequence,
        "receipt_final_count": receipt.get("final_sequence"),
        "provider_finished": receipt.get("provider_finished"),
        "expected_runs": inputs.get("runs"),
        "observed_tasks": len(tasks),
        "finished_tasks": sum(t.get("finished") is True for t in tasks),
        "expected_samples": expected_samples,
        "observed_samples": observed_samples,
        "input_samples_match": expected_samples == observed_samples,
    }


def probe(job_id):
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "meet.settings")
    os.environ.setdefault("DJANGO_CONFIGURATION", "Production")
    import configurations

    configurations.setup()
    from django.db import connection, transaction
    from core import models
    from core.services import capture_live_inputs

    # Prevent accidental model hooks or future edits from mutating this database.
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION READ ONLY")
        job = models.CaptureTranscriptionJob.objects.get(pk=job_id)
        report = counts_report(job, capture_live_inputs.inputs(job))
        report["record_id"] = str(job.capture.record_id)
    print(json.dumps({"ok": True, **report}))


def run(command, *, payload=None):
    result = subprocess.run(
        command, input=payload, capture_output=True, text=True, timeout=60
    )
    if result.returncode:
        # kubectl/provider exception bodies may contain credentials or URLs.
        raise RuntimeError("diagnostic_command_failed")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", required=True, type=uuid.UUID)
    parser.add_argument("--namespace", default="meet")
    parser.add_argument("--release", default="meet")
    parser.add_argument("--inside-pod", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.inside_pod:
        probe(args.job)
        return
    kubectl = ["kubectl", "--request-timeout=20s", "-n", args.namespace]
    backend = args.release + "-backend"
    for name in (backend, args.release + "-agent-capture-asr"):
        dep = json.loads(run(kubectl + ["get", "deployment", name, "-o", "json"]))
        print(
            json.dumps(
                {
                    "deployment": name,
                    "ready_replicas": dep.get("status", {}).get("readyReplicas", 0),
                    "images": [
                        c["image"]
                        for c in dep["spec"]["template"]["spec"]["containers"]
                    ],
                }
            ),
            flush=True,
        )
    dep = json.loads(run(kubectl + ["get", "deployment", backend, "-o", "json"]))
    containers = dep["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1:
        raise RuntimeError("ambiguous_backend_container")
    output = run(
        kubectl
        + [
            "exec",
            "-i",
            "deployment/" + backend,
            "-c",
            containers[0]["name"],
            "--",
            "python",
            "-",
            "--inside-pod",
            "--job",
            str(args.job),
        ],
        payload=Path(__file__).read_text(encoding="utf-8"),
    )
    reports = [
        json.loads(line) for line in output.splitlines() if line.startswith('{"ok":')
    ]
    if len(reports) != 1 or reports[0].get("ok") is not True:
        raise RuntimeError("diagnostic_report_missing")
    print(json.dumps(reports[0]))
    print("READ ONLY: no jobs retried, records changed, or provider requests made.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # No exception text: database/network errors may include sensitive values.
        print(json.dumps({"ok": False, "error_type": type(exc).__name__}))
        sys.exit(1)
