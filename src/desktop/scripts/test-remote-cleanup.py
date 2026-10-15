"""Compile and run the production cleanup algorithm with no system input calls."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("remote_input_build", Path(__file__).with_name("build-remote-input.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def main() -> None:
    compiler, env = builder.toolchain()
    output = ROOT / "test-results" / "remote-cleanup"
    output.mkdir(parents=True, exist_ok=True)
    executable = output / "cleanup-tests.exe"
    subprocess.run(
        [str(compiler), "/nologo", "/std:c++17", "/EHsc", "/W4", "/WX", "/O2", "/MT", "/guard:cf", "/utf-8",
         str(ROOT / "native/remote-input/test_cleanup.cpp"), f"/Fe:{executable}", f"/Fo:{output / 'cleanup-tests.obj'}",
         "/link", "/DYNAMICBASE", "/NXCOMPAT", "/HIGHENTROPYVA"],
        cwd=output, env=env, check=True,
    )
    subprocess.run([str(executable)], cwd=output, check=True, timeout=10)


if __name__ == "__main__":
    main()
