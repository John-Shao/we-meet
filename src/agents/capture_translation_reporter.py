"""Strict, bounded internal HTTP client for the standalone translation gateway."""

import asyncio
import json
import os
import urllib.request
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from urllib.parse import urlsplit

from plugins.qwen_live_translate import TranslationError
from transcript_writer import _open

MAX_RESPONSE = 16384
MAX_AUTH = 6000
MAX_TICKET = 4096
FINISH_ATTEMPTS = 3
MODEL = "qwen3.5-livetranslate-flash-realtime"


def authentication(raw):
    """Validate only opaque references before asking the backend to admit a ticket."""
    if not isinstance(raw, str) or len(raw) > MAX_AUTH:
        raise ValueError("invalid_authentication")
    data = json.loads(raw)
    if (
        not isinstance(data, dict)
        or set(data) != {"type", "ticket", "run_id", "capture_id", "generation"}
        or data["type"] != "authenticate"
    ):
        raise ValueError("invalid_authentication")
    for field in ("run_id", "capture_id"):
        if str(uuid.UUID(data[field])) != data[field]:
            raise ValueError("invalid_authentication")
    if (
        type(data["generation"]) is not int
        or data["generation"] < 1
        or not isinstance(data["ticket"], str)
        or not 0 < len(data["ticket"]) <= MAX_TICKET
    ):
        raise ValueError("invalid_authentication")
    return data


class CaptureTranslationReporter:
    """Never retry a potentially ambiguous provider begin; finish alone may retry."""

    def __init__(self, auth, *, base_url, token):
        """Freeze the backend origin and expected capture/run before sending secrets."""
        self.auth = authentication(json.dumps(auth))
        parsed = urlsplit(base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.path not in {"", "/"}
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or not token
        ):
            raise ValueError("invalid_backend_configuration")
        self.endpoint = base_url.rstrip("/") + "/api/agent/capture-translations/"
        self.token = token
        self.worker_id = str(uuid.uuid4())
        self.configuration = None
        self.source_revision = None
        self.receipt = None

    @classmethod
    def from_env(cls, auth):
        """Use existing server credentials only within the gateway."""
        return cls(
            auth,
            base_url=os.getenv("AGENT_BACKEND_API_URL", ""),
            token=os.getenv("AGENT_INTERNAL_API_TOKEN", ""),
        )

    async def command(self, operation, *, receipt=None):
        """Check exact source and configuration on every successful response."""
        if operation == "claim":
            path, data = "claim/", {"ticket": self.auth["ticket"]}
        elif operation in {"begin", "ready", "heartbeat"}:
            path, data = f"{self.auth['run_id']}/control/", {"operation": operation}
        elif operation == "finish":
            if self.receipt is None:
                self.receipt = dict(receipt)
            elif self.receipt != receipt:
                raise ValueError("changed_finish_receipt")
            path, data = f"{self.auth['run_id']}/finish/", self.receipt
        else:
            raise ValueError("invalid_operation")
        for attempt in range(FINISH_ATTEMPTS if operation == "finish" else 1):
            try:
                result = await asyncio.wait_for(
                    asyncio.to_thread(
                        self._send, path, {**data, "worker_id": self.worker_id}
                    ),
                    4,
                )
                self._validate(result, operation)
                return result
            except (OSError, ValueError, TypeError, KeyError, TimeoutError):
                if operation == "finish" and attempt + 1 < FINISH_ATTEMPTS:
                    await asyncio.sleep(0.2)
        raise TranslationError("translation_control_unavailable")

    def _send(self, path, data):
        request = urllib.request.Request(  # noqa: S310 -- validated operator backend origin
            self.endpoint + path,
            data=json.dumps(data).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "X-Agent-Token": self.token},
        )
        with _open(request, timeout=3) as response:
            body = response.read(MAX_RESPONSE + 1)
            if response.status != HTTPStatus.OK or len(body) > MAX_RESPONSE:
                raise ValueError("invalid_backend_response")
            return json.loads(body)

    def _validate(self, result, operation):
        if not isinstance(result, dict) or result.get("worker_id") != self.worker_id:
            raise ValueError("invalid_worker_response")
        run = result.get("run")
        if (
            not isinstance(run, dict)
            or run.get("id") != self.auth["run_id"]
            or run.get("capture_id") != self.auth["capture_id"]
            or type(run.get("generation")) is not int
            or run["generation"] != self.auth["generation"]
            or type(run.get("source_revision")) is not int
            or run["source_revision"] < 1
            or run.get("status")
            not in {"starting", "translating", "stopping", "stopped", "incomplete"}
        ):
            raise ValueError("invalid_source_response")
        config = run.get("configuration")
        if (
            not isinstance(config, dict)
            or set(config)
            != {
                "source_language",
                "target_language",
                "mode",
                "audio",
                "save_translations",
                "model",
                "region",
            }
            or config["model"] != MODEL
            or config["region"] not in {"cn-beijing", "ap-southeast-1"}
            or {config["source_language"], config["target_language"]} != {"zh", "en"}
            or config["mode"] not in {"simultaneous", "push_to_talk"}
            or type(config["audio"]) is not bool
            or type(config["save_translations"]) is not bool
        ):
            raise ValueError("invalid_configuration_response")
        deadline = datetime.fromisoformat(run["deadline"])
        if deadline.tzinfo is None or (
            operation != "finish" and deadline <= datetime.now(timezone.utc)
        ):
            raise ValueError("expired_worker_response")
        if self.configuration is not None and (
            config != self.configuration
            or run["source_revision"] != self.source_revision
        ):
            raise ValueError("changed_source_response")
        if operation == "claim" and run["status"] != "starting":
            raise ValueError("invalid_claim_response")
        if operation == "begin" and (
            result.get("execute") is not True or run["status"] != "starting"
        ):
            raise ValueError("begin_not_authorized")
        if operation != "claim" and result.get("action") != (
            "stop"
            if run["status"] == "stopping"
            else "abort"
            if run["status"] not in {"starting", "translating"}
            else "stream"
        ):
            raise ValueError("invalid_action_response")
        if operation == "finish" and run["status"] not in {"stopped", "incomplete"}:
            raise ValueError("invalid_finish_response")
        self.configuration, self.source_revision = dict(config), run["source_revision"]
