"""Run real provider and business API integration in a disposable local database.

Supply DASHSCOPE_API_KEY and DASHSCOPE_WORKSPACE_ID in the environment. Exercise
SessionAuthentication or Bearer/OIDC authentication with an isolated identity
fixture. External identity-provider login and SMS delivery are not covered.
"""

# Django imports require the disposable environment to be configured first.
# ruff: noqa: PLC0415

import argparse
import io
import json
import os
import secrets
import subprocess
import sys
import threading
from pathlib import Path

from test_bilingual_backend import isolated_backend


def identity_fixture(application, user, bearer, counts):
    """Expose private userinfo for this test token without patching authentication."""

    def handle(environ, start_response):
        path = environ.get("PATH_INFO")
        if path == "/__bilingual_userinfo":
            valid = secrets.compare_digest(
                environ.get("HTTP_AUTHORIZATION", ""), f"Bearer {bearer}"
            )
            counts["accepted" if valid else "rejected"] += 1
            headers = [("Content-Type", "application/json")]
            if valid:
                body = {"sub": user.sub, "email": user.email}
                start_response("200 OK", headers)
            else:
                body = {"error": "invalid_token"}
                headers.append(("WWW-Authenticate", 'Bearer error="invalid_token"'))
                start_response("401 Unauthorized", headers)
            return [json.dumps(body).encode()]
        if path == "/__bilingual_identity_token":
            # No service-account token: optional phone sync stays local and inert.
            start_response("200 OK", [("Content-Type", "application/json")])
            return [b"{}"]
        return application(environ, start_response)

    return handle


