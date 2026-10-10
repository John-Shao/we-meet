"""Reproducible isolated Docker RTC integration, cached images and synthetic users.

Never connects to a cluster or registry, exposes host ports, or reads human media.
Only owned container IDs, anonymous volumes and the unique internal network are
removed. Credentials and diagnostics stay outside the repository.
"""

# Container-only binds/tmpfs and fixed CLI evidence are intentional in this probe.
# ruff: noqa: S104, S108, T201

import argparse
import base64
import datetime
import ipaddress
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parents[2]


def docker(*arguments, check=True, timeout=180):
    """Structured arguments, no credentials in the command line or console."""
    result = subprocess.run(  # noqa: S603 -- Operator-selected Docker CLI, structured argv without a shell.
        ["docker", *map(str, arguments)],  # noqa: S607 -- Standard operator PATH CLI.
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        check=False,
    )
    if check and result.returncode:
        raise RuntimeError("rtc_docker_fixture_step_failed")
    return result


def certificate(name, directory):
    """Ephemeral self-signed fixture CA with an exact service DNS SAN."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
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
            x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False
        )
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    encoded = cert.public_bytes(serialization.Encoding.PEM)
    (directory / (name + ".crt")).write_bytes(encoded)
    (directory / (name + ".key")).write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return encoded


def main():  # noqa: PLR0912, PLR0915 -- Keep this isolated scenario and its owned resource lifetime together.
    """Create a genuine media/application/model path without external connectivity."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-pack", required=True, type=Path)
    parser.add_argument("--diagnostics-dir", required=True, type=Path)
    parser.add_argument(
        "--backend-image", default="we-meet-backend:voiceprint-dispatch-20261011"
    )
    parser.add_argument(
        "--sampler-image", default="we-meet-voiceprint-sampler:feature-20261011"
    )
    parser.add_argument(
        "--encoder-image", default="we-meet-voiceprint:feature-20261011"
    )
    parser.add_argument("--livekit-image", default="livekit/livekit-server:latest")
    parser.add_argument(
        "--media-boundaries",
        action="store_true",
        help="Also verify native mute, track replacement and participant reconnect.",
    )
    args = parser.parse_args()
    pack, diagnostics = args.model_pack.resolve(), args.diagnostics_dir.resolve()
    if not pack.is_dir() or diagnostics.is_relative_to(ROOT):
        raise ValueError("rtc_fixture_paths_invalid")
    diagnostics.mkdir(parents=True, exist_ok=True)
    for image in (
        args.backend_image,
        args.sampler_image,
        args.encoder_image,
        args.livekit_image,
        "postgres:16-alpine",
        "redis:7-alpine",
    ):
        docker("image", "inspect", image)
    prefix = "vp-full-rtc-" + secrets.token_hex(5)
    containers, network = [], None
    with tempfile.TemporaryDirectory(prefix=prefix + "-", dir=diagnostics) as temporary:
        private = Path(temporary).resolve()
        if not private.is_relative_to(diagnostics) or private == diagnostics:
            raise ValueError("rtc_fixture_cleanup_path_invalid")
        directories = {
            name: private / name for name in ("backend", "encoder", "sampler", "driver")
        }
        for directory in directories.values():
            directory.mkdir()
        probe_diagnostics = private / "diagnostics"
        probe_diagnostics.mkdir()
        probe_diagnostics.chmod(0o777)  # Isolated synthetic output volume only.
        backend, encoder, sampler, driver = (
            directories[name] for name in ("backend", "encoder", "sampler", "driver")
        )
        api_key = "fixture-" + secrets.token_hex(8)
        (
            api_secret,
            sampling_token,
            driver_token,
            encoder_token,
            permit_key,
            db_password,
            quality_key,
        ) = [secrets.token_hex(32) for _ in range(7)]
        backend_ca = certificate("backend", backend)
        encoder_ca = certificate("encoder", encoder)
        (backend / "encoder-ca.crt").write_bytes(encoder_ca)
        (sampler / "backend-ca.crt").write_bytes(backend_ca)
        (driver / "backend-ca.crt").write_bytes(backend_ca)
        for filename, content in {
            "keyring.json": {
                "active": "fixture",
                "keys": {"fixture": base64.b64encode(os.urandom(32)).decode()},
            },
            "encoder.json": {
                "url": "https://encoder:8093",
                "api_token": encoder_token,
                "permit_key": base64.b64encode(permit_key.encode()).decode(),
                "ca_bundle": "/run/voiceprint-backend/encoder-ca.crt",
            },
            "quality.json": {
                "url": "http://127.0.0.1:8765/api/v1/services/aigc/multimodal-generation/generation",
                "api_key": quality_key,
                "ca_bundle": True,
            },
            "media.json": {"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"},
        }.items():
            (backend / filename).write_text(json.dumps(content), encoding="utf-8")
        (encoder / "api-token").write_text(encoder_token, encoding="ascii")
        (encoder / "permit-key").write_text(permit_key, encoding="ascii")
        for filename, value in (
            ("api-key", api_key),
            ("api-secret", api_secret),
            ("sampling-token", sampling_token),
        ):
            (sampler / filename).write_text(value, encoding="ascii")
        (driver / "driver.json").write_text(
            json.dumps(
                {
                    "api_key": api_key,
                    "api_secret": api_secret,
                    "driver_token": driver_token,
                    "media_boundaries": args.media_boundaries,
                }
            ),
            encoding="utf-8",
        )

        def environment(filename, values):
            path = private / filename
            path.write_text(
                "".join(f"{key}={value}\n" for key, value in values.items()),
                encoding="ascii",
            )
            return path

        postgres_env = environment(
            "postgres.env",
            {
                "POSTGRES_USER": "fixture",
                "POSTGRES_PASSWORD": db_password,
                "POSTGRES_DB": "voiceprint_rtc_fixture",
            },
        )
        backend_env = environment(
            "backend.env",
            {
                "DJANGO_SETTINGS_MODULE": "meet.settings",
                "DJANGO_CONFIGURATION": "Production",
                "DJANGO_SECRET_KEY": secrets.token_hex(32),
                "DJANGO_ALLOWED_HOSTS": "backend,127.0.0.1",
                "DATABASE_URL": f"postgresql://fixture:{db_password}@postgres:5432/voiceprint_rtc_fixture",
                "AWS_S3_ENDPOINT_URL": "http://127.0.0.1:9000",
                "AWS_S3_ACCESS_KEY_ID": "fixture",
                "AWS_S3_SECRET_ACCESS_KEY": "fixture",
                "AWS_S3_REGION_NAME": "local",
                "OIDC_OP_JWKS_ENDPOINT": "http://127.0.0.1:9999/unused",
                "REDIS_URL": "redis://redis:6379/13",
                "CELERY_BROKER_URL": "redis://redis:6379/0",
                "CELERY_ENABLED": "true",
                "CELERY_TASK_ALWAYS_EAGER": "false",
                "VOICEPRINT_SYNTHETIC_PROBE": "1",
                "VOICEPRINT_RTC_MEDIA_BOUNDARIES": "1"
                if args.media_boundaries
                else "0",
                "VOICEPRINT_PROBE_DRIVER_TOKEN": driver_token,
                "LIVEKIT_API_KEY": api_key,
                "LIVEKIT_API_SECRET": api_secret,
                "LIVEKIT_API_URL": "http://livekit:7880",
                "MEETING_VOICEPRINT_ENABLED": "true",
                "MEETING_VOICEPRINT_SAMPLING_ENABLED": "true",
                "MEETING_VOICEPRINT_QUALITY_ENABLED": "true",
                "MEETING_VOICEPRINT_TEMPLATES_ENABLED": "true",
                "MEETING_VOICEPRINT_MATCHING_ENABLED": "false",
                "MEETING_VOICEPRINT_SAMPLING_AGENT_NAME": "fixture-sampler",
                "MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN": sampling_token,
                "MEETING_VOICEPRINT_SAMPLING_SESSION_MS": "30000",
                "MEETING_VOICEPRINT_SAMPLING_CLIP_MS": "10000",
                "MEETING_VOICEPRINT_KEYRING_FILE": "/run/voiceprint-backend/keyring.json",
                "MEETING_VOICEPRINT_ENCODER_CONFIG_FILE": "/run/voiceprint-backend/encoder.json",
                "MEETING_VOICEPRINT_QUALITY_CONFIG_FILE": "/run/voiceprint-backend/quality.json",
                "MEETING_VOICEPRINT_MEDIA_CONFIG_FILE": "/run/voiceprint-backend/media.json",
                "HOME": "/tmp",
                "TMPDIR": "/tmp",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONPATH": "/app",
            },
        )
        sampler_env = environment(
            "sampler.env",
            {
                "LIVEKIT_URL": "ws://livekit:7880",
                "LIVEKIT_API_KEY_FILE": "/private/api-key",
                "LIVEKIT_API_SECRET_FILE": "/private/api-secret",
                "MEETING_VOICEPRINT_SAMPLING_AGENT_NAME": "fixture-sampler",
                "MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN_FILE": "/private/sampling-token",
                "MEETING_VOICEPRINT_ENABLED": "true",
                "MEETING_VOICEPRINT_SAMPLING_ENABLED": "true",
                "AGENT_BACKEND_API_URL": "https://backend:8000",
                "VOICEPRINT_SAMPLER_BACKEND_CA_FILE": "/private/backend-ca.crt",
                "HOME": "/tmp",
                "TMPDIR": "/tmp",
            },
        )

        def start(alias, image, *arguments, extra=()):
            identifier = docker(
                "create",
                "--name",
                prefix + "-" + alias,
                "--network",
                network,
                "--network-alias",
                alias,
                *extra,
                image,
                *arguments,
            ).stdout.strip()
            containers.append((alias, identifier))
            docker("start", identifier)
            return identifier

        try:
            network = docker("network", "create", "--internal", prefix).stdout.strip()
            net = json.loads(docker("network", "inspect", network).stdout)[0]
            subnet = ipaddress.ip_network(net["IPAM"]["Config"][0]["Subnet"])
            livekit_ip = str(subnet.network_address + 10)
            livekit = {
                "port": 7880,
                "bind_addresses": ["0.0.0.0"],
                "keys": {api_key: api_secret},
                "redis": {"address": "redis:6379"},
                "rtc": {
                    "node_ip": livekit_ip,
                    "use_external_ip": False,
                    "tcp_port": 7881,
                    "port_range_start": 50000,
                    "port_range_end": 50100,
                    "stun_servers": [],
                },
                "webhook": {
                    "api_key": api_key,
                    "urls": ["http://backend:8001/api/v1.0/rooms/webhooks-livekit/"],
                },
                "logging": {"level": "warn"},
            }
            (private / "livekit.yaml").write_text(json.dumps(livekit), encoding="utf-8")
            pg = start(
                "postgres", "postgres:16-alpine", extra=("--env-file", postgres_env)
            )
            deadline = time.monotonic() + 30
            while docker(
                "exec",
                pg,
                "pg_isready",
                "-U",
                "fixture",
                "-d",
                "voiceprint_rtc_fixture",
                check=False,
            ).returncode:
                if time.monotonic() > deadline:
                    raise RuntimeError("rtc_postgres_unready")
                time.sleep(0.2)
            start(
                "redis",
                "redis:7-alpine",
                "redis-server",
                "--save",
                "",
                "--appendonly",
                "no",
            )
            start(
                "livekit",
                args.livekit_image,
                "--config",
                "/fixture/livekit.yaml",
                extra=(
                    "--ip",
                    livekit_ip,
                    "--mount",
                    f"type=bind,source={private.as_posix()},target=/fixture,readonly",
                ),
            )
            secure = (
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
            )
            start(
                "encoder",
                args.encoder_image,
                extra=(
                    *secure,
                    "--memory",
                    "2g",
                    "--cpus",
                    "2",
                    "--tmpfs",
                    "/tmp:rw,size=64m",
                    "--mount",
                    f"type=bind,source={pack.as_posix()},target=/model,readonly",
                    "--mount",
                    f"type=bind,source={encoder.as_posix()},target=/run/encoder,readonly",
                    "--env",
                    "VOICEPRINT_MODEL_DIR=/model",
                    "--env",
                    "VOICEPRINT_ENCODER_SHA256=f8b8aa2a5a7e7ddc9043b4979a07bbefca13bfd402a0464a19c1974ea1f6a71a",
                    "--env",
                    "VOICEPRINT_API_TOKEN_FILE=/run/encoder/api-token",
                    "--env",
                    "VOICEPRINT_PERMIT_KEY_FILE=/run/encoder/permit-key",
                    "--env",
                    "VOICEPRINT_TLS_CERT_FILE=/run/encoder/encoder.crt",
                    "--env",
                    "VOICEPRINT_TLS_KEY_FILE=/run/encoder/encoder.key",
                ),
            )
            backend_id = start(
                "backend",
                args.backend_image,
                "/probe.py",
                extra=(
                    *secure,
                    "--memory",
                    "2g",
                    "--cpus",
                    "2",
                    "--tmpfs",
                    "/tmp:rw,size=256m",
                    "--env-file",
                    backend_env,
                    "--mount",
                    f"type=bind,source={backend.as_posix()},target=/run/voiceprint-backend,readonly",
                    "--mount",
                    f"type=bind,source={probe_diagnostics.as_posix()},target=/probe-diagnostics",
                    "--mount",
                    f"type=bind,source={(ROOT / 'deploy/aliyun/voiceprint_rtc_backend_probe.py').as_posix()},target=/probe.py,readonly",
                    "--entrypoint",
                    "python",
                ),
            )
            sampler_id = start(
                "sampler",
                args.sampler_image,
                extra=(
                    *secure,
                    "--memory",
                    "768m",
                    "--cpus",
                    "1",
                    "--tmpfs",
                    "/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=0700",
                    "--env-file",
                    sampler_env,
                    "--mount",
                    f"type=bind,source={sampler.as_posix()},target=/private,readonly",
                ),
            )
            startup_deadline = time.monotonic() + 120
            while True:
                backend_state = json.loads(docker("inspect", backend_id).stdout)[0][
                    "State"
                ]
                if not backend_state["Running"]:
                    raise RuntimeError("rtc_backend_startup_failed")
                backend_logs = docker("logs", backend_id)
                if '"event": "rtc_backend_fixture_ready"' in backend_logs.stdout:
                    break
                if time.monotonic() > startup_deadline:
                    raise RuntimeError("rtc_backend_startup_timeout")
                time.sleep(0.2)
            driver_id = start(
                "driver",
                args.sampler_image,
                "/probe.py",
                extra=(
                    *secure,
                    "--memory",
                    "768m",
                    "--cpus",
                    "1",
                    "--tmpfs",
                    "/tmp:rw,size=64m,uid=10001,gid=10001,mode=0700",
                    "--mount",
                    f"type=bind,source={driver.as_posix()},target=/fixture,readonly",
                    "--mount",
                    f"type=bind,source={(ROOT / 'deploy/aliyun/voiceprint_rtc_media_probe.py').as_posix()},target=/probe.py,readonly",
                    "--env",
                    "VOICEPRINT_RTC_PROBE_CONFIG=/fixture/driver.json",
                    "--entrypoint",
                    "python",
                ),
            )
            exit_code = int(docker("wait", driver_id, timeout=570).stdout.strip())
            if exit_code:
                raise RuntimeError("rtc_native_driver_failed")
            driver_log = docker("logs", driver_id)
            results = [
                json.loads(line)
                for line in driver_log.stdout.splitlines()
                if line.startswith("{") and json.loads(line).get("status") == "passed"
            ]
            if len(results) != 1:
                raise RuntimeError("rtc_missing_driver_evidence")
            if int(docker("wait", backend_id, timeout=35).stdout.strip()):
                raise RuntimeError("rtc_backend_failed")
            docker("stop", "--time", "60", sampler_id)
            state = json.loads(docker("inspect", sampler_id).stdout)[0]["State"]
            if state["ExitCode"] or state["OOMKilled"]:
                raise RuntimeError("rtc_sampler_shutdown_failed")
            print(json.dumps(results[0]), flush=True)
        finally:
            cleanup_errors = []

            def attempt(operation, *arguments, **keywords):
                try:
                    return operation(*arguments, **keywords)
                except Exception:  # noqa: BLE001 -- A diagnostic failure must not skip later owned-resource cleanup.
                    cleanup_errors.append(True)
                    return None

            for alias, identifier in containers:
                if alias != "backend":
                    continue
                inspected = attempt(docker, "inspect", identifier)
                parsed = attempt(json.loads, inspected.stdout) if inspected else None
                backend_state = parsed[0]["State"] if parsed else None
                if backend_state and backend_state["Running"]:
                    for role in ("control", "processing", "beat"):
                        output = attempt(
                            docker,
                            "exec",
                            identifier,
                            "python",
                            "-c",
                            "from pathlib import Path; print(Path('/tmp/"
                            + role
                            + ".log').read_text())",
                            check=False,
                            timeout=10,
                        )
                        if output:
                            attempt(
                                (diagnostics / f"{prefix}-{role}.log").write_text,
                                output.stdout,
                                encoding="utf-8",
                            )
                    output = attempt(
                        docker,
                        "exec",
                        identifier,
                        "python",
                        "-c",
                        "import os,urllib.request; r=urllib.request.Request('http://127.0.0.1:8766/state',headers={'X-Fixture-Driver-Token':os.environ['VOICEPRINT_PROBE_DRIVER_TOKEN']}); print(urllib.request.urlopen(r,timeout=3).read().decode())",
                        check=False,
                        timeout=10,
                    )
                    if output:
                        attempt(
                            (diagnostics / f"{prefix}-state.json").write_text,
                            output.stdout,
                            encoding="utf-8",
                        )
                    attempt(docker, "stop", "--timeout", "15", identifier)
            for filename in ("control.log", "processing.log", "beat.log", "state.json"):
                path = probe_diagnostics / filename
                if path.exists():
                    captured = attempt(path.read_bytes)
                    if captured is not None:
                        attempt(
                            (diagnostics / f"{prefix}-{filename}").write_bytes, captured
                        )
            for alias, identifier in containers:
                logs = attempt(docker, "logs", identifier)
                if logs:
                    attempt(
                        (diagnostics / f"{prefix}-{alias}.log").write_text,
                        logs.stdout + logs.stderr,
                        encoding="utf-8",
                    )
                attempt(docker, "rm", "-f", "-v", identifier)
            if network is not None:
                attempt(docker, "network", "rm", network)
            if not private.is_relative_to(diagnostics) or private == diagnostics:
                raise ValueError("rtc_fixture_cleanup_path_invalid")
            if cleanup_errors:
                if sys.exc_info()[0] is None:
                    raise RuntimeError("rtc_fixture_cleanup_incomplete")
                print(
                    json.dumps({"event": "rtc_fixture_cleanup_incomplete"}),
                    file=sys.stderr,
                )


if __name__ == "__main__":
    main()
