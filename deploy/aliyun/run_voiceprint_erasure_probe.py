"""Run current erasure code on disposable local Docker/Beat/prefork/PostgreSQL.

Only cached images, an owned internal network and synthetic rows are used.
No existing database, queue, cluster, human voice or model service is accessed.
"""

# Container-only tmpfs and machine-readable aggregate output are intentional.
# ruff: noqa: S108, T201

import argparse
import json
import os
import secrets
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import uuid4


def docker(*arguments, check=True):
    result = subprocess.run(
        ["docker", *map(str, arguments)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=45,
        check=False,
    )  # noqa: S603, S607 -- Standard Docker CLI and structured argv.
    if check and result.returncode:
        raise RuntimeError("erasure_docker_fixture_step_failed")
    return result


def main():  # noqa: PLR0915 -- Keep owned resources and private temporary credentials in one lifetime.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-image", required=True)
    parser.add_argument("--diagnostics-dir", required=True, type=Path)
    args = parser.parse_args()
    images = (args.backend_image, "postgres:16-alpine", "redis:7-alpine")
    for name in images:
        docker("image", "inspect", name)
    image = json.loads(docker("image", "inspect", args.backend_image).stdout)[0]
    if image["Config"].get("User") != "10001:0":
        raise RuntimeError("erasure_fixture_requires_nonroot_image")
    root = args.diagnostics_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    prefix = "voiceprint-erasure-" + uuid4().hex[:12]
    containers, network = [], None
    with tempfile.TemporaryDirectory(prefix="private-", dir=root) as directory:
        private = Path(directory).resolve()
        if private.parent != root:
            raise RuntimeError("erasure_fixture_temporary_path_invalid")
        os.chmod(private, 0o700)
        password = secrets.token_hex(24)
        pg_env = private / "postgres.env"
        pg_env.write_text(
            f"POSTGRES_USER=fixture\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB=voiceprint_erasure_fixture\n",
            encoding="utf-8",
        )
        app_env = private / "backend.env"
        values = {
            "DJANGO_SETTINGS_MODULE": "meet.settings",
            "DJANGO_CONFIGURATION": "Production",
            "DJANGO_SECRET_KEY": secrets.token_hex(32),
            "DJANGO_ALLOWED_HOSTS": "127.0.0.1",
            "DATABASE_URL": f"postgresql://fixture:{password}@postgres:5432/voiceprint_erasure_fixture",
            "AWS_S3_ENDPOINT_URL": "http://127.0.0.1:9000",
            "AWS_S3_ACCESS_KEY_ID": "fixture",
            "AWS_S3_SECRET_ACCESS_KEY": "fixture",
            "AWS_S3_REGION_NAME": "local",
            "OIDC_OP_JWKS_ENDPOINT": "http://127.0.0.1:9/unused",
            "REDIS_URL": "redis://redis:6379/1",
            "CELERY_BROKER_URL": "redis://redis:6379/0",
            "CELERY_ENABLED": "true",
            "CELERY_TASK_ALWAYS_EAGER": "false",
            "MEETING_VOICEPRINT_ENABLED": "false",
            "MEETING_VOICEPRINT_MATCHING_ENABLED": "false",
            "VOICEPRINT_ERASURE_PROBE": "1",
            "PYTHONPATH": "/app",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        app_env.write_text(
            "".join(f"{key}={value}\n" for key, value in values.items()),
            encoding="utf-8",
        )
        for path in (pg_env, app_env):
            os.chmod(path, 0o600)

        def create(name, *arguments):
            identifier = docker(
                "create",
                "--name",
                prefix + "-" + name,
                "--network",
                network,
                "--label",
                "we-meet.erasure-fixture=" + prefix,
                *arguments,
            ).stdout.strip()
            containers.append(identifier)
            docker("start", identifier)
            return identifier

        try:
            network = docker(
                "network",
                "create",
                "--internal",
                "--label",
                "we-meet.erasure-fixture=" + prefix,
                prefix,
            ).stdout.strip()
            pg = create(
                "postgres",
                "--network-alias",
                "postgres",
                "--env-file",
                pg_env,
                "--tmpfs",
                "/var/lib/postgresql/data:rw,nosuid,size=512m",
                "--memory",
                "1g",
                images[1],
            )
            create(
                "redis",
                "--network-alias",
                "redis",
                "--memory",
                "128m",
                images[2],
                "redis-server",
                "--save",
                "",
                "--appendonly",
                "no",
            )
            deadline = time.monotonic() + 30
            while docker(
                "exec", pg, "pg_isready", "-U", "fixture", check=False
            ).returncode:
                if time.monotonic() >= deadline:
                    raise RuntimeError("erasure_fixture_database_not_ready")
                time.sleep(0.2)
            probe = create(
                "backend",
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
                f"type=bind,source={Path(__file__).with_name('voiceprint_erasure_probe.py').resolve()},target=/probe.py,readonly",
                args.backend_image,
                "python",
                "/probe.py",
            )
            deadline = time.monotonic() + 180
            while True:
                state = json.loads(docker("inspect", probe).stdout)[0]["State"]
                if not state["Running"]:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("erasure_fixture_runtime_timeout")
                time.sleep(0.5)
            lines = docker("logs", probe).stdout.splitlines()
            result = json.loads(lines[-1])
            if state["ExitCode"] or result.get("status") != "passed":
                (root / "probe-failure.json").write_text(
                    json.dumps(result) + "\n", encoding="utf-8"
                )
                raise RuntimeError("erasure_fixture_runtime_failed")
            result["backend_image_id"] = image["Id"]
        finally:
            # A Docker timeout may have created a resource before returning its ID.
            owned = docker(
                "ps",
                "--all",
                "--quiet",
                "--filter",
                "label=we-meet.erasure-fixture=" + prefix,
            ).stdout.splitlines()
            for identifier in reversed(owned):
                docker("rm", "--force", "--volumes", identifier)
            networks = docker(
                "network",
                "ls",
                "--quiet",
                "--filter",
                "label=we-meet.erasure-fixture=" + prefix,
            ).stdout.splitlines()
            for identifier in networks:
                docker("network", "rm", identifier)
        result["owned_containers_removed"] = len(owned)
        result["owned_network_removed"] = len(networks) == 1
    result["temporary_credentials_removed"] = True
    (root / "result.json").write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- Docker/framework error bodies are not safe diagnostic output.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__}))
        raise SystemExit(1)
