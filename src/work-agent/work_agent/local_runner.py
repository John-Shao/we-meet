"""One native dsh process in the user-authorized folder; never copies inputs."""

import json
import os
import sys
import time
from pathlib import Path

from .drivers import dsh
from .runner import collect_artifacts


def run(directory):
    request = json.loads((directory / "request.json").read_text("utf-8"))
    workspace = Path(request["workspace"])
    output = Path(request["output"])
    started = time.monotonic()
    # The cwd is a working location, not an OS sandbox. The desktop grants this
    # explicitly before creating a job. A separate home avoids native UI sessions.
    home = directory / "dsh-home"
    home.mkdir()
    result = dsh(request, workspace, home)
    result["artifacts"] = collect_artifacts(output.parent)
    result["elapsed_ms"] = int((time.monotonic() - started) * 1000)
    secret = os.environ.get("DEEPSEEK_API_KEY", "")
    if secret and secret in json.dumps(result):
        raise RuntimeError("invalid_result")
    (directory / "result.json").write_text(
        json.dumps(result, ensure_ascii=False), "utf-8"
    )


if __name__ == "__main__":
    try:
        run(Path(sys.argv[1]))
    except Exception:  # SDK diagnostics may contain prompt data or credentials.
        os._exit(1)
