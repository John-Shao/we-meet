"""One new synthetic unknown-evidence sample; never replay the initial batch."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

if "work_k3s_acceptance" not in sys.modules:
    spec = importlib.util.spec_from_file_location(
        "work_k3s_acceptance", Path(__file__).with_name("accept-work-k3s-production.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules[spec.name] = module
h = sys.modules["work_k3s_acceptance"]


def require_new_sample(initial, calls, ledger_exists):
    h.require(not ledger_exists, "sample_already_started_do_not_replay")
    h.require(initial["supplier_calls"] == calls == 3, "unexpected_supplier_usage")
    h.require(initial["supplier_call_ceiling"] == 5, "unexpected_authorization_ceiling")
    h.require(len(initial["samples"]) == 3, "unexpected_initial_batch")


def execute():
    h.require(os.name == "posix" and os.geteuid() == 0, "linux_root_required")
    os.umask(0o077)
    initial = json.loads((h.ROOT / "acceptance.json").read_text())
    output = h.ROOT / "unknown-evidence-sample.json"
    # Refuse an uncertain previous admission before creating any resources.
    h.require(not output.exists(), "sample_already_started_do_not_replay")
    state = json.loads((h.ROOT / "state.json").read_text())
    h.require(initial["release_id"] == state["id"], "release_mismatch")
    code = """import sqlite3,json
from contextlib import closing
with closing(sqlite3.connect('file:/var/lib/we-meet-work-review/jobs.sqlite3?mode=ro',uri=True)) as db:
 assert db.execute("SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running')").fetchone()[0]==0
 print(json.dumps({'calls':db.execute('SELECT COUNT(*) FROM model_calls').fetchone()[0]}))
"""
    calls = json.loads(h.python(h.gateway_pod(), code))["calls"]
    require_new_sample(initial, calls, output.exists())
    body = h.request(
        "判断该系统的实际最大并发人数是否达到100人。只根据当前文件；文件未记载的实测参数不得推断。",
        "# 概况\n这是一个用于团队协作的测试系统。\n",
    )
    report = {
        "release_id": state["id"],
        "phase": "prepared",
        "run_id": body["run_id"],
        "name": "unknown_measurement",
        "expected_verdict": "inconclusive",
        "request": body,
        "supplier_calls_before": calls,
        "supplier_call_ceiling": 5,
    }

    def save():
        temp = output.with_suffix(".tmp")
        with temp.open("w") as stream:
            json.dump(report, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, output)

    client = None
    admitted = False
    save()
    try:
        values = json.loads((h.ROOT / "values.json").read_text())["workAgent"]["image"]
        client = h.create_probe(
            h.pod(
                "wa-unknown-client-" + state["id"][:8],
                "meet",
                values["repository"] + "@" + values["digest"],
                state["id"],
                client=True,
            ),
            state["id"],
        )
        report["probe"] = client
        save()
        h.wait_probe(client)
        report["phase"] = "admitting"
        save()
        admitted = True
        h.submit(client, body)
        job = h.poll(client, body["run_id"])
        report.update(
            state=job["state"],
            metering=job["metering"],
            error_code=job.get("error_code"),
        )
        save()
        h.require(job["state"] == "succeeded", "sample_failed")
        h.require(
            job["metering"]["calls"] == 1 and job["metering"]["complete"],
            "usage_unknown",
        )
        artifact = next(
            a for a in job["result"]["artifacts"] if a["name"] == "pi-review.json"
        )
        h.require(
            hashlib.sha256(artifact["text"].encode()).hexdigest() == artifact["sha256"],
            "artifact_checksum_mismatch",
        )
        parsed = json.loads(artifact["text"])
        report.update(
            review=parsed,
            artifact_sha256=artifact["sha256"],
            supplier_calls_total=calls + job["metering"]["calls"],
        )
        save()
        h.require(
            parsed["verdict"] == "inconclusive" and parsed["missing_information"],
            "unknown_evidence_verdict_mismatch",
        )
        report["business_after"] = h.business_health(state)
        report["phase"] = "verified"
    except BaseException as error:
        report["phase"] = "failed"
        report["failure"] = (
            str(error) if isinstance(error, h.AcceptanceError) else type(error).__name__
        )
        if admitted:
            try:
                h.call(client, "POST", "/v1/jobs/" + body["run_id"] + "/cancel", {})
            except Exception:
                pass
        raise
    finally:
        if client:
            try:
                h.cleanup(client, state["id"])
            except Exception:
                report["cleanup_pending"] = client
        save()
        print("PUBLIC_RESULT_BEGIN")
        print(json.dumps(report, indent=2))
        print("PUBLIC_RESULT_END")


if __name__ == "__main__":
    try:
        execute()
    except Exception as error:
        h.emit(
            "sample_failed",
            reason=str(error)
            if isinstance(error, h.AcceptanceError)
            else type(error).__name__,
        )
        raise SystemExit(1)
