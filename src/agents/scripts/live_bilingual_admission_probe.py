"""Real HTTP admission and provider integration, driven by an isolated backend.

The parent supplies a disposable authenticated session over stdin. No production
identity, business database, deployment or routes are modified.
"""

import asyncio
import json
import logging
import sys
import traceback
import urllib.error
import urllib.request
from http import HTTPStatus
from pathlib import Path

from live_bilingual_probe import probe

PROTOCOL_VERSION = 2
MIN_HEARTBEATS = 2


def request(config, path, payload=None, *, authenticated=True, internal=False):
    """Use real HTTP authentication and never include credentials in the report."""
    headers = {"Content-Type": "application/json"}
    if authenticated:
        headers.update(config["headers"])
    if internal:
        headers["X-Agent-Token"] = config["agent_token"]
    message = urllib.request.Request(  # noqa: S310 -- loopback from parent harness
        config["backend"] + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(message, timeout=10) as response:  # noqa: S310
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, {}


async def main():
    """Check the business boundary before creating each paid provider connection."""
    config = json.load(sys.stdin)
    report = {
        "scope": (
            "real HTTP authentication, PostgreSQL admission, gateway and provider; "
            + (
                "Bearer/OIDC with loopback userinfo fixture"
                if config.get("authentication") == "bearer"
                else "login session is a fixture"
            )
        ),
        "checks": {},
        "cases": [],
    }
    checks = report["checks"]
    ticket_path = "/api/v1.0/assistant-translation/ticket/"
    claim_path = "/api/agent/assistant-translation/claim/"
    pair = {"protocol_version": 2, "source_language": "zh", "target_language": "en"}
    checks["unauthenticated_ticket_rejected"] = request(
        config, ticket_path, pair, authenticated=False
    )[0] in (HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN)
    if config.get("authentication") == "bearer":
        invalid = {**config, "headers": {"Authorization": "Bearer invalid-test-token"}}
        checks["invalid_bearer_rejected"] = (
            request(invalid, ticket_path, pair)[0] == HTTPStatus.UNAUTHORIZED
        )
    status, catalog = request(config, "/api/v1.0/assistant-translation/config/")
    checks["authenticated_config_v2"] = (
        status == HTTPStatus.OK
        and catalog.get("protocol_version") == PROTOCOL_VERSION
        and catalog.get("enabled")
    )
    for fixed, voice, hold, idle in (
        ("zh", "Ethan", 22, False),
        (None, "Tina", 0, False),
        (None, "Tina", 0, True),
    ):
        case_name = "idle" if idle else "fixed" if fixed else "automatic"
        status, ticket = request(
            config, ticket_path, {**pair, "fixed_source": fixed, "voice": voice}
        )
        if status != HTTPStatus.OK:
            raise RuntimeError(f"ticket_status_{status}")
        checks[f"{case_name}_active_quota_rejected"] = (
            request(config, ticket_path, pair)[0] == HTTPStatus.TOO_MANY_REQUESTS
        )
        checks[f"{case_name}_ordinary_user_cannot_claim"] = (
            request(config, claim_path, {"ticket": ticket["ticket"]})[0]
            == HTTPStatus.FORBIDDEN
        )
        try:
            async with asyncio.timeout(
                config.get("idle_seconds", 30) + 80 if idle else 110
            ):
                case = await probe(
                    Path(config["assets"]),
                    fixed,
                    admission=ticket,
                    voice=voice,
                    hold_seconds=hold,
                    idle_noise=idle,
                    idle_seconds=config.get("idle_seconds", 30),
                )
        except Exception as error:
            case = {
                "mode": case_name,
                "passed": False,
                "error_class": type(error).__name__,
                "frames": [
                    f"{Path(frame.filename).name}:{frame.lineno}"
                    for frame in traceback.extract_tb(error.__traceback__)
                ],
            }
        report["cases"].append(case)
        checks[f"{case_name}_consumed_ticket_cannot_reopen"] = (
            request(
                config,
                claim_path,
                {"ticket": ticket["ticket"]},
                authenticated=False,
                internal=True,
            )[0]
            == HTTPStatus.FORBIDDEN
        )
        if not case["passed"]:
            break
    checks["real_heartbeat"] = report["cases"][0].get("heartbeats", 0) >= MIN_HEARTBEATS
    checks["retired_direct_endpoint"] = (
        request(config, "/api/v1.0/assistant-translation/session/", {})[0]
        == HTTPStatus.UPGRADE_REQUIRED
    )
    report["passed"] = all(checks.values()) and all(
        case["passed"] for case in report["cases"]
    )
    sys.stdout.write(json.dumps(report, indent=2) + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.CRITICAL)
    raise SystemExit(asyncio.run(main()))
