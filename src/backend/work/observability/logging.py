"""No-content logging guard (D6). Unknown fields are allowed; content is not."""

import logging

FORBIDDEN_KEYS = {
    "goal",
    "background",
    "content",
    "title",
    "prompt",
    "completion",
    "api_key",
    "secret",
    "secret_ciphertext",
    "input_ref",
    "output_ref",
    "checkpoint_ref",
}


class ContentLeakError(Exception):
    code = "egress_policy_denied"


def assert_no_content(fields: dict) -> None:
    leaked = FORBIDDEN_KEYS.intersection(fields)
    if leaked:
        raise ContentLeakError(f"content fields are not loggable: {sorted(leaked)}")


def log_event(event: str, **fields) -> None:
    assert_no_content(fields)
    logging.getLogger("work.events").info("event=%s fields=%s", event, fields)
