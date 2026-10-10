"""One-shot bounded ASR subprocess; only fixed quality evidence crosses stdout."""

import base64
import binascii
import hashlib
import json
import sys
import time

from core.services import voiceprint_quality as quality
from core.services.voiceprint_encoder import EncoderError
from core.services.voiceprint_prompt import challenge_digest, prompt_matches
from core.services.voiceprint_rpc_process import (
    MAX_INPUT_BYTES,
    MAX_PROCESS_SECONDS,
    ProcessTransport,
    wait_output,
)


def extract(  # noqa: PLR0913 -- Explicit request context and live authorization.
    wav, *, config, locale, prompt, expires, authorized, seconds=MAX_PROCESS_SECONDS
):
    config.validate()
    duration = quality.audio_duration(wav)
    if not isinstance(prompt, str) or not prompt_matches(
        prompt, locale=locale, prompt=prompt
    ):
        raise quality.QualityError("quality_input_invalid")
    body = run(
        wav,
        config=config,
        context={"locale": locale, "prompt": prompt},
        expires=expires,
        authorized=authorized,
        seconds=seconds,
    )
    return quality.decode_result(
        body,
        digest=hashlib.sha256(wav).hexdigest(),
        prompt_digest=challenge_digest(locale, prompt),
        duration=duration,
    )


def extract_query(wav, *, config, expires, authorized, seconds=MAX_PROCESS_SECONDS):
    config.validate()
    duration = quality.audio_duration(wav)
    body = run(
        wav,
        config=config,
        context={"purpose": "query"},
        expires=expires,
        authorized=authorized,
        seconds=seconds,
    )
    return quality.decode_query_result(
        body,
        digest=hashlib.sha256(wav).hexdigest(),
        duration=duration,
    )


def run(  # noqa: PLR0913 -- Explicit bounded request, authorization and deadline.
    wav, *, config, context, expires, authorized, seconds
):
    if type(seconds) not in (float, int) or not 0 < seconds <= MAX_PROCESS_SECONDS:
        raise quality.QualityError("quality_configuration_invalid")
    if type(expires) is not int or expires <= time.time():
        raise quality.QualityError("quality_lease_expired")
    if not authorized():
        raise quality.QualityError("quality_authorization_revoked")
    deadline = time.monotonic() + min(seconds, expires - time.time())
    payload = json.dumps(
        {
            "wav": base64.b64encode(wav).decode("ascii"),
            "config": config.payload(),
            **context,
            "expires": expires,
        },
        separators=(",", ":"),
    ).encode("ascii")
    if len(payload) > MAX_INPUT_BYTES:
        raise quality.QualityError("quality_input_invalid")
    try:
        with ProcessTransport(
            payload, deadline=deadline, purpose="quality"
        ) as transport:
            encoded = wait_output(transport, deadline=deadline, authorized=authorized)
    except EncoderError as error:
        code = str(error).replace("encoder_", "quality_", 1)
        raise quality.QualityError(
            code if code in quality.ERROR_CODES else "quality_worker_unavailable",
            retryable=error.retryable,
        ) from None
    if time.monotonic() >= deadline:
        raise quality.QualityError("quality_deadline_exceeded", retryable=True)
    if len(encoded) > 4096:
        raise quality.QualityError("quality_response_too_large")
    try:
        body = json.loads(encoded)
        if isinstance(body, dict) and set(body) == {"error", "retryable"}:
            if (
                not isinstance(body["error"], str)
                or body["error"] not in quality.ERROR_CODES
                or type(body["retryable"]) is not bool
            ):
                raise ValueError
            raise quality.QualityError(body["error"], retryable=body["retryable"])
    except (ValueError, UnicodeError, RecursionError) as error:
        if isinstance(error, quality.QualityError):
            raise
        raise quality.QualityError("quality_response_invalid") from None
    return body


def dispatch(value):
    if not isinstance(value, dict) or not isinstance(value.get("wav"), str):
        raise ValueError
    if (
        set(value) == {"wav", "config", "expires", "purpose"}
        and value["purpose"] == "query"
    ):
        return quality.check_query(
            base64.b64decode(value["wav"], validate=True),
            config=quality.configuration(value["config"]),
            expires=value["expires"],
        )
    if set(value) != {"wav", "config", "locale", "prompt", "expires"}:
        raise ValueError
    return quality.check(
        base64.b64decode(value["wav"], validate=True),
        config=quality.configuration(value["config"]),
        locale=value["locale"],
        prompt=value["prompt"],
        expires=value["expires"],
    )


def main():
    try:
        encoded = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(encoded) > MAX_INPUT_BYTES:
            raise ValueError
        body = dispatch(json.loads(encoded))
    except quality.QualityError as error:
        body = {
            "error": str(error)
            if str(error) in quality.ERROR_CODES
            else "quality_input_invalid",
            "retryable": error.retryable,
        }
    except (ValueError, TypeError, UnicodeError, RecursionError, binascii.Error):
        body = {"error": "quality_input_invalid", "retryable": False}
    encoded = json.dumps(body, separators=(",", ":"), allow_nan=False).encode("ascii")
    if len(encoded) > 4096:
        encoded = b'{"error":"quality_response_too_large","retryable":false}'
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