def parse_arguments(argv=None):
    """Validate scenario selection before opening any services or database."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--android", metavar="EMULATOR_SERIAL")
    parser.add_argument("--client-only", action="store_true")
    parser.add_argument("--physical", action="store_true")
    parser.add_argument(
        "--synthetic-on-device",
        action="store_true",
        help="Explicitly run audible Chinese/English fixtures on a device without opening its microphone",
    )
    parser.add_argument(
        "--physical-routes",
        nargs="+",
        choices=("speaker", "wired", "bluetooth"),
        default=["speaker", "wired", "bluetooth"],
    )
    parser.add_argument(
        "--physical-mode", choices=("automatic", "fixed"), default="automatic"
    )
    parser.add_argument(
        "--physical-environment",
        choices=("quiet", "background_noise"),
        default="quiet",
    )
    parser.add_argument(
        "--physical-scenarios",
        nargs="+",
        choices=(
            "automatic:quiet",
            "fixed:quiet",
            "automatic:background_noise",
            "fixed:background_noise",
        ),
    )
    parser.add_argument("--auth", choices=("session", "bearer"), default="session")
    parser.add_argument("--downstream-delay-ms", type=int, default=0)
    parser.add_argument("--idle-seconds", type=int, choices=(30, 300), default=30)
    parser.add_argument(
        "--network-profile", choices=("normal", "loss-jitter"), default="normal"
    )
    args = parser.parse_args(argv)
    if args.synthetic_on_device and (
        not args.android or not args.client_only or args.physical
    ):
        parser.error(
            "--synthetic-on-device requires --android and --client-only, without --physical"
        )
    if (args.client_only or args.physical) and not args.android:
        parser.error("--client-only/--physical require --android DEVICE_SERIAL")
    if not args.physical and (
        args.physical_mode != "automatic"
        or args.physical_environment != "quiet"
        or args.physical_routes != ["speaker", "wired", "bluetooth"]
        or args.physical_scenarios
    ):
        parser.error("Physical scenario options require --physical")
    if len(args.physical_routes) != len(set(args.physical_routes)):
        parser.error("--physical-routes must not contain duplicates")
    if args.physical_scenarios and (
        args.physical_mode != "automatic" or args.physical_environment != "quiet"
    ):
        parser.error("Use --physical-scenarios or individual mode/environment options")
    if not 0 <= args.downstream_delay_ms <= 1000:
        parser.error("--downstream-delay-ms must be within 0..1000")
    if args.idle_seconds != 30 and (args.client_only or args.physical):
        parser.error(
            "--idle-seconds applies to the business probe, not device-only runs"
        )
    if args.network_profile != "normal" and not args.android:
        parser.error("--network-profile requires --android")
    return args


def run_device_scenarios(repo, config, environment, args):
    """Run selected scenarios in order and stop after the first device failure."""
    from bilingual_android_integration import run_android

    scenarios = args.physical_scenarios or [
        f"{args.physical_mode}:{args.physical_environment}"
    ]
    device_runs = []
    for scenario in scenarios:
        mode, condition = scenario.split(":")
        run = run_android(
            repo,
            {
                **config,
                "physical_mode": mode,
                "physical_environment": condition,
            },
            environment,
            args.android,
            physical=args.physical,
        )
        device_runs.append(run)
        if not run["passed"]:
            break
    return device_runs, len(scenarios)


def main():  # noqa: PLR0915 -- bounded setup with unconditional resource cleanup
    """Start a loopback API, run the agent probe and check database final states."""
    args = parse_arguments()
    if not all(
        os.getenv(key) for key in ("DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID")
    ):
        raise RuntimeError("Provider credentials must be configured in environment")
    repo = Path(__file__).resolve().parents[1]
    agents = repo / "src/agents"
    with isolated_backend():
        from django.conf import settings
        from django.core.management import call_command
        from django.core.servers.basehttp import ThreadedWSGIServer, WSGIRequestHandler
        from django.core.wsgi import get_wsgi_application
        from django.db import connections
        from django.test import Client, override_settings

        from core.factories import UserFactory
        from core.models import BilingualSession

        class QuietHandler(WSGIRequestHandler):
            """Keep cookies and request details out of acceptance output."""

            def log_message(self, *args):
                """Suppress ordinary HTTP request logging."""

        call_command("migrate", interactive=False, stdout=io.StringIO(), verbosity=0)
        token = secrets.token_urlsafe(32)
        with override_settings(
            ALLOWED_HOSTS=["127.0.0.1"],
            SECURE_SSL_REDIRECT=False,
            ASSISTANT_TRANSLATION_ENABLED=True,
            ASSISTANT_TRANSLATION_MAX_ACTIVE=1,
            ASSISTANT_TRANSLATION_MAX_DAILY=10,
            ASSISTANT_TRANSLATION_MAX_SECONDS=(
                900 if args.idle_seconds == 300 else 300 if args.physical else 120
            ),
            ASSISTANT_TRANSLATION_IDLE_SECONDS=(
                120 if args.physical else args.idle_seconds
            ),
            MEETING_CAPTURE_TRANSLATION_URL="wss://127.0.0.1/capture-translation",
            AGENT_INTERNAL_API_TOKEN=token,
            MOBILE_AUTH_SERVICE_CLIENT_SECRET="",
            CACHES={
                "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
            },
        ):
            client = Client()
            user = UserFactory()
            settings.ASSISTANT_TRANSLATION_ALLOWED_USER_IDS = [str(user.pk)]
            bearer = secrets.token_urlsafe(32)
            identity_counts = {"accepted": 0, "rejected": 0}
            if args.auth == "session":
                client.force_login(user)
                csrf = secrets.token_hex(16)
                cookie = f"{settings.SESSION_COOKIE_NAME}={client.cookies[settings.SESSION_COOKIE_NAME].value}; csrftoken={csrf}"
                headers = {"Cookie": cookie, "X-CSRFToken": csrf}
            else:
                headers = {"Authorization": f"Bearer {bearer}"}
            server = ThreadedWSGIServer(("127.0.0.1", 0), QuietHandler)
            backend = f"http://127.0.0.1:{server.server_port}"
            if args.auth == "bearer":
                settings.OIDC_OP_USER_ENDPOINT = backend + "/__bilingual_userinfo"
                settings.OIDC_OP_USER_ENDPOINT_FORMAT = "JSON"
                settings.OIDC_OP_TOKEN_ENDPOINT = (
                    backend + "/__bilingual_identity_token"
                )
                server.set_app(
                    identity_fixture(
                        get_wsgi_application(), user, bearer, identity_counts
                    )
                )
            else:
                server.set_app(get_wsgi_application())
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                environment = {
                    **os.environ,
                    "PYTHONPATH": str(agents / "src"),
                    "AGENT_BACKEND_API_URL": backend,
                    "AGENT_INTERNAL_API_TOKEN": token,
                }
                config = {
                    "downstream_delay_ms": args.downstream_delay_ms,
                    "idle_seconds": args.idle_seconds,
                    "network_profile": args.network_profile,
                    "backend": backend,
                    "agent_token": token,
                    "headers": headers,
                    "authentication": args.auth,
                    "synthetic_on_device": args.synthetic_on_device,
                    "physical_mode": args.physical_mode,
                    "physical_routes": args.physical_routes,
                    "physical_environment": args.physical_environment,
                    "assets": str(
                        repo.parent / "we-meet-android/app/src/androidTest/assets"
                    ),
                }
                if args.client_only:
                    report = {
                        "scope": "Android HTTPS/WSS integration",
                        "passed": True,
                        "checks": {},
                    }
                    expected_sessions = 0
                else:
                    result = subprocess.run(  # noqa: S603 -- fixed repository probe
                        [
                            str(agents / ".venv/Scripts/python.exe"),
                            str(agents / "scripts/live_bilingual_admission_probe.py"),
                        ],
                        input=json.dumps(config),
                        text=True,
                        capture_output=True,
                        env=environment,
                        timeout=args.idle_seconds + 240,
                        check=False,
                    )
                    if not result.stdout.strip().startswith("{"):
                        raise RuntimeError(
                            "Probe failed: " + result.stderr.splitlines()[-1][:180]
                        )
                    report = json.loads(result.stdout)
                    expected_sessions = 3
                if args.android and report["passed"]:
                    device_runs, scenario_count = run_device_scenarios(
                        repo, config, environment, args
                    )
                    report["android"] = device_runs[-1]
                    if scenario_count > 1:
                        report["android_runs"] = device_runs
                    report["checks"]["android_integration"] = len(
                        device_runs
                    ) == scenario_count and all(run["passed"] for run in device_runs)
                    expected_sessions += scenario_count * (
                        len(args.physical_routes) if args.physical else 1
                    )
                rows = list(
                    BilingualSession.objects.filter(user=user).values_list(
                        "status", flat=True
                    )
                )
                report["database_sessions"] = rows
                report["authentication"] = args.auth
                if args.auth == "bearer":
                    report["identity_fixture_requests"] = identity_counts
                    report["checks"]["bearer_userinfo_authenticated"] = (
                        identity_counts["accepted"] > 0
                    )
                report["checks"]["all_business_sessions_closed"] = all(
                    state == "closed" for state in rows
                )
                report["checks"]["expected_business_session_count"] = (
                    len(rows) == expected_sessions
                )
                report["passed"] = report["passed"] and all(report["checks"].values())
                sys.stdout.write(json.dumps(report, indent=2) + "\n")
                return 0 if report["passed"] else 1
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
                connections.close_all()


if __name__ == "__main__":
    raise SystemExit(main())
