"""Read-only shared-node K3s inventory. Never reads Secret values or deploys."""

import argparse
import json
import re
import subprocess
from decimal import Decimal


class PreflightError(ValueError):
    pass


def dns(value):
    if (
        not isinstance(value, str)
        or len(value) > 63
        or not re.fullmatch(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?", value)
    ):
        raise PreflightError("invalid_namespace")
    return value


def cpu(value):
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)(m|u|n)?", str(value))
    if not match:
        raise PreflightError("invalid_cpu_quantity")
    return (
        Decimal(match[1])
        * {None: 1000, "m": 1, "u": Decimal("0.001"), "n": Decimal("0.000001")}[
            match[2]
        ]
    )


class Reader:
    def __init__(self, context):
        if (
            not context
            or context.startswith("-")
            or len(context) > 512
            or any(ord(c) < 32 for c in context)
        ):
            raise PreflightError("explicit_context_required")
        self.context = context

    def run(self, arguments):
        result = subprocess.run(
            [
                "kubectl",
                "--context=" + self.context,
                "--request-timeout=10s",
                *arguments,
            ],
            capture_output=True,
            timeout=15,
        )
        if result.returncode or len(result.stdout) > 4_000_000:
            raise PreflightError("cluster_read_failed")
        try:
            return json.loads(result.stdout)
        except ValueError:
            raise PreflightError("cluster_read_failed") from None

    def inventory(self, kind):
        if kind not in {"nodes", "pods", "namespaces"}:
            raise PreflightError("unsupported_read")
        return self.run(["get", kind, "--all-namespaces", "-o", "json"])

    def kubelet(self, name):
        if not re.fullmatch(r"[a-z0-9]([-a-z0-9.]*[a-z0-9])?", name):
            raise PreflightError("invalid_node_name")
        return self.run(["get", "--raw=/api/v1/nodes/" + name + "/proxy/configz"])


def preflight(reader, gateway, tasks, business="meet"):
    names = [dns(name) for name in (gateway, tasks, business)]
    if len(set(names)) != 3:
        raise PreflightError("separate_namespaces_required")
    report = {
        "schema": "work-k3s-inventory/v1",
        "passed": False,
        "deployment_ready": False,
        "deployment_performed": False,
        "secrets_read": False,
        "checks": [],
        "pending_acceptance": [
            "immutable registry images and pull access",
            "TLS chain, hostname and scoped credentials",
            "PVC backup and restore",
            "actual production NetworkPolicy probes",
            "post-deploy synthetic task and provider/model access",
        ],
    }

    def check(name, action):
        try:
            value = action()
            report["checks"].append({"check": name, "passed": True})
            return value
        except PreflightError as error:
            report["checks"].append(
                {"check": name, "passed": False, "code": str(error)}
            )
        except Exception:
            report["checks"].append(
                {"check": name, "passed": False, "code": "inventory_unknown"}
            )
        return None

    namespaces = check("namespace_inventory", lambda: reader.inventory("namespaces"))
    if namespaces is not None:
        indexed = {row["metadata"]["name"]: row for row in namespaces["items"]}
        for name in names:
            row = indexed.get(name, {})
            active = row.get("status", {}).get("phase") == "Active"
            report["checks"].append(
                {
                    "check": "namespace:" + name,
                    "passed": active,
                    **({} if active else {"code": "namespace_not_provisioned"}),
                }
            )
        labels = indexed.get(tasks, {}).get("metadata", {}).get("labels", {})
        report["checks"].append(
            {
                "check": "task_pod_security",
                "passed": labels.get("pod-security.kubernetes.io/enforce")
                == "restricted",
            }
        )

    def node_check():
        rows = reader.inventory("nodes")["items"]
        if len(rows) != 1:
            raise PreflightError("shared_single_node_required")
        node = rows[0]
        conditions = {
            row["type"]: row["status"] for row in node["status"].get("conditions", [])
        }
        if (
            node.get("spec", {}).get("unschedulable")
            or conditions.get("Ready") != "True"
            or any(
                conditions.get(key) == "True"
                for key in (
                    "MemoryPressure",
                    "DiskPressure",
                    "PIDPressure",
                    "NetworkUnavailable",
                )
            )
        ):
            raise PreflightError("node_unready_or_pressure")
        if any(
            row.get("effect") in {"NoSchedule", "NoExecute"}
            for row in node.get("spec", {}).get("taints", [])
        ):
            raise PreflightError("node_taint_requires_review")
        return node

    node = check("shared_node", node_check)
    if node:
        name = node["metadata"]["name"]

        def pid_check():
            limit = reader.kubelet(name)["kubeletconfig"].get("podPidsLimit")
            report["pod_pids_limit"] = limit
            if type(limit) is not int or not 1 <= limit <= 512:
                raise PreflightError("bounded_pod_pids_required")
            return limit

        check("pod_pids_limit", pid_check)

        def capacity_check():
            pods = reader.inventory("pods")["items"]
            used = Decimal(0)
            unrequested = 0
            for pod in pods:
                if pod.get("spec", {}).get("nodeName") != name or pod.get(
                    "status", {}
                ).get("phase") in {"Succeeded", "Failed"}:
                    continue
                spec = pod["spec"]
                # Conservative bound: includes all init/sidecar requests, avoiding
                # undercounting restartable init containers without simulation.
                for container in spec.get("containers", []) + spec.get(
                    "initContainers", []
                ):
                    requests = container.get("resources", {}).get("requests", {})
                    used += cpu(requests.get("cpu", 0))
                    unrequested += "cpu" not in requests
                used += cpu(spec.get("overhead", {}).get("cpu", 0))
            available = cpu(node["status"]["allocatable"]["cpu"])
            report["cpu"] = {
                "allocatable_m": float(available),
                "conservative_existing_requests_m": float(used),
                "containers_without_cpu_request": unrequested,
                "new_gateway_and_one_task_requests_m": 200,
            }
            if available - used < 200:
                raise PreflightError("insufficient_cpu_requests_headroom")
            return True

        check("cpu_requests_capacity", capacity_check)
    report["passed"] = all(row["passed"] for row in report["checks"])
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--gateway-namespace", default="meet-work-review")
    parser.add_argument("--task-namespace", default="meet-work-review-tasks")
    parser.add_argument("--business-namespace", default="meet")
    args = parser.parse_args()
    try:
        report = preflight(
            Reader(args.context),
            args.gateway_namespace,
            args.task_namespace,
            args.business_namespace,
        )
        print(json.dumps(report, indent=2))
        return 0 if report["passed"] else 1
    except Exception:
        print(
            json.dumps(
                {
                    "passed": False,
                    "deployment_performed": False,
                    "code": "inventory_failed",
                }
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
