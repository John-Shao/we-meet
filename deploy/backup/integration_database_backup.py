#!/usr/bin/env python3
"""Local-only end-to-end database backup test. Requires Docker, age, PG16 image.

Uses synthetic data, disposable keys, an internal network and local fake object
storage. Inserts a row between counting and pg_dump to verify shared snapshots.
"""
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
from unittest.mock import patch

import backup
import database_backup as db
import verify_database_restore as restore
from verify_restore import run


class LocalObjects:
    def __init__(self, root):
        self.root, self.metadata = root, {}

    def path(self, key):
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root.resolve()):
            raise ValueError("Unsafe local object key")
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def get_bucket_acl(self, **kwargs):
        return {"Owner": {"ID": "test-owner"}, "Grants": [
            {"Grantee": {"Type": "CanonicalUser", "ID": "test-owner"}, "Permission": "FULL_CONTROL"}]}

    get_object_acl = get_bucket_acl

    def upload_file(self, path, bucket, key, ExtraArgs):
        self.path(key).write_bytes(Path(path).read_bytes())
        self.metadata[key] = ExtraArgs["Metadata"]

    def put_object(self, Bucket, Key, Body, **kwargs):
        self.path(Key).write_bytes(Body)

    def get_object(self, Bucket, Key):
        return {"Body": io.BytesIO(self.path(Key).read_bytes())}

    def head_object(self, Bucket, Key):
        return {"ContentLength": self.path(Key).stat().st_size, "Metadata": self.metadata[Key]}


def integration(image):
    name = "db-backup-test-" + uuid.uuid4().hex[:12]
    network, pg = name + "-net", name + "-pg"
    reports = []
    with tempfile.TemporaryDirectory(prefix="database-integration-") as directory:
        root = Path(directory)
        run(["docker", "image", "inspect", image])
        try:
            run(["docker", "network", "create", "--internal", network])
            run(["docker", "run", "-d", "--name", pg, "--network", network,
                 "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
                 "-e", "POSTGRES_HOST_AUTH_METHOD=trust", image])
            for _ in range(60):
                if subprocess.run(["docker", "exec", pg, "pg_isready", "-U", "postgres"], capture_output=True).returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Fixture PostgreSQL unavailable")
            identity = root / "identity.age"
            run(["age-keygen", "-o", str(identity)])
            public = run(["age-keygen", "-y", str(identity)])
            objects = LocalObjects(root / "objects")
            original_command = backup.command
            for service, database in [("docs", "impress"), ("im", "jusi_light_im"), ("keycloak", "keycloak")]:
                run(["docker", "exec", pg, "createdb", "-U", "postgres", database])
                run(["docker", "exec", "-i", pg, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database],
                    b'CREATE TABLE items(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body jsonb);'
                    b'INSERT INTO items(body) VALUES (\'{"test":1}\'), (\'{"test":2}\');'
                    b'CREATE TABLE "quoted\\name" ("value" text); INSERT INTO "quoted\\name" VALUES (\'fixture\');')
                config_dir = root / service / "config"
                config_dir.mkdir(parents=True)
                recipient = config_dir / "recipient.txt"
                recipient.write_bytes(public)
                state = root / service / "state"
                config = {"service": service, "source": {"kind": "docker", "container": pg, "user": "postgres"},
                          "databases": [database], "config_dir": str(config_dir), "state_dir": str(state),
                          "work_dir": str(root / service / "work"), "recipient_file": str(recipient)}
                storage = {"bucket": "local-only", "prefix": f"test/databases/{service}/"}
                (config_dir / "config.json").write_text(json.dumps(config))
                (config_dir / "storage.json").write_text(json.dumps(storage))
                db.validate(config, service, storage)

                def concurrent_write(args, *positional, **kwargs):
                    if any(a.startswith("--snapshot=") for a in args):
                        run(["docker", "exec", pg, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
                             "-d", database, "-c", "INSERT INTO items(body) VALUES ('{\"concurrent\":true}');"])
                    return original_command(args, *positional, **kwargs)

                with patch.object(backup, "object_client", return_value=objects), patch.object(backup, "command", side_effect=concurrent_write):
                    db.run_backup(config, storage)
                    db.check_backup(config, storage)
                receipt = json.loads((state / "last-success.json").read_text())
                report = restore.drill(objects.path(receipt["key"]), identity, receipt["sha256"],
                                       root / f"{service}-report.json", service, image)
                assert report["databases"][0]["rows_verified"] == 3  # 2 snapshot items + 1 quoted-table row.
                current = run(["docker", "exec", pg, "psql", "-XAt", "-U", "postgres", "-d", database,
                               "-c", "SELECT count(*) FROM items;"])
                assert current.strip() == b"3"  # Concurrent row exists only in the live fixture.
                assert not list(Path(config["work_dir"]).glob("run-*"))
                reports.append({"service": service, "status": report["status"], "snapshot_concurrency_verified": True})
        finally:
            subprocess.run(["docker", "rm", "-f", pg], capture_output=True, timeout=30)
            subprocess.run(["docker", "network", "rm", network], capture_output=True, timeout=30)
    print("DATABASE_INTEGRATION_OK " + json.dumps(reports))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-image", default="postgres:16-alpine")
    args = parser.parse_args()
    os.umask(0o077)
    integration(args.postgres_image)
