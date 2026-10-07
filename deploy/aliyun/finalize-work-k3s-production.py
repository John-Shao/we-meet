"""Finish infrastructure checks without submitting or replaying model jobs.

Keep the initial acceptance receipt intact, including any label mismatch.
Only create temporary network probes, then delete them with UID preconditions.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

if "work_k3s_acceptance" not in sys.modules:
    spec = importlib.util.spec_from_file_location(
        "work_k3s_acceptance", Path(__file__).with_name("accept-work-k3s-production.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules[spec.name] = module
h = sys.modules["work_k3s_acceptance"]


def snapshot():
    return json.loads(
        h.python(
            h.gateway_pod(),
            """import json,sqlite3
from contextlib import closing
with closing(sqlite3.connect('file:/var/lib/we-meet-work-review/jobs.sqlite3?mode=ro',uri=True)) as db:
 print(json.dumps({'model_calls':db.execute('SELECT COUNT(*) FROM model_calls').fetchone()[0],
  'jobs':db.execute('SELECT id,state FROM jobs ORDER BY id').fetchall()}))
""",
        )
    )


def execute(attempt=1):
    h.require(os.name == "posix" and os.geteuid() == 0, "linux_root_required")
    os.umask(0o077)
    source = (h.ROOT / "acceptance.json").read_bytes()
    initial = json.loads(source)
    state = json.loads((h.ROOT / "state.json").read_text())
    h.require(initial["release_id"] == state["id"], "receipt_release_mismatch")
    h.require(1 <= attempt <= 3, "invalid_attempt")
    output = h.ROOT / (
        "finalization.json" if attempt == 1 else f"finalization-{attempt}.json"
    )
    h.require(not output.exists(), "finalization_already_started")
    report = {
        "schema": "work-k3s-production-finalization/v1",
        "release_id": state["id"],
        "attempt": attempt,
        "initial_receipt_sha256": hashlib.sha256(source).hexdigest(),
        "initial_phase": initial["phase"],
        "initial_failure": initial.get("failure"),
        "additional_supplier_calls": 0,
        "phase": "checking",
        "probes": [],
    }

    def save():
        temp = output.with_suffix(".tmp")
        with temp.open("w") as stream:
            json.dump(report, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, output)

    active = []
    save()
    try:
        report["stage"] = "database_snapshot"
        save()
        before = snapshot()
        h.require(before["model_calls"] == initial["supplier_calls"], "usage_mismatch")
        h.require(
            all(
                state_ in ("succeeded", "failed", "cancelled")
                for _, state_ in before["jobs"]
            ),
            "active_model_jobs",
        )
        report["database_before"] = before
        values = json.loads((h.ROOT / "values.json").read_text())
        for role, namespace, task in (
            ("peer", "meet", False),
            ("network", h.TASKS, True),
        ):
            report["stage"] = "probe_" + role
            save()
            image = values["workAgent"]["image"]
            item = h.create_probe(
                h.pod(
                    "wa-final-" + str(attempt) + "-" + role + "-" + state["id"][:8],
                    namespace,
                    image["repository"] + "@" + image["digest"],
                    state["id"],
                    task=task,
                ),
                state["id"],
            )
            active.append(item)
            report["probes"].append(item)
            save()
            pod = h.wait_probe(item)
            if task:
                network = item
                network_ip = pod["status"]["podIP"]
            else:
                peer = item
        # An actual listening socket is the positive control for the deny probe.
        report["stage"] = "listener_positive_control"
        save()
        h.python(
            network,
            """import socket,time
deadline=time.monotonic()+10
while True:
 try:socket.create_connection(('127.0.0.1',8080),timeout=2).close();break
 except OSError:
  if time.monotonic()>=deadline:raise
  time.sleep(.2)
""",
        )
        report["stage"] = "ingress_denial"
        save()
        report["ingress"] = json.loads(
            h.python(
                peer,
                f"""import socket,json
