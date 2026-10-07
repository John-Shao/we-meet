"""One isolated job. Stdout/stderr are not the public result channel."""

import json
import os
import stat
import sys
import threading
import time
from pathlib import Path

from . import drivers, review
from .contract import MAX_RESULT_BYTES, canonical, digest, filename, validate_request


def collect_artifacts(workspace):
    files = []
    size = 0
    for path in sorted((workspace / "output").iterdir()):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError("invalid_artifact")
        filename(path.name)
        if len(files) >= 20 or info.st_size > 400_000:
            raise RuntimeError("artifact_too_large")
        content = path.read_bytes()
        size += len(content)
        if size > 400_000:
            raise RuntimeError("artifact_too_large")
        files.append(
            {
                "name": path.name,
                "text": content.decode("utf-8"),
                "sha256": digest(content),
            }
        )
    return files


def run(job_dir):
    started = time.monotonic()
    request = validate_request(
        json.loads((job_dir / "request.json").read_text("utf-8"))
    )
    # Backup bound if the gateway disappears; the container exits as a unit.
    watchdog = threading.Timer(request["timeout_seconds"] + 5, lambda: os._exit(124))
    watchdog.daemon = True
    watchdog.start()
    workspace = job_dir / "workspace"
    workspace.mkdir()
    (workspace / "output").mkdir()
    home = job_dir / "runtime-home"
    home.mkdir()
    for item in request["files"]:
        (workspace / item["name"]).write_text(item["text"], encoding="utf-8")
    driver = getattr(drivers, os.environ["WORK_AGENT_ENGINE"])
    if request.get("operation") == "review" and os.environ["WORK_AGENT_ENGINE"] not in {
        "pi",
        "fixture",
    }:
        raise RuntimeError("unsupported_operation")
    result = driver(request, workspace, home)
    if request.get("operation") == "review":
        report = review.validate_report(json.loads(result["summary"]), request["files"])
        (workspace / "output" / "pi-review.json").write_bytes(canonical(report))
        result["summary"] = report["summary"]
    result["artifacts"] = collect_artifacts(workspace)
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    encoded = canonical(result)
    secrets = [
        os.environ.get(key, "")
        for key in ("DEEPSEEK_API_KEY", "WORK_AGENT_MODEL_TOKEN")
    ]
    if len(encoded) > MAX_RESULT_BYTES or any(
        secret and secret.encode() in encoded for secret in secrets
    ):
        raise RuntimeError("invalid_result")
    temporary = job_dir / "result.tmp"
    temporary.write_bytes(encoded)
    temporary.replace(job_dir / "result.json")
    watchdog.cancel()


if __name__ == "__main__":
    try:
        run(Path(sys.argv[1]).resolve())
    except Exception:  # No SDK exceptions, prompts or credentials in logs.
        sys.exit(1)
