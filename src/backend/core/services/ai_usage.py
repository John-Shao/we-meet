"""Attributing AI spend to an organization and a person (P10 M2).

``llm_client`` throws away the ``usage`` block every OpenAI-compatible endpoint
returns. That is the whole gap: without it, the only signal that one customer's
prompt has gone into a loop is the monthly invoice.

Cost is computed here, at write time, from :class:`AIModel`'s price columns, and
then frozen on the row. Recomputing later from current prices would silently
rewrite history the next time a rate changes.

Everything is best-effort: a metering failure must never turn a working AI
feature into an error. The call already happened and already cost money —
losing the record is bad, losing the answer is worse.
"""

import logging

from core import models

logger = logging.getLogger(__name__)

#: Prices are per *million* tokens; usage arrives per token.
_TOKENS_PER_PRICED_UNIT = 1_000_000
_SECONDS_PER_MINUTE = 60


def price_for(model_code: str):
    """The pricing row for a wire model code, or ``None`` when unpriced."""
    if not model_code:
        return None
    return (
        models.AIModel.objects.filter(code=model_code)
        .values("price_input_per_mtok", "price_output_per_mtok", "price_per_minute")
        .first()
    )


def compute_cost_micros(
    model_code: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    audio_seconds: int = 0,
) -> int:
    """Micro-CNY for one call. 0 when the model has no configured price.

    Integer arithmetic throughout: these rows get summed by the thousand, and
    float cents drift enough over a month's usage to make the total wrong in a
    way nobody can reconcile.
    """
    prices = price_for(model_code)
    if not prices:
        return 0
    cost = (
        input_tokens * prices["price_input_per_mtok"]
        + output_tokens * prices["price_output_per_mtok"]
    ) // _TOKENS_PER_PRICED_UNIT
    if audio_seconds:
        cost += (audio_seconds * prices["price_per_minute"]) // _SECONDS_PER_MINUTE
    return int(cost)


def usage_from_response(response) -> dict:
    """Pull ``{input_tokens, output_tokens}`` out of an OpenAI-style response.

    Tolerant on purpose: several China-region endpoints omit ``usage`` entirely
    or name the fields differently, and a metering helper that raises on those
    would take the feature down with it.
    """
    usage = getattr(response, "usage", None)
    if usage is None:
        return {"input_tokens": 0, "output_tokens": 0}
    return {
        "input_tokens": int(getattr(usage, "prompt_tokens", 0) or 0),
        "output_tokens": int(getattr(usage, "completion_tokens", 0) or 0),
    }


def record_usage(
    *,
    user=None,
    organization=None,
    kind: str = models.AIUsageKindChoices.OTHER,
    model_code: str = "",
    ref_type: str = "",
    ref_id: str = "",
    input_tokens: int = 0,
    output_tokens: int = 0,
    audio_seconds: int = 0,
):
    """Write one usage row. Never raises."""
    try:
        if organization is None and user is not None:
            from core.api.directory import get_caller_organization

            organization = get_caller_organization(user)
        return models.AIUsageRecord.objects.create(
            organization=organization,
            user=user,
            kind=kind,
            model_code=model_code or "",
            ref_type=ref_type or "",
            ref_id=str(ref_id or "")[:64],
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            audio_seconds=audio_seconds,
            cost_micros=compute_cost_micros(
                model_code, input_tokens, output_tokens, audio_seconds
            ),
        )
    except Exception:  # noqa: BLE001 — metering must not break the feature
        logger.exception("failed to record AI usage (kind=%s)", kind)
        return None


def make_sink(*, user=None, organization=None, kind, ref_type="", ref_id=""):
    """Build a ``usage_sink`` callback for :class:`LLMClient`.

    The client stays ignorant of who is asking — it just hands back the model
    code and the token counts, and the caller supplies the context it alone
    knows.
    """

    def sink(*, model_code: str, input_tokens: int, output_tokens: int):
        record_usage(
            user=user,
            organization=organization,
            kind=kind,
            model_code=model_code,
            ref_type=ref_type,
            ref_id=ref_id,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

    return sink
