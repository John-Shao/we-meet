"""Strict signed IM receipt protocol; old admin message writes are never a fallback."""

import json
import uuid
from dataclasses import dataclass
from urllib.parse import urlsplit

import requests

from core.services.jusi_im import JusiImAdminClient

CREATE_PATH = "/admin/messages/idempotent"
RESULT_PATH = "/admin/messages/receipt"
MAX_RESPONSE_BYTES = 16384


class ImDeliveryError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(f"IM delivery: {code}")


@dataclass(frozen=True)
class ImDeliveryReceipt:
    state: str
    message_id: int | None = None
    conversation_id: str | None = None
    replayed: bool = False


def _identity(value):
    parsed = uuid.UUID(str(value))
    if parsed.int == 0:
        raise ValueError("A nonzero UUID is required.")
    return str(parsed)


class ImDeliveryClient:
    """Reuse the HMAC signer, with bounded transport and validated receipt identity."""

    def __init__(self, api_url, secret):
        origin = urlsplit(api_url)
        if (
            origin.scheme not in {"http", "https"}
            or not origin.hostname
            or origin.path not in {"", "/"}
            or origin.username
            or origin.password
            or origin.query
            or origin.fragment
        ):
            raise ValueError("Configure the IM service origin.")
        self._url = api_url.rstrip("/")
        self._signer = JusiImAdminClient(self._url, secret)

    def create(self, key, payload):
        if not isinstance(payload, dict) or set(payload) != {
            "sender_uid",
            "cid",
            "content_type",
            "body",
        }:
            raise ValueError("Unsupported message fields.")
        sender, cid, key = (
            _identity(payload["sender_uid"]),
            _identity(payload["cid"]),
            _identity(key),
        )
        body = payload["body"]
        if (
            not isinstance(body, str)
            or not body.strip()
            or len(body.encode()) > 262144
            or payload["content_type"] not in {"text", "rich-card"}
        ):
            raise ValueError("Invalid message content.")
        return self._request(
            CREATE_PATH,
            {**payload, "request_id": key, "sender_uid": sender, "cid": cid},
            sender,
            cid,
        )

    def lookup(self, sender, key, cid):
        sender, key, cid = _identity(sender), _identity(key), _identity(cid)
        return self._request(
            RESULT_PATH, {"sender_uid": sender, "request_id": key}, sender, cid
        )

    def _request(self, path, payload, sender, cid):
        # The fresh transport nonce changes the signature, not the durable request identity.
        body = self._signer._json_body(payload)  # noqa: SLF001 -- shared exact signing protocol
        headers = self._signer._signed_headers("POST", path, body)  # noqa: SLF001
        try:
            with requests.request(
                "POST",
                self._url + path,
                data=body,
                headers=headers,
                timeout=(3, 10),
                allow_redirects=False,
                stream=True,
            ) as response:
                code = response.status_code
                if code >= 500:
                    raise ImDeliveryError("unreachable")
                if code in {401, 403}:
                    raise ImDeliveryError("access_denied")
                if code == 429:
                    raise ImDeliveryError("rate_limited")
                if code == 400:
                    raise ImDeliveryError("request_rejected")
                if code not in {200, 201, 202, 404, 409, 410}:
                    raise ImDeliveryError("unsupported")
                raw = bytearray()
                for chunk in response.iter_content(chunk_size=4096):
                    if len(raw) + len(chunk) > MAX_RESPONSE_BYTES:
                        raise ImDeliveryError("invalid_response")
                    raw.extend(chunk)
                try:
                    value = json.loads(raw)
                except (ValueError, UnicodeError):
                    raise ImDeliveryError("invalid_response") from None
                return self._parse(path, code, value, sender, cid)
        except requests.RequestException:
            raise ImDeliveryError("unreachable") from None

    @staticmethod
    def _parse(path, code, value, sender, cid):
        if not isinstance(value, dict):
            raise ImDeliveryError("invalid_response")
        if (
            path == CREATE_PATH
            and code == 409
            and value.get("code") == "sender_not_member"
        ):
            raise ImDeliveryError("sender_not_member")
        states = {
            (CREATE_PATH, 201): "ready",
            (CREATE_PATH, 200): "ready",
            (CREATE_PATH, 202): "processing",
            (CREATE_PATH, 409): "conflict",
            (CREATE_PATH, 410): "unavailable",
            (RESULT_PATH, 200): "ready",
            (RESULT_PATH, 202): "processing",
            (RESULT_PATH, 404): "not_found",
            (RESULT_PATH, 410): "unavailable",
        }
        state = value.get("state")
        if not isinstance(state, str) or state != states.get((path, code)):
            raise ImDeliveryError("unsupported")
        if state != "ready":
            return ImDeliveryReceipt(state)
        try:
            valid = (
                _identity(value["cid"]) == cid
                and _identity(value["sender_uid"]) == sender
                and all(
                    type(value[field]) is int and value[field] > 0
                    for field in ("mid", "seq", "ts")
                )
                and type(value["replayed"]) is bool
                and value["replayed"] == (code == 200)
            )
        except (ValueError, KeyError, TypeError, AttributeError):
            valid = False
        if not valid:
            raise ImDeliveryError("invalid_response")
        return ImDeliveryReceipt(state, value["mid"], cid, value["replayed"])
