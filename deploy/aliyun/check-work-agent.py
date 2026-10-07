"""Offline Work agent Helm check; optional private, scoped release values export."""

import argparse
import copy
import json
import ipaddress
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
PRODUCTION = ROOT / "src/helm/env.d/aliyun-prod"


def scoped_values(profile, credentials, credential_section="workAgent"):
    # Passing the entire business secrets YAML to the agent release would also
    # retain DB/OIDC/S3 credentials in its Helm release values. Filter first.
    agent = copy.deepcopy(profile.get("workAgent", {}))
    if agent.get("runtime", {}).get("execution") == "kubernetes":
        # Separate namespaces use pre-provisioned Secrets, never Helm literals.
        return {"workAgent": agent}
    agent["secrets"] = {
        **copy.deepcopy(agent.get("secrets", {})),
        **copy.deepcopy(credentials.get(credential_section, {}).get("secrets", {})),
    }
    return {"workAgent": agent}


def check_client(profile, namespace):
    env = profile.get("backend", {}).get("envVars", {})
    if any(key in env for key in ("DEEPSEEK_API_KEY", "DASHSCOPE_API_KEY")):
        raise ValueError("provider_key_in_business_environment")
    for prefix in ("WORK_AGENT", "WORK_REVIEW"):
        enabled = str(env.get(prefix + "_ENABLED", "False")).lower() == "true"
        if not enabled:
            continue
        if not profile.get("workAgent", {}).get("enabled"):
            raise ValueError("gateway_disabled")
        agent = profile["workAgent"]
        if prefix == "WORK_REVIEW" and (
            agent.get("engine", "dsh") != "pi"
            or env.get("WORK_REVIEW_MODEL") != agent.get("model")
        ):
            raise ValueError("reviewer_deployment_mismatch")
        hostname = (
            f"{agent.get('fullname', 'meet-work-agent')}.{namespace}.svc.cluster.local"
        )
        endpoint = f"https://{hostname}:{agent.get('port', 8443)}"
        if env.get(prefix + "_URL") != endpoint:
            raise ValueError("client_endpoint_mismatch")
        for key, name, secret_key in (
            (prefix + "_TOKEN", agent["secrets"]["clientSecret"], "WORK_AGENT_TOKEN"),
            (
                prefix + "_CA_PEM",
                agent["tls"].get("clientCASecret", agent["tls"]["existingSecret"]),
                "ca.crt",
            ),
        ):
            reference = env.get(key, {}).get("secretKeyRef", {})
            if reference != {"name": name, "key": secret_key, "optional": False}:
                raise ValueError("client_secret_reference_mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--secrets-file", type=Path, default=PRODUCTION / "values.secrets.yaml"
    )
    parser.add_argument(
        "--values-file", type=Path, default=PRODUCTION / "values.work-agent.yaml"
    )
    parser.add_argument("--namespace", default="meet")
    parser.add_argument(
        "--credential-section", choices=["workAgent", "workReview"], default="workAgent"
    )
    parser.add_argument(
        "--export-values",
        type=Path,
        help="Write only workAgent values to a private file for a manual Helm release",
    )
    parser.add_argument("--export-business-secrets", type=Path)
    parser.add_argument("--export-business-overlay", type=Path)
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?", args.namespace):
            raise ValueError("invalid_namespace")
        profile = yaml.safe_load(args.values_file.read_text(encoding="utf-8-sig"))
        credentials = yaml.safe_load(args.secrets_file.read_text(encoding="utf-8-sig"))
        values = scoped_values(profile, credentials, args.credential_section)
        check_client({**profile, **values}, args.namespace)
        business_only = bool(
            (args.export_business_secrets or args.export_business_overlay)
            and not args.export_values
        )
        poc_env = ROOT / "src/work-agent/.env"
        if not business_only and poc_env.exists():
            for env_key, field in (
                ("DEEPSEEK_API_KEY", "deepseekApiKey"),
                ("DASHSCOPE_API_KEY", "qwenApiKey"),
            ):
                local = re.search(
                    rf"(?m)^{env_key}=(.+)$", poc_env.read_text(encoding="utf8")
                )
                production_key = values["workAgent"].get("secrets", {}).get(field)
                if local and production_key == local[1].strip():
                    raise ValueError("poc_key_reused")
        resources = []
        if not business_only:
            resources = render_agent(values, args.namespace)
        if any(
            (
                args.export_values,
                args.export_business_secrets,
                args.export_business_overlay,
            )
        ):
            export_values(args, values, credentials, profile)
        if business_only:
            print(
                "PASS: scoped business values exported; independent agent release "
                "unchanged; credentials not printed."
            )
        else:
            print(
                f"PASS: independent agent chart rendered {len(resources)} resources; "
                "no cluster changes or credentials printed."
            )
    except Exception:
        parser.exit(
            1,
            "Work agent check failed. Verify immutable images, dedicated node, TLS, "
            "production credentials and client references; secrets are not printed.\n",
        )


def render_agent(values, namespace):
    agent = values.get("workAgent", {})
    kubernetes = agent.get("runtime", {}).get("execution") == "kubernetes"
    if kubernetes and agent.get("enabled"):
        network = ipaddress.ip_network(agent["tasks"]["apiServerCIDR"], strict=True)
        if network.version != 4 or network.prefixlen != 32:
            raise ValueError("single API server IPv4 address required")
    with tempfile.TemporaryDirectory(prefix="work-agent-chart-") as directory:
        path = Path(directory) / "scoped.local.yaml"
        # mkstemp-style permissions, including secrets rendered internally.
        import os

        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf8") as stream:
            json.dump(values, stream)
        result = subprocess.run(
            [
                shutil.which("helm") or "helm",
                "template",
                "work-agent",
                str(
                    ROOT
                    / "src/helm"
                    / ("work-agent-k8s" if kubernetes else "work-agent")
                ),
                "-n",
                namespace,
                "-f",
                str(path),
            ],
            capture_output=True,
            timeout=30,
        )
        if result.returncode:
            raise ValueError("helm_validation_failed")
        resources = [row for row in yaml.safe_load_all(result.stdout) if row]
    return resources


def export_values(args, values, credentials, profile):
    # Import by filename avoids packaging deployment helpers.
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "prepare_work_agent", Path(__file__).with_name("prepare-work-agent.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if args.export_values:
        module.write_private(args.export_values, json.dumps(values, indent=2) + "\n")
    if args.export_business_secrets:
        business = {
            key: value
            for key, value in credentials.items()
            if key not in {"workAgent", "workReview"}
        }
        module.write_private(
            args.export_business_secrets, json.dumps(business, indent=2) + "\n"
        )
    if args.export_business_overlay:
        business = {key: value for key, value in profile.items() if key != "workAgent"}
        module.write_private(
            args.export_business_overlay, json.dumps(business, indent=2) + "\n"
        )


if __name__ == "__main__":
    main()