try:socket.create_connection(({network_ip!r},8080),timeout=3).close()
except (TimeoutError,OSError):print(json.dumps({{'task_port_8080_blocked_from_business':True,'task_listener_positive':True}}))
else:raise AssertionError('task ingress allowed')
""",
            )
        )
        report["stage"] = "final_health"
        save()
        after = snapshot()
        h.require(before == after, "jobs_or_supplier_calls_changed")
        report["database_after"] = after
        report["business_after"] = h.business_health(state)
        deployments = h.api("get", "deployments", "-n", "meet", "-o", "json")["items"]
        backend = next(
            d for d in deployments if d["metadata"]["name"] == "meet-backend"
        )
        selector = backend["spec"]["selector"]["matchLabels"]
        pods = h.api(
            "get",
            "pods",
            "-n",
            "meet",
            "-l",
            ",".join(k + "=" + v for k, v in selector.items()),
            "-o",
            "json",
        )["items"]
        h.require(len(pods) == 1, "unexpected_backend_replica_count")
        report["business_flags"] = json.loads(
            h.python(
                {"namespace": "meet", "name": pods[0]["metadata"]["name"]},
                "import os,json\nprint(json.dumps({k:os.getenv(k) for k in ('WORK_AGENT_ENABLED','WORK_REVIEW_ENABLED')}))",
            )
        )
        h.require(
            all(
                v in (None, "false", "False", "0", "")
                for v in report["business_flags"].values()
            ),
            "business_enabled",
        )
        pvc = h.api("get", "pvc", "meet-work-review-state", "-n", h.GW, "-o", "json")
        h.require(pvc["status"]["phase"] == "Bound", "state_pvc_unbound")
        report["pvc"] = {
            "name": pvc["metadata"]["name"],
            "phase": "Bound",
            "capacity": pvc["status"]["capacity"],
        }
        services = h.api("get", "service", h.GW, "-n", h.GW, "-o", "json")
        h.require(services["spec"]["type"] == "ClusterIP", "unexpected_public_service")
        ingress = h.api("get", "ingress", "-n", h.GW, "-o", "json")["items"]
        h.require(not ingress, "unexpected_gateway_ingress")
        h.gateway_pod()
        report["gateway"] = {
            "running": True,
            "service_type": "ClusterIP",
            "public_ingress": False,
        }
        status = h.run(
            [
                "curl",
                "--silent",
                "--show-error",
                "--output",
                "/dev/null",
                "--max-time",
                "15",
                "--write-out",
                "%{http_code}",
                "https://meet.we-meet.online",
            ]
        ).decode()
        h.require(status == "200", "frontend_https_failed")
        report["frontend_https"] = {
            "host": "meet.we-meet.online",
            "status": 200,
            "certificate_validation": True,
        }
        report["phase"] = "infrastructure_verified_model_label_review_required"
    except BaseException as error:
        report["phase"] = "failed"
        report["failure"] = (
            str(error) if isinstance(error, h.AcceptanceError) else type(error).__name__
        )
        raise
    finally:
        for item in reversed(active):
            try:
                h.cleanup(item, state["id"])
            except Exception:
                report.setdefault("cleanup_pending", []).append(item)
        deadline = time.monotonic() + 15
        while True:
            remaining = h.api(
                "get",
                "pods",
                "--all-namespaces",
                "-l",
                "work-agent-acceptance=true",
                "-o",
                "json",
            )["items"]
            if not remaining or time.monotonic() >= deadline:
                break
            time.sleep(1)
        report["probe_cleanup_verified"] = not remaining
        save()
        print("PUBLIC_RESULT_BEGIN")
        print(json.dumps(report, indent=2))
        print("PUBLIC_RESULT_END")


if __name__ == "__main__":
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--attempt", type=int, default=1)
        execute(parser.parse_args().attempt)
    except Exception as error:
        h.emit(
            "finalization_failed",
            reason=str(error)
            if isinstance(error, h.AcceptanceError)
            else type(error).__name__,
        )
        raise SystemExit(1)
