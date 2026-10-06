#!/usr/bin/env python3
"""Single-node recovery bundles: consistent PostgreSQL + config, age + private OSS.

Run as root from a systemd oneshot. No decryption identity belongs on this host.
Dependencies: age, PostgreSQL 16 client, kubectl, helm, python3-boto3/psycopg2.
"""

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def command(args, output=None, env=None, timeout=900):
    """Never log command output on failure: it can contain credentials or rows."""
    if output is None:
        result = subprocess.run(args, capture_output=True, env=env, timeout=timeout)
    else:
        with open(output, "wb") as stream:
            result = subprocess.run(args, stdout=stream, stderr=subprocess.PIPE,
                                    env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} failed (exit {result.returncode})")
    return result.stdout if output is None else b""


def object_client(config):
    import boto3
    from botocore.config import Config

    if not config["endpoint"].startswith("https://"):
        raise ValueError("Object storage must use HTTPS")
    return boto3.client(
        "s3", endpoint_url=config["endpoint"], region_name=config["region"],
        aws_access_key_id=config["access_key"],
        aws_secret_access_key=config["secret_key"],
        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"},
                      connect_timeout=10, read_timeout=120,
                      retries={"max_attempts": 3}),
    )


def require_private(client, bucket, key=None):
    acl = client.get_object_acl(Bucket=bucket, Key=key) if key else client.get_bucket_acl(Bucket=bucket)
    grants = acl.get("Grants", [])
    owner = acl.get("Owner", {}).get("ID")
    if not owner or not grants or any(
        g.get("Grantee", {}).get("ID") != owner
        or g.get("Grantee", {}).get("Type") != "CanonicalUser"
        for g in grants
    ):
        raise RuntimeError("Storage ACL grants access beyond the owner")


def upload_verified(client, bucket, key, path):
    """Publish only encrypted payloads, then read the entire object back."""
    if not str(path).endswith(".age") or not key.endswith(".age"):
        raise ValueError("Only age-encrypted archives may be uploaded")
    with open(path, "rb") as stream:
        if stream.read(22) != b"age-encryption.org/v1\n":
            raise ValueError("Missing age header")
    expected = sha256(path)
    client.upload_file(str(path), bucket, key, ExtraArgs={
        "ACL": "private", "ContentType": "application/octet-stream",
        "Metadata": {"sha256": expected},
    })
    require_private(client, bucket, key)
    head = client.head_object(Bucket=bucket, Key=key)
    if head["ContentLength"] != Path(path).stat().st_size:
        raise RuntimeError("Uploaded object size differs")
    digest = hashlib.sha256()
    body = client.get_object(Bucket=bucket, Key=key)["Body"]
    try:
        for block in iter(lambda: body.read(1024 * 1024), b""):
            digest.update(block)
    finally:
        body.close()
    if digest.hexdigest() != expected:
        raise RuntimeError("Object read-back checksum differs")
    return expected


