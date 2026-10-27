"""Signed task previews: no server-side preview table before E4."""

import hashlib
import json

from django.core import signing

from work.api.errors import WorkAPIError

SALT = "work-r0a-task-preview"
MAX_AGE_SECONDS = 600


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value) -> str:
    return f"sha256:{hashlib.sha256(canonical(value).encode()).hexdigest()}"


def sign(  # noqa: PLR0913
    context, *, intent_hash: str, input_hash: str, template_hash, mode: str, cap: int
) -> str:
    return signing.dumps(
        {
            "org": context.org_id,
            "subject": context.subject_id,
            "intent": intent_hash,
            "input": input_hash,
            "template": template_hash,
            "mode": mode,
            "cap": cap,
        },
        salt=SALT,
        compress=True,
    )


def verify(context, token: str, intent_hash: str) -> dict:
    try:
        payload = signing.loads(token, salt=SALT, max_age=MAX_AGE_SECONDS)
    except signing.BadSignature as error:
        raise WorkAPIError("preview_stale") from error
    if (
        payload.get("org") != context.org_id
        or payload.get("subject") != context.subject_id
        or payload.get("intent") != intent_hash
    ):
        raise WorkAPIError("preview_stale")
    return payload
