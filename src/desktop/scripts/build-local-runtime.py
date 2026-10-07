"""Build-only tool: end users need neither Python nor Node nor pip."""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

PYTHON_URL = (
    "https://www.python.org/ftp/python/3.13.9/python-3.13.9-embeddable-amd64.zip"
)
PYTHON_SHA256 = "760875a79acd02de62d2408e6e2d242d85748c1fc28b72032dca486f8290442a"
root = Path(__file__).resolve().parents[1]
agent = root.parent / "work-agent"
version = "0.3.2"
destination = root / ".agent-runtime" / version
if destination.exists():
    raise SystemExit(
        "Runtime version already exists; build into a new version directory"
    )
destination.parent.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(
    prefix="runtime-build-", dir=destination.parent
) as tmp:
    stage = Path(tmp) / "payload"
    stage.mkdir()
    with urllib.request.urlopen(PYTHON_URL, timeout=30) as response:
        archive = response.read(20000000)
    if hashlib.sha256(archive).hexdigest() != PYTHON_SHA256:
        raise SystemExit("Python archive checksum mismatch")
    archive_path = Path(tmp) / "python.zip"
    archive_path.write_bytes(archive)
    with zipfile.ZipFile(archive_path) as zipped:
        zipped.extractall(stage)
    site = stage / "Lib/site-packages"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--require-hashes",
            "--only-binary=:all:",
            "--no-compile",
            "--target",
            str(site),
            "-r",
            str(agent / "requirements-dsh.lock"),
        ],
        check=True,
    )
    wheel_dir = Path(tmp) / "wheels"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            "--no-deps",
            str(agent),
            "--wheel-dir",
            str(wheel_dir),
        ],
        check=True,
    )
    wheel = next(wheel_dir.glob("we_meet_work_agent-*.whl"))
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-deps",
            "--no-compile",
            "--target",
            str(site),
            str(wheel),
        ],
        check=True,
    )
    (stage / "python313._pth").write_text(
        "python313.zip\n.\nLib/site-packages\nimport site\n", encoding="utf-8"
    )
    compiler = (
        Path(os.environ["SYSTEMROOT"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    )
    subprocess.run(
        [
            str(compiler),
            "/nologo",
            "/target:exe",
            "/platform:x64",
            f"/out:{stage / 'work-agent-local.exe'}",
            str(root / "scripts/local-agent-launcher.cs"),
        ],
        check=True,
    )
    subprocess.run(
        [
            str(stage / "python.exe"),
            "-I",
            "-B",
            "-c",
            "import sqlite3,ssl,pydantic,deepseek_harness,work_agent; print('Self-contained runtime imports passed')",
        ],
        check=True,
    )
    files = [
        {
            "name": str(p.relative_to(stage)).replace("\\", "/"),
            "bytes": p.stat().st_size,
            "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
        }
        for p in sorted(stage.rglob("*"))
        if p.is_file()
    ]
    manifest = {
        "contract": "work-runtime/v1",
        "version": version,
        "platform": "win32-x64",
        "adapter_contract": "work-local/v1",
        "entry": "work-agent-local.exe",
        "python": "3.13.9",
        "python_archive_sha256": PYTHON_SHA256,
        "dsh_sdk_runtime": "0.1.5rc1",
        "files": files,
    }
    manifest_bytes = json.dumps(
        manifest, sort_keys=True, separators=(",", ":")
    ).encode()
    (stage / "manifest.json").write_bytes(manifest_bytes)
    # Signing is done after binary Authenticode signing; no fabricated production identity.
    stage.rename(destination)
    (root / "dist").mkdir(exist_ok=True)
    (root / "dist/bundled-runtime.json").write_text(
        json.dumps(
            {
                "version": version,
                "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            }
        ),
        encoding="utf-8",
    )
    print("Built self-contained native runtime", version, len(files), "files")