@contextlib.contextmanager
def database_tunnel(namespace, pod):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    proc = subprocess.Popen(
        ["kubectl", "-n", namespace, "port-forward", "--address=127.0.0.1",
         f"pod/{pod}", f"{port}:5432"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(100):
            if proc.poll() is not None:
                raise RuntimeError("Database tunnel exited")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("Database tunnel timed out")
        yield port
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def backup_databases(config, target):
    import psycopg2
    from psycopg2 import sql

    target.mkdir()
    ns, pod = config["namespace"], config["postgres_pod"]
    password = command(["kubectl", "-n", ns, "exec", pod, "--", "sh", "-ec",
                        'cat "$POSTGRES_PASSWORD_FILE"']).decode().strip()
    dbuser = config.get("postgres_user", "meet")
    with database_tunnel(ns, pod) as port:
        env = dict(os.environ, PGHOST="127.0.0.1", PGPORT=str(port),
                   PGUSER=dbuser, PGPASSWORD=password, PGCONNECT_TIMEOUT="10")
        options = dict(host="127.0.0.1", port=port, user=dbuser, password=password,
                       connect_timeout=10, options="-c statement_timeout=120000")
        with psycopg2.connect(dbname="postgres", **options) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1")
                names = [r[0] for r in cursor.fetchall()]
        # Read roles through the pod's local Unix socket; do not reset or depend
        # on a potentially stale chart-generated superuser password.
        command(["kubectl", "-n", ns, "exec", pod, "--", "pg_dumpall", "-U", "postgres",
                 "--globals-only"], target / "globals.sql")
        databases = []
        for index, name in enumerate(names):
            filename = f"database-{index}.dump"
            connection = psycopg2.connect(dbname=name, **options)
            try:
                connection.set_session(isolation_level="REPEATABLE READ", readonly=True)
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_export_snapshot()")
                    snapshot = cursor.fetchone()[0]
                    cursor.execute("SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2")
                    tables = cursor.fetchall()
                    counts = []
                    for schema, table in tables:
                        cursor.execute(sql.SQL("SELECT count(*) FROM {}.{}").format(sql.Identifier(schema), sql.Identifier(table)))
                        counts.append({"schema": schema, "table": table, "rows": cursor.fetchone()[0]})
                    cursor.execute("SELECT extname, extversion FROM pg_extension ORDER BY 1")
                    extensions = cursor.fetchall()
                command(["pg_dump", "--format=custom", "--snapshot=" + snapshot,
                         "--dbname=" + name, "--lock-wait-timeout=30s"], target / filename, env=env)
                connection.commit()
            finally:
                connection.close()
            command(["pg_restore", "--file=/dev/null", str(target / filename)])
            databases.append({"name": name, "file": "postgresql/" + filename,
                              "tables": counts, "extensions": extensions})
        return databases


def backup_configuration(config, target):
    target.mkdir()
    ns = config["namespace"]
    releases = json.loads(command(["helm", "list", "-A", "-o", "json"]))
    for release in releases:
        name, namespace = release["name"], release["namespace"]
        stem = namespace + "--" + name
        command(["helm", "get", "values", name, "-n", namespace, "--all", "-o", "yaml"], target / (stem + "-values.yaml"))
        command(["helm", "get", "manifest", name, "-n", namespace], target / (stem + "-manifest.yaml"))
    write_json(target / "helm-releases.json", releases)
    command(["kubectl", "-n", ns, "get", "secret,configmap,deploy,sts,svc,ingress,cronjob,pvc,serviceaccount,role,rolebinding", "-o", "json"], target / "meet-resources.json")
    command(["kubectl", "get", "clusterissuer", "-o", "json"], target / "cluster-issuers.json")
    repo = Path(config["repo"])
    shutil.copytree(repo / "src/helm/env.d/aliyun-prod", target / "production-values")
    # The exact tracked source, without .git history or untracked secret files.
    command(["git", "-C", str(repo), "archive", "--format=tar.gz", "HEAD"], target / "source.tar.gz")
    shutil.copytree(config["config_dir"], target / "backup-config")
    shutil.copytree(Path(__file__).resolve().parent, target / "backup-tools",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for source in ["/etc/rancher/k3s", "/etc/systemd/system/k3s.service",
                   "/etc/systemd/system/k3s.service.env",
                   "/var/lib/rancher/k3s/server/token"]:
        path = Path(source)
        if path.exists():
            dest = target / "host" / path.relative_to("/")
            dest.parent.mkdir(parents=True, exist_ok=True)
            if path.is_dir():
                shutil.copytree(path, dest)
            else:
                shutil.copy2(path, dest)
    state = Path("/var/lib/rancher/k3s/server/db/state.db")
    if state.exists():
        with sqlite3.connect(f"file:{state}?mode=ro", uri=True, timeout=30) as source:
            with sqlite3.connect(target / "k3s-state.db") as dest:
                source.backup(dest, pages=256, sleep=0.1)
                if dest.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError("K3s SQLite backup integrity failure")
    deployments = json.loads(command(["kubectl", "-n", ns, "get", "deploy,sts", "-o", "json"]))
    return {d["metadata"]["name"]: [c["image"] for c in d["spec"]["template"]["spec"]["containers"]]
            for d in deployments["items"]}


def run_backup(config):
    import fcntl

    state = Path(config["state_dir"])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state, 0o700)
    with open(state / "backup.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        started = utcnow()
        storage = json.loads((Path(config["config_dir"]) / "storage.json").read_text())
        client = object_client(storage)
        require_private(client, storage["bucket"])
        prefix = storage["prefix"]
        if not prefix.endswith("/") or prefix.startswith("/") or ".." in prefix:
            raise ValueError("Invalid backup prefix")
        work_root = Path(config.get("work_dir", str(state)))
        work_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix="run-", dir=work_root) as directory:
            work = Path(directory)
            payload = work / "payload"
            payload.mkdir()
            print("Backing up consistent PostgreSQL snapshots", flush=True)
            databases = backup_databases(config, payload / "postgresql")
            print("Backing up deployment and recovery configuration", flush=True)
            images = backup_configuration(config, payload / "configuration")
            manifest = {
                "format_version": 1, "started_at": started.isoformat(),
                "databases": databases, "images": images,
                "source_commit": command(["git", "-C", config["repo"], "rev-parse", "HEAD"]).decode().strip(),
                "exclusions": ["Redis cache/broker: rebuild empty; review durable pending tasks",
                               "Media already in external OSS: not duplicated by this bundle",
                               "Independent Docs/IM/Keycloak hosts and databases"],
                "files": {str(p.relative_to(payload)): sha256(p) for p in sorted(payload.rglob("*")) if p.is_file()},
            }
            write_json(payload / "manifest.json", manifest)
            archive = work / "recovery.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                for child in sorted(payload.iterdir()):
                    tar.add(child, arcname=child.name)
            encrypted = work / "recovery.tar.gz.age"
            command(["age", "-R", config["recipient_file"], "-o", str(encrypted), str(archive)])
            key = prefix + started.strftime("%Y/%m/%d/%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:12] + ".tar.gz.age"
            print("Uploading encrypted archive and verifying complete read-back", flush=True)
            digest = upload_verified(client, storage["bucket"], key, encrypted)
            completed = utcnow()
            receipt = {"format_version": 1, "bucket": storage["bucket"], "key": key,
                       "sha256": digest, "bytes": encrypted.stat().st_size,
                       "started_at": started.isoformat(), "completed_at": completed.isoformat(),
                       "duration_seconds": round((completed-started).total_seconds(), 2),
                       "databases": [d["name"] for d in databases]}
            # latest.json is a success marker; never publish it for a partial backup.
            client.put_object(Bucket=storage["bucket"], Key=prefix + "latest.json",
                              Body=json.dumps(receipt).encode(), ACL="private", ContentType="application/json")
            require_private(client, storage["bucket"], prefix + "latest.json")
            write_json(state / "last-success.json", receipt)
            write_json(state / "last-attempt.json", {"status": "success", **receipt})
            print(json.dumps(receipt), flush=True)


def check_backup(config, max_age_hours):
    storage = json.loads((Path(config["config_dir"]) / "storage.json").read_text())
    client = object_client(storage)
    body = client.get_object(Bucket=storage["bucket"], Key=storage["prefix"] + "latest.json")["Body"]
    try:
        receipt = json.loads(body.read())
    finally:
        body.close()
    age = (utcnow() - dt.datetime.fromisoformat(receipt["completed_at"])).total_seconds()
    if age < -300 or age > max_age_hours * 3600:
        raise RuntimeError("Offsite backup is stale or has a future timestamp")
    head = client.head_object(Bucket=storage["bucket"], Key=receipt["key"])
    if head["ContentLength"] != receipt["bytes"] or head.get("Metadata", {}).get("sha256") != receipt["sha256"]:
        raise RuntimeError("Offsite backup receipt does not match object")
    print(f"OFFSITE_BACKUP_OK age_hours={age/3600:.2f}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["run", "check"])
    parser.add_argument("--config", default="/etc/meet-backup/config.json")
    parser.add_argument("--max-age-hours", type=float, default=8)
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text())
    try:
        if args.action == "run":
            run_backup(config)
        else:
            check_backup(config, args.max_age_hours)
    except Exception as error:
        # Exception text from storage clients/SQL can include signed URLs or data.
        print("BACKUP_FAILED " + type(error).__name__, file=sys.stderr)
        state = Path(config["state_dir"])
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        write_json(state / ("last-attempt.json" if args.action == "run" else "last-check.json"),
                   {"status": "failed", "at": utcnow().isoformat(), "error_type": type(error).__name__})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
