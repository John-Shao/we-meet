"""Build an independently signed update archive using an externally held key."""

import argparse
import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("payload", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
# Signing uses Node's built-in Ed25519; no private key is copied into the package.
key_file = Path(os.environ["WEMEET_RUNTIME_SIGNING_KEY_FILE"]).resolve(strict=True)
key_id = os.environ["WEMEET_RUNTIME_SIGNING_KEY_ID"]
if key_file.is_relative_to(args.payload.resolve()):
    raise SystemExit("Signing key must be outside the payload")
with tempfile.TemporaryDirectory(prefix="work-runtime-sign-") as tmp:
    signature = Path(tmp) / "signature.json"
    code = """const fs=require('node:fs'),c=require('node:crypto');
const key=c.createPrivateKey(fs.readFileSync(process.env.WEMEET_RUNTIME_SIGNING_KEY_FILE));
if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 key required');
fs.writeFileSync(process.argv[1],JSON.stringify({key_id:process.env.WEMEET_RUNTIME_SIGNING_KEY_ID,
 signature:c.sign(null,fs.readFileSync(process.argv[2]),key).toString('base64')}));"""
    subprocess.run(
        ["node", "-e", code, str(signature), str(args.payload / "manifest.json")],
        check=True,
    )
    manifest = json.loads((args.payload / "manifest.json").read_text("utf-8"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for file in manifest["files"]:
            source = (args.payload / file["name"]).resolve(strict=True)
            if not source.is_relative_to(args.payload.resolve()) or source == key_file:
                raise SystemExit("Invalid package path")
            archive.write(source, file["name"])
        archive.write(args.payload / "manifest.json", "manifest.json")
        archive.write(signature, "manifest.sig.json")
print("Created signed runtime archive", args.output.name)
