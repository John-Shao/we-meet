"""Build a no-input diagnostic parent beside the pinned delivery.8 helper."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = "4eb311a19cc362426f2ec2f073ad297818cc282b4610eb3b58f5fed2c5cd6083"


def main():
    helper = ROOT / "dist/remote-input/we-meet-remote-input.exe"
    if hashlib.sha256(helper.read_bytes()).hexdigest() != EXPECTED:
        raise SystemExit("Requires the exact delivery.8 helper, not a rebuilt candidate")
    output = ROOT / "test-results/native-consent-diagnostic"
    output.mkdir(parents=True, exist_ok=True)
    compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    source = ROOT / "scripts/native-consent-diagnostic.cs"
    exe = output / "WeMeet-Consent-Diagnostic.exe"
    subprocess.run([str(compiler), "/nologo", "/target:exe", "/platform:x64", "/optimize+",
                    "/reference:System.Web.Extensions.dll", "/out:" + str(exe), str(source)], check=True)
    shutil.copy2(helper, output / helper.name)
    manifest = {"version": 1, "network": False, "inputCommandsAllowed": False,
                "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "files": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in [exe, output / helper.name]}}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
