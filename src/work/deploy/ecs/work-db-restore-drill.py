#!/usr/bin/env python3
"""Restore a Work database bundle into scratch local PostgreSQL databases."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile

CONFIG = Path("/etc/meet-db-backup/work")
STATE = Path("/var/lib/meet-db-backup/work")
IDENTITY = Path(os.environ.get("WORK_BACKUP_IDENTITY", "/root/work-backups/work-offsite-20261029.agekey"))


def run(args, stdin=None):
    result = subprocess.run(args, input=stdin, capture_output=True, timeout=1800)
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(f"{Path(args[0]).name} failed (exit {result.returncode}): "
                           + (detail[-1][:240] if detail else "no stderr"))
    return result.stdout


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def quote(value):
    return '"' + value.replace('"', '""') + '"'


def safe_extract(archive, target):
    root = target.resolve()
    with tarfile.open(archive, "r:gz") as source:
        for member in source.getmembers():
            path = (target / member.name).resolve()
            if not path.is_relative_to(root) or member.issym() or member.islnk():
                raise ValueError("unsafe archive member")
        source.extractall(target, filter="data")


def psql(database, sql):
    return run(["runuser", "-u", "postgres", "--", "psql", "-XqAt", "-v", "ON_ERROR_STOP=1",
                "-d", database, "-c", sql]).decode().strip()


def main():
    os.umask(0o077)
    receipt = json.loads((STATE / "last-success.json").read_text(encoding="utf-8"))
    storage = json.loads((CONFIG / "storage.json").read_text(encoding="utf-8"))
    import boto3
    from botocore.config import Config
    client = boto3.client(
        "s3", endpoint_url=storage["endpoint"], region_name=storage["region"],
        aws_access_key_id=storage["access_key"], aws_secret_access_key=storage["secret_key"],
        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"},
                      connect_timeout=10, read_timeout=120, retries={"max_attempts": 2}),
    )
    scratch = []
    pg_temp = None
    report = {"status": "failed", "service": "work", "archive_sha256": receipt["sha256"],
              "key": receipt["key"], "verified_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    try:
        with tempfile.TemporaryDirectory(prefix="work-restore-", dir=STATE) as directory:
            work = Path(directory)
            encrypted = work / "database.tar.gz.age"
            body = client.get_object(Bucket=storage["bucket"], Key=receipt["key"])["Body"]
            with encrypted.open("wb") as stream:
                for block in iter(lambda: body.read(1024 * 1024), b""):
                    stream.write(block)
            body.close()
            if sha256(encrypted) != receipt["sha256"]:
                raise ValueError("download checksum mismatch")
            plain = work / "database.tar.gz"
            run(["age", "-d", "-i", str(IDENTITY), "-o", str(plain), str(encrypted)])
            payload = work / "payload"
            payload.mkdir()
            safe_extract(plain, payload)
            manifest = json.loads((payload / "manifest.json").read_text(encoding="utf-8"))
            if manifest.get("format_version") != "we-meet-database-v1" or manifest.get("service") != "work":
                raise ValueError("wrong manifest")
            for name, digest in manifest["files"].items():
                candidate = (payload / name).resolve()
                if not candidate.is_relative_to(payload.resolve()) or sha256(candidate) != digest:
                    raise ValueError("manifest file mismatch")
            checks = []
            for index, database in enumerate(manifest["databases"]):
                name = "work_drill_" + secrets.token_hex(8)
                scratch.append(name)
                run(["runuser", "-u", "postgres", "--", "createdb", "-T", "template0", name])
                dump = (payload / database["file"]).resolve()
                if not dump.is_relative_to(payload.resolve()):
                    raise ValueError("unexpected dump path")
                postgres = pwd.getpwnam("postgres")
                if pg_temp is None:
                    pg_temp = Path(tempfile.mkdtemp(prefix="work-drill-", dir="/var/lib/postgresql"))
                    os.chmod(pg_temp, 0o700)
                    os.chown(pg_temp, postgres.pw_uid, postgres.pw_gid)
                staged = pg_temp / "database.dump"
                shutil.copyfile(dump, staged)
                os.chown(staged, postgres.pw_uid, postgres.pw_gid)
                os.chmod(staged, 0o600)
                run(["runuser", "-u", "postgres", "--", "pg_restore", "--exit-on-error",
                     "--no-owner", "--no-privileges", "-d", name, str(staged)])
                tables = database["tables"]
                queries = "".join(
                    f"SELECT count(*) FROM {quote(t['schema'])}.{quote(t['table'])};\n" for t in tables)
                output = run(["runuser", "-u", "postgres", "--", "psql", "-XqAt", "-v",
                              "ON_ERROR_STOP=1", "-d", name], stdin=queries.encode()).decode().split()
                actual = [int(line) for line in output]
                if actual != [t["rows"] for t in tables]:
                    raise RuntimeError("row count mismatch")
                checks.append({"database": database["name"], "tables_verified": len(actual),
                               "rows_verified": sum(actual)})
                psql("postgres", f"DROP DATABASE {quote(name)}")
                scratch.remove(name)
            report.update({"status": "passed", "databases": checks,
                           "files_verified": len(manifest["files"]),
                           "scope": "scratch local PostgreSQL databases; no production roles or app startup"})
    except Exception as error:
        report["error_type"] = type(error).__name__
        report["error"] = str(error)[:400]
        raise
    finally:
        for name in list(scratch):
            subprocess.run(["runuser", "-u", "postgres", "--", "dropdb", "--if-exists", name],
                           capture_output=True, timeout=60)
        if pg_temp is not None:
            shutil.rmtree(pg_temp, ignore_errors=True)
        (STATE / ("restore-drill-" + dt.datetime.now().strftime("%Y%m%dT%H%M%S") + ".json")).write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("WORK_RESTORE_FAILED " + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
