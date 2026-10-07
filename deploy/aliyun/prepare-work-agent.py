"""Prepare ignored Work agent configuration without enabling or deploying it."""

import argparse
import copy
import json
import os
import re
import secrets
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
PRODUCTION = ROOT / "src/helm/env.d/aliyun-prod"


def write_private(path, text):
    try:
        relative = path.resolve().relative_to(ROOT.resolve())
    except ValueError:
        relative = None
    if relative is not None:
        tracked = subprocess.check_output(
            ["git", "ls-files", "--", str(relative)], cwd=ROOT
        )
        ignored = subprocess.run(
            ["git", "check-ignore", "-q", "--", str(relative)],
            cwd=ROOT,
            capture_output=True,
        )
        if tracked or ignored.returncode != 0:
            raise ValueError("private_values_require_gitignored_path")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf8", newline="\n") as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def prepare_secret_text(text):
    original = yaml.safe_load(text) or {}
    if not isinstance(original, dict):
        raise ValueError("invalid_config")
    agent = copy.deepcopy(original.get("workAgent", {}))
    config = agent.setdefault("secrets", {})
    if config.get("create", True) is False:
        return text  # External Secret operator owns all values.
    config.setdefault("create", True)
    config.setdefault("gatewaySecret", "meet-work-agent-gateway")
    config.setdefault("clientSecret", "meet-work-agent-client")
    token = config.get("gatewayToken", "")
    if not token or token == "REPLACE_WORK_AGENT_RANDOM_TOKEN":
        config["gatewayToken"] = secrets.token_urlsafe(48)
    elif not isinstance(token, str) or len(token) < 24:
        raise ValueError("invalid_config")
    config.setdefault("deepseekApiKey", "REPLACE_PRODUCTION_DEEPSEEK_API_KEY")
    block = yaml.safe_dump({"workAgent": agent}, sort_keys=False)
    # Rewrite only this top-level subtree. Preserve unrelated secret values,
    # comments and formatting, including backend.envVars, byte for byte.
    lines = text.splitlines(keepends=True)
    starts = [
        i
        for i, line in enumerate(lines)
        if re.match(r"^workAgent:\s*(?:#.*)?$", line.rstrip())
    ]
    if "workAgent" in original and len(starts) != 1:
        raise ValueError("unsupported_work_agent_layout")
    if starts:
        start = starts[0]
        end = next(
            (
                i
                for i in range(start + 1, len(lines))
                if re.match(r"^[^\s#][^:]*:", lines[i])
            ),
            len(lines),
        )
        return "".join(lines[:start]) + block + "\n" + "".join(lines[end:])
    return (
        text.rstrip("\r\n")
        + "\n\n# Independent Work agent credentials (never commit).\n"
        + block
    )


def prepare(secrets_path, values_path, namespace):
    if not re.fullmatch(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?", namespace):
        raise ValueError("invalid_namespace")
    source = (
        secrets_path
        if secrets_path.exists()
        else PRODUCTION / "values.secrets.yaml.dist"
    )
    text = source.read_text(encoding="utf-8-sig")
    updated = prepare_secret_text(text)
    if updated != text or not secrets_path.exists():
        write_private(secrets_path, updated)
    if not values_path.exists():
        data = yaml.safe_load(
            (PRODUCTION / "values.work-agent.yaml.dist").read_text(encoding="utf8")
        )
        data["backend"]["envVars"]["WORK_AGENT_URL"] = (
            f"https://meet-work-agent.{namespace}.svc.cluster.local:8443"
        )
        write_private(values_path, json.dumps(data, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--secrets-file", type=Path, default=PRODUCTION / "values.secrets.yaml"
    )
    parser.add_argument(
        "--values-file", type=Path, default=PRODUCTION / "values.work-agent.yaml"
    )
    parser.add_argument("--namespace", default="meet")
    args = parser.parse_args()
    try:
        prepare(args.secrets_file, args.values_file, args.namespace)
    except Exception:
        # YAML diagnostics can contain arbitrary secrets; never forward them.
        parser.exit(
            1,
            "Work agent configuration preparation failed; "
            "no credentials are printed.\n",
        )
    print(
        "Prepared local configuration; production key remains operator-owned; "
        "execution flags unchanged."
    )


if __name__ == "__main__":
    main()
