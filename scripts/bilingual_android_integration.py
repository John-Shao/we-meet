"""Connect an emulator to a disposable HTTPS API and actual TLS translation gateway."""

# Called only after Django's disposable test settings have been initialized.
# ruff: noqa: PLC0415, S603

import base64
import ipaddress
import json
import queue
import shlex
import shutil
import ssl
import subprocess
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def certificate(directory):
    """Create a short-lived test certificate; never disable hostname verification."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(hours=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.DNSName("localhost"),
                    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                ]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    pem = directory / "certificate.pem"
    private = directory / "key.pem"
    pem.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    private.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return (
        pem,
        private,
        base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode(),
    )


def device_report(result, serial, delay_ms, *, physical, authentication):
    """Keep acceptance metadata without audio, transcripts or session credentials."""
    passed = result.returncode == 0 and "OK (1 test)" in result.stdout
    return {
        "scope": (
            "Android controller, Retrofit HTTPS, OkHttp WSS, real backend admission and provider; "
            + (
                "physical microphone and audio routes"
                if physical
                else "synthetic microphone"
            )
            + (
                "; Bearer/OIDC with loopback userinfo fixture"
                if authentication == "bearer"
                else "; fixture login session"
            )
        ),
        "passed": passed,
        "device": serial,
        "physical_microphone": physical,
        "authentication": authentication,
        "downstream_delay_ms": delay_ms,
        "route_results": [
            line.split("bilingual_result=", 1)[1]
            for line in result.stdout.splitlines()
            if "bilingual_result=" in line
        ],
        "checks": {"android_integration": passed},
        "runner_output": result.stdout[-2500:],
    }


def start_https_api(pem, key):
    """Serve the isolated Django application over TLS on a private loopback port."""
    from django.core.servers.basehttp import ThreadedWSGIServer, WSGIRequestHandler
    from django.core.wsgi import get_wsgi_application

    class QuietHandler(WSGIRequestHandler):
        """Keep all request details private."""

        def log_message(self, *args):
            """Suppress request logs."""

    api = ThreadedWSGIServer(("127.0.0.1", 0), QuietHandler)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(pem, key)
    api.socket = tls.wrap_socket(api.socket, server_side=True)
    api.set_app(get_wsgi_application())
    thread = threading.Thread(target=api.serve_forever, daemon=True)
    thread.start()
    return api, thread


def run_android(repo, config, environment, serial, *, physical=False):
    """Run the opt-in device test and remove only this harness's reverse mappings."""
    from django.conf import settings

    if not physical and not serial.startswith("emulator-"):
        raise ValueError("This automated harness requires an emulator")
    adb = [shutil.which("adb") or "adb", "-s", serial]
    agents = repo / "src/agents"
    with TemporaryDirectory(prefix="bilingual-tls-") as temporary:
        pem, key, encoded = certificate(Path(temporary))
        api, thread = start_https_api(pem, key)
        child = subprocess.Popen(
            [
                str(agents / ".venv/Scripts/python.exe"),
                str(agents / "scripts/bilingual_test_gateway.py"),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
        )
        mappings = []
        network = None
        report = None
        try:
            child.stdin.write(
                json.dumps(
                    {
                        "certificate": str(pem),
                        "key": str(key),
                        "downstream_delay_ms": config.get("downstream_delay_ms", 0),
                    }
                )
                + "\n"
            )
            child.stdin.flush()
            startup = queue.Queue()
            threading.Thread(
                target=lambda: startup.put(child.stdout.readline()), daemon=True
            ).start()
            ready = startup.get(timeout=40)
            gateway_port = json.loads(ready)["port"]
            settings.MEETING_CAPTURE_TRANSLATION_URL = (
                f"wss://localhost:{gateway_port}/capture-translation"
            )
            settings.ALLOWED_HOSTS = ["127.0.0.1", "localhost"]
            if config.get("network_profile", "normal") == "loss-jitter":
                from bilingual_network_impairment import NetworkProxy

                network = NetworkProxy(gateway_port)
                network.start()
            for port in (api.server_port, gateway_port):
                mapping = f"tcp:{port}"
                destination = (
                    f"tcp:{network.port}"
                    if network and port == gateway_port
                    else mapping
                )
                subprocess.run(
                    [*adb, "reverse", "--no-rebind", mapping, destination],
                    check=True,
                    capture_output=True,
                )
                mappings.append(mapping)
            command = [
                "am",
                "instrument",
                "-w",
                "-r",
                "-e",
                "class",
                "com.we.meet.ui.ai.BilingualLiveIntegrationTest",
            ]
            arguments = {
                "bilingual_api": f"https://localhost:{api.server_port}/",
                "bilingual_ca": encoded,
                "bilingual_physical": str(physical).lower(),
                "bilingual_physical_routes": ",".join(
                    config.get("physical_routes", ["speaker", "wired", "bluetooth"])
                ),
                "bilingual_physical_mode": config.get("physical_mode", "automatic"),
                "bilingual_physical_environment": config.get(
                    "physical_environment", "quiet"
                ),
            }
            if config.get("authentication") == "bearer":
                arguments["bilingual_authorization"] = config["headers"][
                    "Authorization"
                ]
            else:
                arguments.update(
                    bilingual_cookie=config["headers"]["Cookie"],
                    bilingual_csrf=config["headers"]["X-CSRFToken"],
                )
            for name, value in arguments.items():
                command.extend(["-e", name, value])
            command.append("com.we.meet.test/androidx.test.runner.AndroidJUnitRunner")
            result = subprocess.run(
                [*adb, "shell", " ".join(shlex.quote(part) for part in command)],
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=1100 if physical else 180,
                check=False,
            )
            report = device_report(
                result,
                serial,
                config.get("downstream_delay_ms", 0),
                physical=physical,
                authentication=config.get("authentication", "session"),
            )
            if physical:
                report.update(
                    requested_routes=config.get(
                        "physical_routes", ["speaker", "wired", "bluetooth"]
                    ),
                    physical_mode=config.get("physical_mode", "automatic"),
                    declared_environment=config.get("physical_environment", "quiet"),
                )
            return report
        finally:
            try:
                for mapping in mappings:
                    subprocess.run(
                        [*adb, "reverse", "--remove", mapping],
                        check=False,
                        capture_output=True,
                    )
                try:
                    output, _ = child.communicate("stop\n", timeout=25)
                    if report is not None and output.strip():
                        report.update(json.loads(output))
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate()
                api.shutdown()
                api.server_close()
                thread.join(timeout=5)
            finally:
                if network is not None:
                    network.close()
                    if report is not None:
                        report["network_impairment"] = network.report
                        report["checks"]["actual_packet_loss_exercised"] = any(
                            item.get("drops", 0) > 0
                            for item in network.report.get("qdisc", [])
                        )
                        report["passed"] = report["passed"] and all(
                            report["checks"].values()
                        )
