"""Business client for our HTTP contract. No dsh/Pi SDK dependency."""

import hashlib
import json
import re
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

CONTRACT = "work-agent/v1"
MAX_RESPONSE = 2_100_000


class AgentBoundaryError(Exception):
    """Sanitized errors; transport uncertainty must not create a new run ID."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: PLR0913, PLR0917 -- stdlib override
        return None


class AgentClient:
    def __init__(self, endpoint, token, timeout=5):
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or (
                parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
                or parsed.path not in {"", "/"}
            )
        ):
            raise ValueError("invalid agent endpoint")
        if parsed.scheme == "http" and parsed.hostname not in {
            "127.0.0.1",
            "localhost",
            "::1",
        }:
            raise ValueError("remote agent endpoints require HTTPS")
        self.endpoint = endpoint.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.opener = build_opener(NoRedirect())

    def _request(self, method, path, body=None):
        request = Request(  # noqa: S310 -- scheme checked at init; redirects disabled
            self.endpoint + path,
            method=method,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8")
            if body is not None
            else None,
            headers={
                "Authorization": "Bearer " + self.token,
                "Content-Type": "application/json",
            },
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                data = response.read(MAX_RESPONSE + 1)
        except HTTPError as exc:
            code = exc.code
            exc.close()
            raise AgentBoundaryError(f"agent_http_{code}") from None
        except (URLError, TimeoutError, OSError):
            raise AgentBoundaryError("agent_transport_unknown") from None
        if len(data) > MAX_RESPONSE:
            raise AgentBoundaryError("agent_invalid_response")
        try:
            value = json.loads(data)
            if not isinstance(value, dict) or value.get("contract") != CONTRACT:
                raise ValueError
        except (ValueError, UnicodeError):
            raise AgentBoundaryError("agent_contract_mismatch") from None
        return value

    def capabilities(self):
        return self._request("GET", "/v1/capabilities")

    @staticmethod
    def _job(value, run_id):  # noqa: PLR0912 -- explicit trust-boundary validation
        """Validate stable fields, allowing future optional response fields."""
        try:
            if value["run_id"] != run_id or value["state"] not in {
                "queued",
                "running",
                "succeeded",
                "failed",
                "cancelled",
            }:
                raise ValueError
            if not isinstance(value["error_code"], str) or not isinstance(
                value["events"], list
            ):
                raise ValueError
            previous = 0
            for event in value["events"]:
                if type(event["seq"]) is not int or event["seq"] <= previous:
                    raise ValueError
                if not isinstance(event["type"], str):
                    raise ValueError
                previous = event["seq"]
            result = value["result"]
            if value["state"] == "succeeded":
                if not isinstance(result["summary"], str) or not isinstance(
                    result["artifacts"], list
                ):
                    raise ValueError
                if len(result["artifacts"]) > 20 or len(result["summary"]) > 100000:
                    raise ValueError
                names = set()
                total = 0
                for artifact in result["artifacts"]:
                    content = artifact["text"].encode("utf-8")
                    total += len(content)
                    if artifact["sha256"] != hashlib.sha256(content).hexdigest():
                        raise ValueError
                    name = artifact["name"]
                    if (
                        not isinstance(name, str)
                        or not re.fullmatch(
                            r"[\w\-][\w .\-]{0,99}\.(?:txt|md|csv|json)", name
                        )
                        or name.casefold() in names
                    ):
                        raise ValueError
                    names.add(name.casefold())
                if total > 400000:
                    raise ValueError
            elif result is not None:
                raise ValueError
        except (KeyError, TypeError, ValueError, AttributeError):
            raise AgentBoundaryError("agent_invalid_response") from None
        return value

    def submit(self, run_id, goal, files, timeout_seconds=120, *, limits=None):
        run_id = str(uuid.UUID(str(run_id)))
        self.capabilities()  # Fail before admission if the contract is incompatible.
        body = {
            "contract": CONTRACT,
            "run_id": run_id,
            "goal": goal,
            "files": [
                {
                    "name": name,
                    "text": text,
                    "sha256": hashlib.sha256(text.encode()).hexdigest(),
                }
                for name, text in sorted(files.items())
            ],
            "timeout_seconds": timeout_seconds,
        }
        if limits is not None:
            body["limits"] = limits
        value = self._request("POST", "/v1/jobs", body)
        return self._job(value, run_id)

    def get(self, run_id, after=0):
        run_id = str(uuid.UUID(str(run_id)))
        return self._job(
            self._request("GET", f"/v1/jobs/{run_id}?after={int(after)}"), run_id
        )

    def cancel(self, run_id):
        run_id = str(uuid.UUID(str(run_id)))
        return self._job(self._request("POST", f"/v1/jobs/{run_id}/cancel"), run_id)
