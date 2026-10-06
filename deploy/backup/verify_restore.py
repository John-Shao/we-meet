#!/usr/bin/env python3
"""Decrypt an offsite bundle and restore it ONLY into disposable local Docker.

No production settings are loaded. Docker network is internal, with no host ports.
Production roles/credentials are preserved in the bundle but not executed in drills.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tarfile
import tempfile
import time
import uuid


def run(args, input_data=None, timeout=600):
    result = subprocess.run(args, input=input_data, capture_output=True, timeout=timeout)
    if result.returncode:
        # No database content, credentials, or Docker env values in terminal logs.
        raise RuntimeError(f"{Path(args[0]).name} failed (exit {result.returncode})")
    return result.stdout


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_extract(archive, destination):
    destination = Path(destination).resolve()
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            path = (destination / member.name).resolve()
            if not path.is_relative_to(destination) or not (member.isdir() or member.isfile()):
                raise ValueError("Archive contains unsafe paths or special files")
        tar.extractall(destination)


def verify_files(root, manifest):
    for relative, expected in manifest["files"].items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file() or sha256(path) != expected:
            raise ValueError("Backup file checksum mismatch")


APP_SMOKE = '''
import json
from django.conf import settings
settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
settings.ALLOWED_HOSTS = ["testserver", "localhost"]
settings.SESSION_ENGINE = "django.contrib.sessions.backends.db"
settings.AUTHENTICATION_BACKENDS = ["django.contrib.auth.backends.ModelBackend"]
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.contrib.auth import get_user_model
from django.test import Client
from core.models import Room, MeetingRecord, TranscriptChunk
executor = MigrationExecutor(connection)
assert not executor.migration_plan(executor.loader.graph.leaf_nodes()), "Unapplied migrations"
client = Client()
r = client.get("/api/v1.0/config/")
assert r.status_code == 200, "Config endpoint unavailable"
user = get_user_model().objects.filter(is_active=True).first()
assert user is not None, "No active restored user"
client.force_login(user, backend="django.contrib.auth.backends.ModelBackend")
r = client.get("/api/v1.0/users/me/")
assert r.status_code == 200, "Restored user API failed"
print("RESTORE_APP_OK " + json.dumps({"config_http":200,"user_http":200,
 "users":get_user_model().objects.count(),"rooms":Room.objects.count(),
 "records":MeetingRecord.objects.count(),"chunks":TranscriptChunk.objects.count()}))
'''


def drill(archive, identity, expected_sha, report_path, postgres_image):
    if sha256(archive) != expected_sha:
        raise ValueError("Encrypted archive checksum differs from offsite receipt")
    started = time.monotonic()
    name = "meet-restore-" + uuid.uuid4().hex[:12]
    network, pg, app = name + "-net", name + "-pg", name + "-app"
    created_network = created_pg = False
    with tempfile.TemporaryDirectory(prefix="meet-restore-") as directory:
        work = Path(directory)
        try:
            plain = work / "recovery.tar.gz"
            run(["age", "-d", "-i", str(identity), "-o", str(plain), str(archive)])
            payload = work / "payload"
            payload.mkdir()
            safe_extract(plain, payload)
            manifest = json.loads((payload / "manifest.json").read_text())
            if manifest["format_version"] != 1:
                raise ValueError("Unknown recovery format")
            verify_files(payload, manifest)
            image = manifest["images"]["meet-backend"][0]
            # Images must already be prepared locally; this never builds on production.
            run(["docker", "image", "inspect", postgres_image])
            run(["docker", "image", "inspect", image])
            run(["docker", "network", "create", "--internal", network])
            created_network = True
            password = secrets.token_hex(24)
            pg_env = work / "postgres.env"
            pg_env.write_text(f"POSTGRES_USER=drill\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB=postgres\n")
            os.chmod(pg_env, 0o600)
            run(["docker", "run", "-d", "--name", pg, "--network", network,
                 "--env-file", str(pg_env), "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=2g",
                 "--memory", "2g", "--cpus", "2", postgres_image])
            created_pg = True
            for _ in range(60):
                ready = subprocess.run(["docker", "exec", pg, "pg_isready", "-U", "drill"], capture_output=True)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Isolated PostgreSQL did not become ready")
            checks = []
            for index, database in enumerate(manifest["databases"]):
                dbname = f"restored_{index}"
                run(["docker", "exec", pg, "createdb", "-U", "drill", dbname])
                dbdump = (payload / database["file"]).resolve()
                if not dbdump.is_relative_to(payload.resolve()):
                    raise ValueError("Unsafe database archive path")
                run(["docker", "cp", str(dbdump), pg + ":/tmp/restore.dump"])
                run(["docker", "exec", pg, "pg_restore", "--exit-on-error", "--no-owner",
                     "--no-privileges", "-U", "drill", "-d", dbname, "/tmp/restore.dump"])
                # Counts came from the same exported snapshot as pg_dump.
                queries = []
                for table in database["tables"]:
                    schema = table["schema"].replace('"', '""')
                    name_sql = table["table"].replace('"', '""')
                    queries.append(f'SELECT count(*) FROM "{schema}"."{name_sql}";')
                output = run(["docker", "exec", "-i", pg, "psql", "-X", "-v", "ON_ERROR_STOP=1",
                              "-U", "drill", "-d", dbname, "-At"], "\n".join(queries).encode())
                actual = [int(line) for line in output.decode().splitlines()]
                expected = [t["rows"] for t in database["tables"]]
                if actual != expected:
                    raise RuntimeError("Restored row counts differ from source snapshot")
                checks.append({"database": database["name"], "tables_verified": len(actual),
                               "rows_verified": sum(actual)})
                if database["name"] == "meet":
                    app_env = work / "app.env"
                    app_env.write_text("\n".join([
                        "DJANGO_SETTINGS_MODULE=meet.settings", "DJANGO_CONFIGURATION=Base",
                        "DJANGO_SECRET_KEY=isolated-restore-drill-only",
                        "OIDC_OP_JWKS_ENDPOINT=http://unreachable.invalid/unused",
                        f"DATABASE_URL=postgresql://drill:{password}@{pg}:5432/{dbname}",
                        "REDIS_URL=redis://unreachable.invalid:6379/15", "LANG=C.UTF-8", "",
                    ]))
                    os.chmod(app_env, 0o600)
                    app_result = run(["docker", "run", "--rm", "--name", app, "--network", network,
                                      "--env-file", str(app_env), "--entrypoint", "python",
                                      image, "manage.py", "shell", "-c", APP_SMOKE])
                    markers = [x for x in app_result.decode().splitlines() if x.startswith("RESTORE_APP_OK ")]
                    if len(markers) != 1:
                        raise RuntimeError("Application smoke result missing")
                    application = json.loads(markers[0].removeprefix("RESTORE_APP_OK "))
            if not any(c["database"] == "meet" for c in checks):
                raise RuntimeError("Required meet database missing")
            report = {"status": "passed", "verified_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                      "archive_sha256": expected_sha, "source_commit": manifest["source_commit"],
                      "databases": checks, "application": application,
                      "files_verified": len(manifest["files"]),
                      "elapsed_seconds": round(time.monotonic() - started, 2),
                      "isolation": "Docker internal network, no host ports, disposable PostgreSQL, no production settings",
                      "scope": "Database and application read smoke; not a full host/SSO/media failover exercise"}
            Path(report_path).write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report))
        finally:
            # A timed-out docker client does not necessarily stop its container.
            if created_network:
                subprocess.run(["docker", "rm", "-f", app], capture_output=True, timeout=30)
            if created_pg:
                run(["docker", "rm", "-f", pg])
            if created_network:
                run(["docker", "network", "rm", network])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--postgres-image", default="postgres:16-alpine")
    args = parser.parse_args()
    os.umask(0o077)
    drill(args.archive, args.identity, args.sha256, args.report, args.postgres_image)


if __name__ == "__main__":
    main()
