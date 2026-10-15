"""Build the fixed Windows input runtime. Does not install or launch it."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "native" / "remote-input"
DEST = ROOT / "dist" / "remote-input"


def setup_environment(current: dict[str, str], output: str) -> dict[str, str]:
    # Windows treats names case-insensitively; a plain dict does not. vcvars may
    # emit Path while Python's inherited environment contains PATH (hosted CI).
    env = {key.upper(): value for key, value in current.items()}
    for line in output.splitlines():
        if "=" in line and not line.startswith("="):
            key, value = line.split("=", 1)
            env[key.upper()] = value
    return env


def toolchain() -> tuple[Path, dict[str, str]]:
    if os.name != "nt":
        raise SystemExit("The remote input runtime must be built on Windows x64")
    vswhere = Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Microsoft Visual Studio/Installer/vswhere.exe"
    install = subprocess.check_output(
        [str(vswhere), "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
        text=True,
    ).strip()
    if not install:
        raise SystemExit("Visual Studio C++ x64 build tools are required")
    setup = Path(install) / "VC/Auxiliary/Build/vcvars64.bat"
    # Only fixed toolchain setup is executed by cmd. No project/user data is
    # evaluated as a shell command, and environment values are never printed.
    result = subprocess.check_output(
        f'cmd.exe /d /s /c ""{setup}" >nul && set"',
        text=True, encoding="utf-8", errors="replace",
    )
    env = setup_environment(dict(os.environ), result)
    compiler = next((Path(item) / "cl.exe" for item in env["PATH"].split(";") if (Path(item) / "cl.exe").is_file()), None)
    if not compiler:
        raise SystemExit("C++ compiler not found after toolchain setup")
    return compiler, env


def build() -> None:
    compiler, env = toolchain()
    DEST.mkdir(parents=True, exist_ok=True)
    output = DEST / "we-meet-remote-input.exe"
    subprocess.run(
        [str(compiler), "/nologo", "/std:c++17", "/EHsc", "/W4", "/WX", "/O2", "/MT", "/guard:cf", "/utf-8",
         str(SOURCE / "main.cpp"), f"/Fe:{output}", f"/Fo:{DEST / 'main.obj'}",
         "/link", "/DYNAMICBASE", "/NXCOMPAT", "/HIGHENTROPYVA", "/MANIFEST:EMBED",
         f"/MANIFESTINPUT:{SOURCE / 'runtime.manifest'}"],
        cwd=DEST, env=env, check=True,
    )
    manifest = {"protocolVersion": 1, "platform": "win32", "arch": "x64", "file": output.name,
                "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                "sourceSha256": {name: hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() for name in ("main.cpp", "protocol.h", "trusted-ui.h", "session-state.h", "runtime.manifest")}}
    (DEST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Built {output.name}; protocol v1; manifest written")


if __name__ == "__main__":
    build()
