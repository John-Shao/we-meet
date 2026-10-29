#!/usr/bin/env python3
"""Encrypt and upload the local Work Content Store to the private OSS bucket."""
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, "/opt/meet-db-backup")
import backup  # noqa: E402

CONTENT_DIR = Path(os.environ.get("WORK_CONTENT_DIR", "/var/lib/work/content"))
CONFIG_DIR = Path("/etc/meet-db-backup/work")
STATE = Path("/var/lib/work/content-backup.json")
PREFIX = "content/"
RETENTION_DAYS = 30


def run(args):
    result = subprocess.run(args, capture_output=True, timeout=1800)
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} failed")
    return result.stdout


def main():
    os.umask(0o077)
    if not CONTENT_DIR.is_dir():
        raise RuntimeError("content directory is missing")
    storage = json.loads((CONFIG_DIR / "storage.json").read_text(encoding="utf-8"))
    client = backup.object_client(storage)
    backup.require_private(client, storage["bucket"])
    started = backup.utcnow()
    state = Path("/var/lib/work")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="content-backup-", dir=state) as directory:
        work = Path(directory)
        plain = work / "content.tar.gz"
        encrypted = work / "content.tar.gz.age"
        run(["tar", "--exclude=*.tmp", "-C", str(CONTENT_DIR.parent), "-czf", str(plain), CONTENT_DIR.name])
        run(["age", "-R", str(CONFIG_DIR / "recipient.txt"), "-o", str(encrypted), str(plain)])
        key = PREFIX + started.strftime("%Y/%m/%d/%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:12] + ".tar.gz.age"
        digest = backup.upload_verified(client, storage["bucket"], key, encrypted)
        completed = backup.utcnow()
        receipt = {
            "status": "success",
            "format_version": "work-content-v1",
            "bucket": storage["bucket"],
            "key": key,
            "bytes": encrypted.stat().st_size,
            "sha256": digest,
            "started_at": started.isoformat(),
            "completed_at": completed.isoformat(),
        }
        cutoff = completed - dt.timedelta(days=RETENTION_DAYS)
        response = client.list_objects_v2(Bucket=storage["bucket"], Prefix=PREFIX)
        for item in response.get("Contents", []):
            if item["LastModified"] < cutoff:
                client.delete_object(Bucket=storage["bucket"], Key=item["Key"])
        backup.write_json(STATE, receipt)
        print(json.dumps(receipt), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("CONTENT_BACKUP_FAILED " + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
