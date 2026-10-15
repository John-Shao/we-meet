"""Compile and exercise the production key policy without system input calls."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("remote_input_build", Path(__file__).with_name("build-remote-input.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def main() -> None:
    compiler, env = builder.toolchain()
    output = ROOT / "test-results" / "remote-keys"
    output.mkdir(parents=True, exist_ok=True)
    executable = output / "key-tests.exe"
    subprocess.run(
        [str(compiler), "/nologo", "/std:c++17", "/EHsc", "/W4", "/WX", "/O2", "/MT", "/guard:cf", "/utf-8",
         str(ROOT / "native/remote-input/test_keys.cpp"), f"/Fe:{executable}", f"/Fo:{output / 'key-tests.obj'}",
         "/link", "/DYNAMICBASE", "/NXCOMPAT", "/HIGHENTROPYVA"],
        cwd=output, env=env, check=True,
    )
    result = subprocess.run([str(executable)], cwd=output, capture_output=True, text=True, encoding="utf-8", timeout=10)
    (output / "stdout.log").write_text(result.stdout + result.stderr, encoding="utf-8")
    sources = [ROOT / "native/remote-input" / name for name in
               ("main.cpp", "protocol.h", "trusted-ui.h", "session-state.h", "test_keys.cpp")]
    report = {"version": 1, "timestamp": datetime.now(timezone.utc).isoformat(), "exitCode": result.returncode,
              "executableSha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
              "sourceSha256": {str(path.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources},
              "stdout": result.stdout, "stderr": result.stderr}
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="")
    result.check_returncode()


if __name__ == "__main__":
    main()
