"""Strict, bounded Docs receipt protocol for versioned meeting minutes delivery."""

import json
import uuid
from dataclasses import dataclass
from urllib.parse import urlsplit

import requests

MAX_RESPONSE_BYTES = 32768
CREATE_PATH = "/api/v1.0/documents/create-for-owner-idempotent/"
RESULT_PATH = "/api/v1.0/documents/create-for-owner-result/"


class DocsDeliveryError(Exception):
    """Safe classification only; never retain upstream bodies, tokens or content."""

    def __init__(self, code):
        self.code = code
        super().__init__(f"Docs delivery: {code}")


@dataclass(frozen=True)
class DocsCreationReceipt:
    """Only ready receipts contain a validated document identity."""

    state: str
    document_id: str | None = None
    replayed: bool = False


class DocsDeliveryClient:
    """No retries, no redirects and no fallback to legacy document creation."""

    def __init__(self, api_url, token):
        parsed = urlsplit(api_url)
        if (
            parsed.scheme not in {"https", "http"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or not token
        ):
            raise ValueError("A configured Docs origin and server token are required.")
        self._url = api_url.rstrip("/")
        self._token = token

    @staticmethod
    def _identity(sub, key):
        if not isinstance(sub, str) or not sub.strip() or len(sub) > 255:
            raise ValueError("A trusted owner subject is required.")
        return sub, str(uuid.UUID(str(key)))

    def create(self, key, payload):
        """Send the caller's persisted request to the dedicated idempotent endpoint."""
        allowed = {"sub", "email", "title", "content", "language", "message", "subject"}
        if not isinstance(payload, dict) or set(payload) - allowed:
            raise ValueError("Unsupported document creation payload.")
        _, key = self._identity(payload.get("sub"), key)
        title, content = payload.get("title"), payload.get("content")
        if (
            not isinstance(title, str)
            or not title.strip()
            or len(title) > 255
            or not isinstance(content, str)
            or not content.strip()
            or len(content) > 1000000
            or len(content.encode("utf-8")) > 2000000
            or any(
                value is not None and not isinstance(value, str)
                for value in payload.values()
            )
        ):
            raise ValueError("Invalid document creation payload.")
        return self._request("POST", CREATE_PATH, key, json=dict(payload))

    def lookup(self, sub, key):
        """A generic 404 is unsupported, not a receipt proving non-creation."""
        sub, key = self._identity(sub, key)
        return self._request("GET", RESULT_PATH, key, params={"sub": sub})

    def _request(self, method, path, key, **kwargs):
        try:
            with requests.request(
                method,
                self._url + path,
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Idempotency-Key": key,
                },
                timeout=(3, 10),
                allow_redirects=False,
                stream=True,
                **kwargs,
            ) as response:
                code = response.status_code
                if code >= 500:
                    raise DocsDeliveryError("unreachable")
                if code == 429:
                    raise DocsDeliveryError("rate_limited")
                if code in {401, 403}:
                    raise DocsDeliveryError("access_denied")
                if code == 400:
                    raise DocsDeliveryError("request_rejected")
                if 300 <= code < 400 or code not in {200, 201, 202, 404, 409, 410}:
                    raise DocsDeliveryError("unsupported")
                body = bytearray()
                for chunk in response.iter_content(chunk_size=8192):
                    if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                        raise DocsDeliveryError("invalid_response")
                    body.extend(chunk)
                try:
                    value = json.loads(body)
                except (ValueError, UnicodeError):
                    raise DocsDeliveryError("invalid_response") from None
                return self._parse(method, code, value)
        except requests.RequestException:
            # The caller must reconcile; a POST may already have committed.
            raise DocsDeliveryError("unreachable") from None

    @staticmethod
    def _parse(method, code, value):
        if not isinstance(value, dict):
            raise DocsDeliveryError("invalid_response")
        state = value.get("state")
        accepted = {
            ("GET", 200): {"ready"},
            ("POST", 200): {"ready"},
            ("POST", 201): {"ready"},
            ("GET", 202): {"processing"},
            ("POST", 409): {"processing", "conflict"},
            ("GET", 404): {"not_found"},
            ("GET", 410): {"unavailable"},
            ("POST", 410): {"unavailable"},
        }
        if not isinstance(state, str) or state not in accepted.get(
            (method, code), set()
        ):
            raise DocsDeliveryError("unsupported")
        if state == "ready":
            try:
                identity = str(uuid.UUID(value["id"]))
            except (KeyError, TypeError, ValueError, AttributeError):
                raise DocsDeliveryError("invalid_response") from None
            replayed = value.get("replayed")
            if not isinstance(replayed, bool) or replayed != (code == 200):
                raise DocsDeliveryError("invalid_response")
            return DocsCreationReceipt(state, identity, replayed)
        return DocsCreationReceipt(state)
