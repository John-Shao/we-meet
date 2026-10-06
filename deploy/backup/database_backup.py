#!/usr/bin/env python3
"""Independent PostgreSQL backups over local peer/container sockets; age + OSS.

No plaintext database port, remote SSH credentials or decryption key is required.
Run separately on each source host. Do not copy live PostgreSQL data directories.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid

import backup

SERVICES = {"docs", "im", "keycloak"}
FORMAT = "we-meet-database-v1"


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def transport(source, interactive=False):
    kind = source["kind"]
    if kind == "local":
        return ["runuser", "-u", source.get("os_user", "postgres"), "--"]
    if kind == "docker":
        return ["docker", "exec", *(["-i"] if interactive else []), source["container"]]
    if kind == "kubernetes":
        return ["kubectl", "-n", source["namespace"], "exec", *(["-i"] if interactive else []),
                source["resource"], "-c", source["container"], "--"]
    raise ValueError("Unsupported PostgreSQL transport")


def connection_args(source):
    socket_dir = source.get("socket_dir", "/var/run/postgresql")
    if not socket_dir.startswith("/"):
        raise ValueError("Only local PostgreSQL Unix sockets are allowed")
    return ["-w", "-h", socket_dir, "-p", str(int(source.get("port", 5432))), "-U", source["user"]]


def validate(config, service, storage):
    if service not in SERVICES or config["service"] != service:
        raise ValueError("Database service mismatch")
    names = config["databases"]
    if not isinstance(names, list) or not names or len(set(names)) != len(names):
        raise ValueError("Explicit, unique database names are required")
    # Database names cannot be libpq connection strings or command options.
    for name in [*names, config["source"]["user"]]:
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", name):
            raise ValueError("Unsupported database/user name")
    transport(config["source"])
    connection_args(config["source"])
    for key in ["container", "namespace", "os_user", "resource"]:
        value = config["source"].get(key)
        if value is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]*", value):
            raise ValueError("Invalid transport identifier")
    prefix = storage["prefix"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*/", prefix):
        raise ValueError("Invalid storage prefix")
    if not prefix.endswith(f"/databases/{service}/"):
        raise ValueError("Each service needs its own databases/service/ prefix")


class Session:
    """Keep pg_export_snapshot alive while pg_dump uses the very same snapshot."""
    def __init__(self, source, database):
        self.args = transport(source, True) + ["psql", "-XqAt", "-v", "ON_ERROR_STOP=1",
                                               *connection_args(source), "-d", database]

    def __enter__(self):
        self.proc = subprocess.Popen(self.args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
        self.lines = queue.Queue()

        def collect():
            try:
                for line in self.proc.stdout:
                    self.lines.put(line.rstrip("\r\n"))
            finally:
                self.lines.put(None)

        self.reader = threading.Thread(target=collect, daemon=True)
        self.reader.start()
        return self

    def query(self, sql, timeout=150):
        marker = "BACKUP_END_" + uuid.uuid4().hex
        self.proc.stdin.write(sql + "\n\\echo " + marker + "\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + timeout
        lines = []
        while True:
            try:
                line = self.lines.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                raise TimeoutError("PostgreSQL snapshot query timed out") from None
            if line is None:
                raise RuntimeError("PostgreSQL snapshot connection ended")
            if line == marker:
                return lines
            lines.append(line)

    def __exit__(self, *args):
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)
        self.reader.join(timeout=5)
        self.proc.stdout.close()


def database_dump(source, name, output):
    with Session(source, name) as session:
        snapshot = session.query("SET statement_timeout='120s'; SET lock_timeout='30s'; "
                                 "SET idle_in_transaction_session_timeout='25min'; "
                                 "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; "
                                 "SELECT pg_export_snapshot();")[0]
        if not re.fullmatch(r"[A-Fa-f0-9]+-[A-Fa-f0-9]+-[0-9]+", snapshot):
            raise RuntimeError("Invalid exported snapshot")
        version = int(session.query("SHOW server_version_num;")[0])
        tables = json.loads("\n".join(session.query("SELECT coalesce(json_agg(t ORDER BY schemaname,tablename),'[]') "
                                          "FROM (SELECT schemaname,tablename FROM pg_tables WHERE "
                                          "schemaname NOT IN ('pg_catalog','information_schema')) t;")))
        if not tables:
            raise RuntimeError("Expected application database has no tables")
        extensions = json.loads("\n".join(session.query("SELECT coalesce(json_agg(t),'[]') FROM "
                                              "(SELECT extname,extversion FROM pg_extension ORDER BY extname) t;")))
        counts = []
        for table in tables:
            schema, relation = table["schemaname"], table["tablename"]
            rows = int(session.query(f"SELECT count(*) FROM {identifier(schema)}.{identifier(relation)};")[0])
            counts.append({"schema": schema, "table": relation, "rows": rows})
        backup.command(transport(source) + ["pg_dump", *connection_args(source), "-d", name,
                                           "--format=custom", "--lock-wait-timeout=30s", "--snapshot=" + snapshot],
                       output, timeout=1200)
        session.query("COMMIT;")
    # Stream the dump back through the matching native client, without writing
    # plaintext into a container's writable layer or opening a database port.
    with Path(output).open("rb") as data:
        checked = subprocess.run(transport(source, True) + ["pg_restore", "--file=/dev/null"],
                                 stdin=data, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=600)
    if checked.returncode:
        raise RuntimeError("Database dump validation failed")
    return {"name": name, "file": "postgresql/" + Path(output).name, "server_version_num": version,
            "tables": counts, "extensions": extensions}


def run_backup(config, storage):
    import fcntl

    state = Path(config["state_dir"])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "backup.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        client = backup.object_client(storage)
        backup.require_private(client, storage["bucket"])
        started = backup.utcnow()
        work_dir = Path(config["work_dir"])
        work_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix="run-", dir=work_dir) as directory:
            work = Path(directory)
            payload = work / "payload"
            postgres = payload / "postgresql"
            postgres.mkdir(parents=True)
            source = config["source"]
            backup.command(transport(source) + ["pg_dumpall", *connection_args(source), "--globals-only"],
                           postgres / "globals.sql")
            databases = []
            for index, name in enumerate(config["databases"]):
                print("EXPORTING_DATABASE " + config["service"] + " " + name, flush=True)
                databases.append(database_dump(source, name, postgres / f"database-{index}.dump"))
            recovery = payload / "configuration"
            recovery.mkdir()
            # Config contains public age recipient, storage and mail credentials;
            # never a decryption identity. It stays inside the encrypted archive.
            import shutil
            shutil.copytree(config["config_dir"], recovery / "backup-config")
            for filename in ["database_backup.py", "backup.py", "database_notify.py", "notify.py"]:
                shutil.copy2(Path(__file__).with_name(filename), recovery / filename)
            manifest = {"format_version": FORMAT, "service": config["service"],
                        "started_at": started.isoformat(), "databases": databases,
                        "scope": "PostgreSQL logical databases and cluster roles; no media, Redis or host reconstruction",
                        "consistency": "Each database dump and row counts share one exported snapshot; no cross-database transaction",
                        "files": {str(p.relative_to(payload)): backup.sha256(p)
                                  for p in sorted(payload.rglob("*")) if p.is_file()}}
            backup.write_json(payload / "manifest.json", manifest)
            plain = work / "database.tar.gz"
            with tarfile.open(plain, "w:gz") as archive:
                for child in sorted(payload.iterdir()):
                    archive.add(child, arcname=child.name)
            encrypted = work / "database.tar.gz.age"
            backup.command(["age", "-R", config["recipient_file"], "-o", str(encrypted), str(plain)])
            key = storage["prefix"] + started.strftime("%Y/%m/%d/%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:12] + ".tar.gz.age"
            digest = backup.upload_verified(client, storage["bucket"], key, encrypted)
            completed = backup.utcnow()
            receipt = {"format_version": FORMAT, "service": config["service"], "bucket": storage["bucket"],
                       "key": key, "bytes": encrypted.stat().st_size, "sha256": digest,
                       "started_at": started.isoformat(), "completed_at": completed.isoformat(),
                       "duration_seconds": round((completed-started).total_seconds(), 2),
                       "databases": config["databases"]}
            client.put_object(Bucket=storage["bucket"], Key=storage["prefix"] + "latest.json",
                              Body=json.dumps(receipt).encode(), ACL="private", ContentType="application/json")
            backup.require_private(client, storage["bucket"], storage["prefix"] + "latest.json")
            backup.write_json(state / "last-success.json", receipt)
            backup.write_json(state / "last-attempt.json", {"status": "success", **receipt})
            print(json.dumps(receipt), flush=True)


def check_backup(config, storage, max_age_hours=8):
    client = backup.object_client(storage)
    with contextlib.closing(client.get_object(Bucket=storage["bucket"], Key=storage["prefix"] + "latest.json")["Body"]) as body:
        receipt = json.loads(body.read())
    if (receipt.get("format_version") != FORMAT or receipt.get("service") != config["service"]
            or receipt.get("databases") != config["databases"] or receipt.get("bucket") != storage["bucket"]
            or not receipt.get("key", "").startswith(storage["prefix"])
            or not receipt["key"].endswith(".tar.gz.age")):
        raise backup.BackupCheckError("mismatch")
    age = (backup.utcnow() - backup.dt.datetime.fromisoformat(receipt["completed_at"])).total_seconds()
    if age < -300:
        raise backup.BackupCheckError("future")
    if age > max_age_hours * 3600:
        raise backup.BackupCheckError("stale")
    backup.require_private(client, storage["bucket"], receipt["key"])
    head = client.head_object(Bucket=storage["bucket"], Key=receipt["key"])
    if head["ContentLength"] != receipt["bytes"] or head.get("Metadata", {}).get("sha256") != receipt["sha256"]:
        raise backup.BackupCheckError("mismatch")
    backup.write_json(Path(config["state_dir"]) / "last-check.json",
                      {"status": "success", "at": backup.utcnow().isoformat(), "age_hours": age / 3600})
    print(f"DATABASE_BACKUP_OK service={config['service']} age_hours={age/3600:.2f}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("service", choices=sorted(SERVICES))
    parser.add_argument("action", choices=["run", "check"])
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    path = args.config or Path(f"/etc/meet-db-backup/{args.service}/config.json")
    state = Path(f"/var/lib/meet-db-backup/{args.service}")
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
        state = Path(config["state_dir"])
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        storage = json.loads((Path(config["config_dir"]) / "storage.json").read_text(encoding="utf-8"))
        validate(config, args.service, storage)
        if args.action == "run":
            run_backup(config, storage)
        else:
            check_backup(config, storage)
        return 0
    except Exception as error:
        print("DATABASE_BACKUP_FAILED " + type(error).__name__, file=sys.stderr)
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        backup.write_json(state / ("last-attempt.json" if args.action == "run" else "last-check.json"),
                          {"status": "failed", "at": backup.utcnow().isoformat(),
                           "error_type": type(error).__name__, "reason": getattr(error, "reason", "operation_failed")})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
