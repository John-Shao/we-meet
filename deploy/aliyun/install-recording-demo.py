#!/usr/bin/env python3
"""Install the single-worker demo Egress release from a pinned local chart.

Run on the k3s server as root, after applying the recording backend release.
Credentials are read from existing Kubernetes objects and never printed.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

import yaml


def run(args, **kwargs):
    result = subprocess.run(
        args, capture_output=True, text=True, timeout=360, **kwargs
    )
    if result.returncode:
        # Provider or Kubernetes errors can contain submitted Secret bodies.
        raise RuntimeError(f"Command failed: {args[0]} (exit {result.returncode})")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chart", required=True, type=Path, help="egress-1.8.4.tgz")
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(__file__).resolve().parents[2]
    values_path = root / "src/helm/env.d/aliyun-prod/values.egress-demo.yaml"
    renderer = Path(__file__).with_name("recording-demo-post-renderer.py")
    chart = yaml.safe_load(run(["helm", "show", "chart", str(args.chart)]))
    if chart["name"] != "egress" or str(chart["version"]) != "1.8.4":
        raise RuntimeError("Expected the official egress chart version 1.8.4")

    def k(*arguments):
        return json.loads(run(["k3s", "kubectl", "-n", "meet", *arguments, "-o", "json"]))

    check = """
import asyncio
from django.conf import settings
from core import utils
from core.services.cloud_recording import capacity_full
from livekit import api
async def busy():
    client = utils.create_livekit_client()
    try:
        result = await asyncio.wait_for(
            client.egress.list_egress(api.ListEgressRequest(active=True)), 8
        )
        return bool(result.items)
    finally:
        await client.aclose()
configured = settings.MEETING_CLOUD_RECORDING_MAX_CONCURRENT == 1
print('IDLE' if configured and not capacity_full() and not asyncio.run(busy()) else 'BUSY')
"""
    result = run([
        "k3s", "kubectl", "-n", "meet", "exec", "deployment/meet-backend",
        "--", "python", "manage.py", "shell", "-c", check,
    ])
    if result.strip().splitlines()[-1] != "IDLE":
        raise RuntimeError("Require concurrency=1 and no active recording or upload")

    values = yaml.safe_load(values_path.read_text())
    config = dict(values["egress"])
    livekit = yaml.safe_load(k("get", "cm", "livekit-livekit-server")["data"]["config.yaml"])
    backend = k("get", "deployment", "meet-backend")
    env = {v["name"]: v for v in backend["spec"]["template"]["spec"]["containers"][0]["env"]}

    def envvalue(name):
        value = env[name]
        if "value" in value:
            return value["value"]
        reference = value["valueFrom"]["secretKeyRef"]
        return base64.b64decode(k("get", "secret", reference["name"])["data"][reference["key"]]).decode()

    config["api_key"] = envvalue("LIVEKIT_API_KEY")
    config["api_secret"] = envvalue("LIVEKIT_API_SECRET")
    if livekit["keys"].get(config["api_key"]) != config["api_secret"]:
        raise RuntimeError("LiveKit and backend credentials do not match")
    config["redis"] = livekit["redis"]
    body = yaml.safe_dump(config)
    secret = {
        "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": {"name": "meet-livekit-egress-config", "namespace": "meet"},
        "stringData": {"config.yaml": body},
    }
    run(["k3s", "kubectl", "apply", "-f", "-"], input=json.dumps(secret))
    values.setdefault("podAnnotations", {})["recording-config-checksum"] = hashlib.sha256(body.encode()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="recording-demo-") as directory:
        # Helm needs an executable; keep permission changes outside the checkout.
        executable_renderer = Path(directory) / renderer.name
        executable_renderer.write_bytes(renderer.read_bytes())
        executable_renderer.chmod(0o700)
        output = Path(directory) / "values.yaml"
        output.write_text(yaml.safe_dump(values))
        run([
            "helm", "upgrade", "--install", "recording-egress", str(args.chart),
            "-n", "meet", "-f", str(output), "--post-renderer", str(executable_renderer),
            "--wait", "--timeout", "5m", "--history-max", "5",
        ])
    print("recording-egress ready: one worker, 720p15, one recording at a time")


if __name__ == "__main__":
    main()
