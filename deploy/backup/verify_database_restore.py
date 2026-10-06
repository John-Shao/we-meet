#!/usr/bin/env python3
"""Restore Docs/IM/Keycloak database bundles only into isolated local Docker.

This verifies all table counts; it does not launch the applications or restore
production roles, call SSO, send mail, or retrieve document/media objects.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import uuid

from database_backup import FORMAT, SERVICES, identifier
from verify_restore import run, safe_extract, sha256, verify_files


def drill(archive, identity, expected_sha, report_path, service, postgres_image="postgres:16-alpine"):
    if service not in SERVICES or sha256(archive) != expected_sha:
        raise ValueError("Service or encrypted archive checksum mismatch")
    started = time.monotonic()
    name = "db-restore-" + service + "-" + uuid.uuid4().hex[:12]
    network, pg = name + "-net", name + "-pg"
    network_attempted = pg_attempted = False
    with tempfile.TemporaryDirectory(prefix="database-restore-") as directory:
        work = Path(directory)
        os.chmod(work, 0o700)
        try:
            plain = work / "database.tar.gz"
            run(["age", "-d", "-i", str(identity), "-o", str(plain), str(archive)])
            payload = work / "payload"
            payload.mkdir()
            safe_extract(plain, payload)
            manifest = json.loads((payload / "manifest.json").read_text(encoding="utf-8"))
            if manifest.get("format_version") != FORMAT or manifest.get("service") != service:
                raise ValueError("Wrong service or unknown backup format")
            databases = manifest["databases"]
            if not databases or len({d["name"] for d in databases}) != len(databases):
                raise ValueError("Missing or duplicate databases")
            verify_files(payload, manifest)
            run(["docker", "image", "inspect", postgres_image])
            network_attempted = True
            run(["docker", "network", "create", "--internal", network])
            password = secrets.token_hex(24)
            env = work / "postgres.env"
            env.write_text(f"POSTGRES_USER=drill\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB=postgres\n", encoding="utf-8")
            os.chmod(env, 0o600)
            pg_attempted = True
            run(["docker", "run", "-d", "--name", pg, "--network", network, "--env-file", str(env),
                 "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=2g", "--memory", "2g",
                 "--cpus", "2", postgres_image])
            for _ in range(60):
                ready = subprocess.run(["docker", "exec", pg, "pg_isready", "-U", "drill"], capture_output=True)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Isolated PostgreSQL did not become ready")
            version = int(run(["docker", "exec", pg, "psql", "-XAt", "-U", "drill", "-d", "postgres",
                               "-c", "SHOW server_version_num;"]).decode().strip())
            checks = []
            for index, database in enumerate(databases):
                if version // 10000 != database["server_version_num"] // 10000:
                    raise ValueError("Restore image must match the source PostgreSQL major version")
                dbname = f"restored_{index}"
                dbdump = (payload / database["file"]).resolve()
                if not dbdump.is_relative_to(payload.resolve()) or database["file"] not in manifest["files"]:
                    raise ValueError("Unverified database archive path")
                run(["docker", "exec", pg, "createdb", "-U", "drill", dbname])
                run(["docker", "cp", str(dbdump), pg + ":/tmp/restore.dump"])
                run(["docker", "exec", pg, "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges",
                     "-U", "drill", "-d", dbname, "/tmp/restore.dump"])
                tables = database["tables"]
                if not tables:
                    raise ValueError("Missing source table inventory")
                queries = [f"SELECT count(*) FROM {identifier(t['schema'])}.{identifier(t['table'])};" for t in tables]
                output = run(["docker", "exec", "-i", pg, "psql", "-XAt", "-v", "ON_ERROR_STOP=1",
                              "-U", "drill", "-d", dbname], "\n".join(queries).encode())
                actual = [int(line) for line in output.decode().splitlines()]
                if actual != [t["rows"] for t in tables]:
                    raise RuntimeError("Restored counts differ from source snapshot")
                checks.append({"database": database["name"], "tables_verified": len(actual), "rows_verified": sum(actual)})
            report = {"status": "passed", "service": service, "verified_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                      "archive_sha256": expected_sha, "databases": checks, "files_verified": len(manifest["files"]),
                      "elapsed_seconds": round(time.monotonic()-started, 2),
                      "isolation": "Internal Docker network; no host ports; disposable PostgreSQL; no production role restore",
                      "scope": "Database restore and all table counts only; no application/SSO/media or host failover"}
        finally:
            # Even a timed-out docker CLI may have created a resource.
            failures = []
            if pg_attempted:
                result = subprocess.run(["docker", "rm", "-f", pg], capture_output=True, timeout=30)
                if result.returncode and subprocess.run(["docker", "inspect", pg], capture_output=True).returncode == 0:
                    failures.append("container")
            if network_attempted:
                result = subprocess.run(["docker", "network", "rm", network], capture_output=True, timeout=30)
                if result.returncode and subprocess.run(["docker", "network", "inspect", network], capture_output=True).returncode == 0:
                    failures.append("network")
            if failures:
                raise RuntimeError("Restore cleanup failed: " + ",".join(failures))
    Path(report_path).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service", choices=sorted(SERVICES), required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--postgres-image", default="postgres:16-alpine")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        drill(args.archive, args.identity, args.sha256, args.report, args.service, args.postgres_image)
    except Exception as error:
        print("DATABASE_RESTORE_FAILED " + type(error).__name__)
        args.report.write_text(json.dumps({"status": "failed", "service": args.service,
                                          "archive_sha256": args.sha256, "error_type": type(error).__name__}) + "\n",
                               encoding="utf-8")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
