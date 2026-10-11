"""Disposable independent PostgreSQL authority with real TLS and no primary DB.

No ports, existing stores, production credentials, human data or model calls.
"""

# Private fixture tmpfs and aggregate-only diagnostics are intentional.
# ruff: noqa: PLC0415, S108, T201

import argparse
import base64
import datetime
import json
import os
import secrets
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import uuid4

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
from cryptography.x509.oid import NameOID

from run_voiceprint_erasure_probe import docker

PHASE = "preflight"


def certificate(directory):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "authority")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("authority")]), critical=False
        )
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    (directory / "server.crt").write_bytes(
        cert.public_bytes(serialization.Encoding.PEM)
    )
    (directory / "server.key").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    for path in directory.iterdir():
        os.chmod(path, 0o600)


def wait_database(container):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        ready = docker("exec", container, "pg_isready", "-U", "fixture", check=False)
        final = docker(
            "exec",
            container,
            "sh",
            "-c",
            'test "$(head -n 1 /var/lib/postgresql/data/postmaster.pid 2>/dev/null)" = 1',
            check=False,
        )
        if ready.returncode == final.returncode == 0:
            return
        time.sleep(0.2)
    raise RuntimeError("journal_fixture_database_not_ready")


def private_sql(container, script):
    return subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            container,
            "psql",
            "-X",
            "-q",
            "-t",
            "-A",
            "-v",
            "ON_ERROR_STOP=1",
            "-v",
            "VERBOSITY=sqlstate",
            "-U",
            "fixture",
            "-d",
            "voiceprint_authority_fixture",
        ],
        input=script,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=45,
        check=False,
    )  # noqa: S603, S607 -- Fixed Docker argv; private SQL stays on stdin.


