"""Connect the existing private Pi service to the reviewed account cohort."""

import argparse
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path

URL = "https://meet-work-review.meet-work-review.svc.cluster.local:8444"
MODEL = "qwen3.8-flash"
# The gateway reserves UTF-8 request bytes plus output before calling Qwen.
# Pi adds RPC/system context; the tiny report alone is not the request size.
BUDGET = "20000"


def settings_entries():
    return [
        {"name": "WORK_REVIEW_ENABLED", "value": "True"},
        {"name": "WORK_REVIEW_URL", "value": URL},
        {"name": "WORK_REVIEW_MODEL", "value": MODEL},
        {"name": "WORK_REVIEW_TOKEN_BUDGET", "value": BUDGET},
        {
            "name": "WORK_REVIEW_TOKEN",
            "valueFrom": {
                "secretKeyRef": {
                    "name": "meet-work-review-client",
                    "key": "WORK_AGENT_TOKEN",
                }
            },
        },
        {
            "name": "WORK_REVIEW_CA_PEM",
            "valueFrom": {
                "secretKeyRef": {
                    "name": "meet-work-review-client-ca",
                    "key": "ca.crt",
                }
            },
        },
    ]


def with_review(item):
    result = copy.deepcopy(item)
    spec = result["spec"]
    if item["kind"] == "CronJob":
        spec = spec["jobTemplate"]["spec"]
    containers = spec["template"]["spec"]["containers"]
    if len(containers) != 1:
        raise RuntimeError("unexpected_sidecar")
    env = containers[0].setdefault("env", [])
    if len({entry["name"] for entry in env}) != len(env):
        raise RuntimeError("duplicate_env")
    additions = {entry["name"]: entry for entry in settings_entries()}
    existing = {entry["name"] for entry in env}
    containers[0]["env"] = [additions.get(e["name"], e) for e in env]
    containers[0]["env"].extend(
        entry for name, entry in additions.items() if name not in existing
    )
    return result


def probe(c, r):
    # Tokens never leave the host or become local files/command arguments.
    token = r.api(
        "get", "secret", "meet-work-review-client", "-n", "meet", "-o", "json"
    )
    ca = r.api(
        "get", "secret", "meet-work-review-client-ca", "-n", "meet", "-o", "json"
    )
    code = (
        "import json,configurations\nconfigurations.setup()\n"
        "from work.agent_client import AgentClient\n"
        "caps=AgentClient("
        + repr(URL)
        + ","
        + repr(base64.b64decode(token["data"]["WORK_AGENT_TOKEN"]).decode())
        + ",ca_pem="
        + repr(base64.b64decode(ca["data"]["ca.crt"]).decode())
        + ").capabilities()\nprint('COHORT_JSON'+json.dumps(caps))\n"
    )
    caps = c.exec_json(r, code)
    c.require(
        caps["contract"] == "work-agent/v1"
        and caps["engine"] == "pi"
        and caps["model"] == MODEL
        and caps["provider"] == "qwen"
        and "readonly_review_v1" in caps["features"],
        "review_gateway_mismatch",
    )
    return caps


def overlay(c, r, state):
    env = r.pod_spec(state["expected"]["meet-backend"])["containers"][0]["env"]
    values = {
        e["name"]: e.get("valueFrom", e.get("value", ""))
        for e in env
        if e["name"].startswith(("WORK_AGENT_", "WORK_REVIEW_"))
        or e["name"] in ("WORK_LOCAL_AGENT_ENABLED", "WORK_REMOTE_AGENT_ENABLED")
    }
    r.write_private("values.work-dual.yaml", {"backend": {"envVars": values}})


def execute(c, r, phase):
    state = r.read_private("state.json")
    c.require(not state.get("in_flight"), "in_flight_requires_inspection")
    c.require(r.schema()["rows"] == state["schema"], "migration_history_changed")
    r.node_check()
    c.require(c.gateway(r) == state["gateway"], "gateway_changed")
    c.account_check(r)
    if phase == "disable":
        c.rollout(r, "close")
        overlay(c, r, r.read_private("state.json"))
        return c.verify(r)
    caps = probe(c, r)
    if phase == "enable":
        c.require(state["phase"] in ("open", "closed", "close"), "invalid_dual_stage")
        for name in c.ORDER:
            expected = state["expected"][name]
            current = r.api("get", expected["kind"], name, "-n", "meet", "-o", "json")
            target = with_review(
                c.changed(
                    expected,
                    r.pod_spec(expected)["containers"][0]["image"],
                    "open",
                    state["account"],
                )
            )
            patch = c.patch_for(current, expected, target)
            if target["spec"] == current["spec"]:
                continue
            if expected["kind"] == "Deployment":
                request = r.pod_spec(expected)["containers"][0]["resources"][
                    "requests"
                ]["cpu"]
                r.wait_headroom(
                    float(request[:-1])
                    if request.endswith("m")
                    else float(request) * 1000
                )
            state["in_flight"] = {
                "name": name,
                "target": target,
                "operation": "dual-review",
            }
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
            c.require(applied["spec"] == target["spec"], "unexpected_patch_result")
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
            r.write_private("state.json", state)
        state["phase"] = "open"
        state["dual_review"] = {"model": MODEL, "budget": int(BUDGET)}
        r.write_private("state.json", state)
        overlay(c, r, state)
    c.require(
        state.get("dual_review") == {"model": MODEL, "budget": int(BUDGET)},
        "dual_not_configured",
    )
    result = c.verify(r, review_enabled=True)
    runtime = c.exec_json(
        r,
        "import json,configurations\nconfigurations.setup()\nfrom django.conf import settings\nprint('COHORT_JSON'+json.dumps({'url':settings.WORK_REVIEW_URL,'model':settings.WORK_REVIEW_MODEL,'budget':settings.WORK_REVIEW_TOKEN_BUDGET,'token_configured':bool(settings.WORK_REVIEW_TOKEN),'ca_configured':bool(settings.WORK_REVIEW_CA_PEM)}))\n",
    )
    c.require(
        runtime
        == {
            "url": URL,
            "model": MODEL,
            "budget": int(BUDGET),
            "token_configured": True,
            "ca_configured": True,
        },
        "review_runtime_mismatch",
    )
    result.update(
        review_runtime=runtime,
        gateway_contract=caps["contract"],
        gateway_runtime=caps["runtime_version"],
        model_calls_by_configuration=0,
    )
    return result


def main():
    import fcntl

    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("enable", "verify", "disable"))
    parser.add_argument("--release-id", required=True)
    args = parser.parse_args()
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
        result = execute(c, r, args.phase)
    print("PUBLIC_RESULT_BEGIN")
    print(json.dumps(result, indent=2))
    print("PUBLIC_RESULT_END")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - do not expose private API responses
        print(
            json.dumps(
                {
                    "failed": True,
                    "error_type": type(error).__name__,
                    "reason": str(error)
                    if type(error) is RuntimeError
                    else "review_configuration_failed",
                }
            )
        )
        raise SystemExit(1)
