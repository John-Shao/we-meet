"""Persist only Work settings; never print credentials or replace custom models."""

import argparse
import copy
import json
import os
import sys
from pathlib import Path

import yaml

MODEL_KEYS = ("WORK_MODEL", "WORK_MODEL_BASE_URL", "WORK_MODEL_API_KEY")


def check_deployed(data, deployments):
    """Do not enable an edited overlay using a probe of an older configuration."""
    expected = data["backend"]["envVars"]
    items = deployments["items"]
    if len(items) != 2:
        raise ValueError("backend_and_work_worker_required")
    for item in items:
        spec, status = item["spec"], item.get("status", {})
        replicas = spec.get("replicas", 1)
        if (replicas < 1 or status.get("observedGeneration", 0) < item["metadata"]["generation"]
                or status.get("updatedReplicas", 0) != replicas
                or status.get("availableReplicas", 0) != replicas
                or status.get("replicas", 0) != replicas):
            raise ValueError("deployment_not_settled")
        env = {entry["name"]: entry.get("valueFrom", entry.get("value"))
               for entry in spec["template"]["spec"]["containers"][0]["env"]}
        if any(env.get(key) != expected[key] for key in MODEL_KEYS):
            raise ValueError("model_overlay_not_deployed")


def configure(data, mode, defaults):
    data = copy.deepcopy(data or {})
    data.setdefault("workWorker", {})["enabled"] = True
    data.setdefault("celeryBeat", {})["enabled"] = True
    env = data.setdefault("backend", {}).setdefault("envVars", {})
    if mode in ("prepare-communication", "communication"):
        present = [bool(env.get(key)) for key in MODEL_KEYS]
        if mode == "prepare-communication" and not any(present):
            for key in MODEL_KEYS:
                env[key] = copy.deepcopy(defaults[key])
        elif not all(present):
            raise ValueError("incomplete_work_model_config")
        if not isinstance(env["WORK_MODEL"], str) or not isinstance(env["WORK_MODEL_BASE_URL"], str):
            raise ValueError("invalid_work_model_config")
        ref = env["WORK_MODEL_API_KEY"]
        if not isinstance(ref, dict) or not isinstance(ref.get("secretKeyRef"), dict):
            raise ValueError("work_model_requires_secret_reference")
        if not all(isinstance(ref["secretKeyRef"].get(k), str) and ref["secretKeyRef"][k].strip()
                   for k in ("name", "key")):
            raise ValueError("invalid_work_secret_reference")
    enabled = "False" if mode == "off" else "True"
    env.update(WORK_ENABLED=enabled, WORK_MATERIALS_ENABLED=enabled,
               WORK_COMMUNICATION_ENABLED="True" if mode == "communication" else "False")
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("mode", choices=("materials", "off", "prepare-communication", "communication"))
    parser.add_argument("--check-deployed", action="store_true", help="Read two Deployment objects on stdin; do not write")
    args = parser.parse_args()
    defaults = Path(__file__).resolve().parents[2] / "src/helm/env.d/aliyun-prod/values.work.yaml.dist"
    try:
        original = yaml.safe_load(args.path.read_text(encoding="utf8")) if args.path.exists() else {}
        profile = yaml.safe_load(defaults.read_text(encoding="utf8")) if args.mode == "prepare-communication" else {}
        data = configure(original, args.mode, profile.get("backend", {}).get("envVars", {}))
        if args.check_deployed:
            check_deployed(data, json.load(sys.stdin))
            return
    except (ValueError, TypeError, AttributeError, KeyError, yaml.YAMLError):
        # YAML exceptions may contain literal secret values; never echo them.
        parser.exit(1, "Work model configuration is incomplete, invalid, or not fully deployed; run prepare-communication before enabling.\n")
    args.path.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.path.with_name(args.path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf8") as stream:
            json.dump(data, stream, indent=2, ensure_ascii=True)
            stream.write("\n")
        os.replace(temporary, args.path)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