def main():  # noqa: PLR0915 -- Keep owned resources, TLS and temporary credentials in one lifetime.
    global PHASE  # noqa: PLW0603 -- A fixed non-sensitive failure stage survives owned-resource cleanup.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-image", required=True)
    parser.add_argument("--diagnostics-dir", type=Path, required=True)
    args = parser.parse_args()
    for image in (args.backend_image, "postgres:16-alpine"):
        docker("image", "inspect", image)
    image = json.loads(docker("image", "inspect", args.backend_image).stdout)[0]
    if image["Config"].get("User") != "10001:0":
        raise RuntimeError("journal_fixture_nonroot_image_required")
    root = args.diagnostics_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    prefix = "voiceprint-journal-" + uuid4().hex[:12]
    label = "we-meet.journal-fixture=" + prefix
    with tempfile.TemporaryDirectory(prefix="private-", dir=root) as directory:
        private = Path(directory).resolve()
        if private.parent != root:
            raise RuntimeError("journal_fixture_temporary_path_invalid")
        os.chmod(private, 0o700)
        ssl = private / "ssl"
        ssl.mkdir(mode=0o700)
        certificate(ssl)
        deployment = str(uuid4())
        password = secrets.token_hex(24)
        role_passwords = {role: secrets.token_hex(24) for role in ("reader", "writer")}
        pg_env = private / "postgres.env"
        pg_env.write_text(
            f"POSTGRES_USER=fixture\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB=voiceprint_authority_fixture\n",
            encoding="utf-8",
        )
        signing = ed25519.Ed25519PrivateKey.generate()
        common = {
            "v": 1,
            "deployment_id": deployment,
            "encryption_key": base64.b64encode(os.urandom(32)).decode(),
        }
        packed = {}
        for role in ("reader", "writer"):
            field = "verification_key" if role == "reader" else "signing_key"
            raw = (
                signing.public_key().public_bytes(
                    serialization.Encoding.Raw, serialization.PublicFormat.Raw
                )
                if role == "reader"
                else signing.private_bytes(
                    serialization.Encoding.Raw,
                    serialization.PrivateFormat.Raw,
                    serialization.NoEncryption(),
                )
            )
            packed[role] = {
                **common,
                field: base64.b64encode(raw).decode(),
                "database": {
                    "host": "authority",
                    "port": 5432,
                    "name": "voiceprint_authority_fixture",
                    "user": "voiceprint_journal_" + role,
                    "password": role_passwords[role],
                    "ca_file": "/ca.crt",
                },
            }
        values = {
            "DJANGO_SETTINGS_MODULE": "meet.settings",
            "DJANGO_CONFIGURATION": "Production",
            "DJANGO_SECRET_KEY": secrets.token_hex(32),
            "DJANGO_ALLOWED_HOSTS": "127.0.0.1",
            "DATABASE_URL": "postgresql://fixture:unused@primary-unavailable:5432/primary_unavailable",
            "AWS_S3_ENDPOINT_URL": "http://127.0.0.1:9000",
            "AWS_S3_ACCESS_KEY_ID": "fixture",
            "AWS_S3_SECRET_ACCESS_KEY": "fixture",
            "AWS_S3_REGION_NAME": "local",
            "OIDC_OP_JWKS_ENDPOINT": "http://127.0.0.1:9/unused",
            "REDIS_URL": "redis://127.0.0.1:9/0",
            "MEETING_VOICEPRINT_ENABLED": "false",
            "MEETING_VOICEPRINT_SAMPLING_ENABLED": "false",
            "MEETING_VOICEPRINT_MATCHING_ENABLED": "false",
            "VOICEPRINT_JOURNAL_PROBE": "1",
            "VOICEPRINT_JOURNAL_FIXTURE": json.dumps(packed, separators=(",", ":")),
            "PYTHONPATH": "/app",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        app_env = private / "backend.env"
        app_env.write_text(
            "".join(f"{key}={value}\n" for key, value in values.items()),
            encoding="utf-8",
        )
        for path in (pg_env, app_env):
            os.chmod(path, 0o600)
        try:
            network = docker(
                "network", "create", "--internal", "--label", label, prefix
            ).stdout.strip()
            volume = docker(
                "volume", "create", "--label", label, prefix + "-data"
            ).stdout.strip()
            # Root installs the fixture TLS key with real POSIX permissions before
            # the standard entrypoint initializes and drops to the postgres user.
            setup = (
                "install -o postgres -g postgres -m 600 /ssl/server.key /tmp/journal.key\n"
                "install -o postgres -g postgres -m 600 /ssl/server.crt /tmp/journal.crt\n"
                "printf 'local all all trust\\nhostssl all all all scram-sha-256\\n' >/tmp/journal.hba\n"
                "chown postgres:postgres /tmp/journal.hba\nchmod 600 /tmp/journal.hba\n"
                "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/journal.crt "
                "-c ssl_key_file=/tmp/journal.key -c hba_file=/tmp/journal.hba"
            )
            pg = docker(
                "create",
                "--name",
                prefix + "-authority",
                "--network",
                network,
                "--network-alias",
                "authority",
                "--network-alias",
                "wrong-authority",
                "--label",
                label,
                "--env-file",
                pg_env,
                "--memory",
                "1g",
                "--mount",
                f"type=volume,source={volume},target=/var/lib/postgresql/data",
                "--mount",
                f"type=bind,source={ssl},target=/ssl,readonly",
                "--entrypoint",
                "/bin/sh",
                "postgres:16-alpine",
                "-c",
                setup,
            ).stdout.strip()
            docker("start", pg)
            PHASE = "authority_started"
            wait_database(pg)
            sql = "".join(
                "CREATE ROLE voiceprint_journal_"
                + role
                + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
                "NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '"
                + role_passwords[role]
                + "';\n"
                for role in ("reader", "writer")
            )
            created = private_sql(pg, sql)
            if created.returncode:
                raise RuntimeError("journal_fixture_roles_failed")
            schema = (
                Path(__file__)
                .with_name("voiceprint_journal_schema.sql")
                .read_text(encoding="utf-8")
            )
            rejected = private_sql(
                pg, "ALTER ROLE voiceprint_journal_reader SUPERUSER;\n" + schema
            )
            absent = private_sql(
                pg,
                "SELECT count(*) FROM pg_catalog.pg_namespace "
                "WHERE nspname = 'voiceprint_journal';",
            )
            if (
                rejected.returncode == 0
                or "P0001" not in rejected.stderr
                or absent.returncode
                or absent.stdout.strip() != "0"
            ):
                raise RuntimeError("journal_fixture_role_preflight_failed")
            sql = "ALTER ROLE voiceprint_journal_reader NOSUPERUSER;\n" + schema
            sql += (
                "\nINSERT INTO voiceprint_journal.heads(deployment) VALUES ('"
                + deployment
                + "');\n"
            )
            installed = private_sql(pg, sql)
            if installed.returncode:
                raise RuntimeError("journal_fixture_schema_failed")
            PHASE = "schema_installed"
            probe = docker(
                "create",
                "--name",
                prefix + "-backend",
                "--network",
                network,
                "--label",
                label,
                "--env-file",
                app_env,
                "--read-only",
                "--user",
                "10001:0",
                "--cpus",
                "2",
                "--memory",
                "1g",
                "--tmpfs",
                "/tmp:rw,nosuid,size=128m,uid=10001,gid=0,mode=0700",
                "--mount",
                f"type=bind,source={ssl / 'server.crt'},target=/ca.crt,readonly",
                "--mount",
                f"type=bind,source={Path(__file__).with_name('voiceprint_journal_probe.py').resolve()},target=/probe.py,readonly",
                args.backend_image,
                "python",
                "/probe.py",
            ).stdout.strip()
            docker("start", probe)
            PHASE = "backend_running"
            deadline = time.monotonic() + 60
            restarted = False
            while True:
                state = json.loads(docker("inspect", probe).stdout)[0]["State"]
                if not state["Running"]:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("journal_fixture_timeout")
                phase = docker("exec", probe, "cat", "/tmp/journal/phase", check=False)
                if phase.stdout.strip() == "published" and not restarted:
                    docker("restart", pg)
                    wait_database(pg)
                    docker(
                        "exec",
                        probe,
                        "python",
                        "-c",
                        "from pathlib import Path; Path('/tmp/journal/restarted').touch()",
                    )
                    restarted = True
                time.sleep(0.5)
            result = json.loads(docker("logs", probe).stdout.splitlines()[-1])
            if state["ExitCode"] or result.get("status") != "passed":
                (root / "probe-failure.json").write_text(
                    json.dumps(result) + "\n", encoding="utf-8"
                )
                raise RuntimeError("journal_fixture_runtime_failed")
            result["backend_image_id"] = image["Id"]
            result["misconfigured_role_schema_rejected"] = True
            if not restarted:
                raise RuntimeError("journal_fixture_restart_missing")
        finally:
            owned = docker(
                "ps", "--all", "--quiet", "--filter", "label=" + label
            ).stdout.splitlines()
            for identifier in reversed(owned):
                docker("rm", "--force", "--volumes", identifier)
            networks = docker(
                "network", "ls", "--quiet", "--filter", "label=" + label
            ).stdout.splitlines()
            for identifier in networks:
                docker("network", "rm", identifier)
            volumes = docker(
                "volume", "ls", "--quiet", "--filter", "label=" + label
            ).stdout.splitlines()
            for identifier in volumes:
                docker("volume", "rm", identifier)
        result["owned_containers_removed"] = len(owned)
        result["owned_network_removed"] = len(networks) == 1
        result["owned_volume_removed"] = len(volumes) == 1
    result["temporary_credentials_removed"] = True
    (root / "result.json").write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- Private SQL/configuration errors never enter diagnostics.
        print(
            json.dumps(
                {"status": "failed", "error_type": type(error).__name__, "phase": PHASE}
            )
        )
        raise SystemExit(1)
