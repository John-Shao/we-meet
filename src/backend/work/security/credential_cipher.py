"""D-03 B static credential encryption: one master key, per-org HKDF.

The master key comes from the process environment/Secret only. It is never
stored in PostgreSQL, never logged and never returned in an error. Missing or
malformed key material fails closed.
"""

import base64
import hashlib
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from work.api.errors import WorkAPIError

ENV_KEY = "WORK_CREDENTIAL_MASTER_KEY"
INFO = b"work-r0a-credential-v1"
NONCE_BYTES = 12


def _master_key() -> bytes:
    raw = os.environ.get(ENV_KEY, "").strip()
    if not raw:
        raise WorkAPIError("service_degraded")
    try:
        if len(raw) == 64:
            key = bytes.fromhex(raw)
        else:
            key = base64.b64decode(raw, validate=True)
    except ValueError as error:
        raise WorkAPIError("service_degraded") from error
    if len(key) != 32:
        raise WorkAPIError("service_degraded")
    return key


def _org_key(org_id: str) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=org_id.encode("utf-8"),
        info=INFO,
    ).derive(_master_key())


def encrypt(org_id: str, plaintext: bytes) -> bytes:
    nonce = os.urandom(NONCE_BYTES)
    return nonce + AESGCM(_org_key(org_id)).encrypt(nonce, plaintext, None)


def decrypt(org_id: str, ciphertext: bytes) -> bytes:
    if len(ciphertext) <= NONCE_BYTES:
        raise WorkAPIError("service_degraded")
    nonce, body = ciphertext[:NONCE_BYTES], ciphertext[NONCE_BYTES:]
    try:
        return AESGCM(_org_key(org_id)).decrypt(nonce, body, None)
    except Exception as error:
        raise WorkAPIError("service_degraded") from error


def fingerprint(value: str) -> str:
    return "fp:" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]
