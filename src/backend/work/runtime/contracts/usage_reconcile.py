"""Token-only usage settlement and period reconciliation (D-08/D4).

No prices or cents: Work counts tokens; the customer's provider bills them.
"""

from dataclasses import dataclass

TOLERANCE = {
    "operation_token_ratio": 0.05,
    "operation_token_floor": 50,
    "period_ratio": 0.01,
    "period_floor_tokens": 100,
}
TOKEN_CLASSES = ("input", "cached_input", "output")


@dataclass(frozen=True, slots=True)
class SettledUsage:
    input: int
    cached_input: int
    output: int

    @property
    def total(self) -> int:
        return self.input + self.cached_input + self.output


def _non_negative_int(value):
    return value if isinstance(value, int) and value >= 0 else None


def normalize_usage(raw: dict | None, *, reasoning_billed_separately=False):
    if not isinstance(raw, dict):
        return None
    prompt = _non_negative_int(raw.get("prompt_tokens", raw.get("input_tokens")))
    completion = _non_negative_int(
        raw.get("completion_tokens", raw.get("output_tokens"))
    )
    if prompt is None or completion is None:
        return None
    cached = _non_negative_int(
        (raw.get("prompt_tokens_details") or {}).get("cached_tokens")
        if isinstance(raw.get("prompt_tokens_details"), dict)
        else raw.get("cached_input_tokens", 0)
    )
    cached = cached if cached is not None else 0
    reasoning = _non_negative_int(
        (raw.get("completion_tokens_details") or {}).get("reasoning_tokens")
        if isinstance(raw.get("completion_tokens_details"), dict)
        else 0
    )
    reasoning = reasoning if reasoning is not None else 0
    return SettledUsage(
        input=max(prompt - cached, 0),
        cached_input=min(cached, prompt),
        output=completion + (reasoning if reasoning_billed_separately else 0),
    )


def _gateway_tokens(tokens):
    if tokens is None:
        return None
    return SettledUsage(
        input=tokens["input"],
        cached_input=tokens["cached_input"],
        output=tokens["output"],
    )


def settle_operation(
    *,
    reserved_tokens: int,
    provider_usage: dict | None,
    gateway_tokens: dict | None = None,
    reasoning_billed_separately=False,
) -> dict:
    if not isinstance(reserved_tokens, int) or reserved_tokens < 0:
        raise ValueError("reserved_tokens")
    gateway = _gateway_tokens(gateway_tokens)
    provider = normalize_usage(
        provider_usage, reasoning_billed_separately=reasoning_billed_separately
    )
    flags = []
    if provider:
        basis, tokens = "provider", provider
        if gateway:
            diff = abs(provider.total - gateway.total)
            allowed = max(
                int(provider.total * TOLERANCE["operation_token_ratio"] + 0.999),
                TOLERANCE["operation_token_floor"],
            )
            if diff > allowed:
                flags.append("usage_mismatch")
    elif gateway:
        basis, tokens = "gateway_estimate", gateway
        flags.append("usage_estimated")
    else:
        return {
            "action": "hold_unknown",
            "settle_tokens": None,
            "overage_tokens": 0,
            "flags": ["usage_missing"],
            "basis": None,
            "usage": None,
        }
    settle = min(tokens.total, reserved_tokens)
    overage = tokens.total - settle
    if overage > 0:
        flags.append("budget_overrun")
    return {
        "action": "settle",
        "settle_tokens": settle,
        "overage_tokens": overage,
        "flags": flags,
        "basis": basis,
        "usage": tokens,
    }


def reconcile_period(*, ledger: list[dict], invoice: list[dict]) -> dict:
    def validate(name, rows):
        ids = set()
        for row in rows:
            if not row.get("provider_request_id") or not isinstance(
                row.get("amount_tokens"), int
            ):
                raise ValueError(f"{name} row")
            if row["provider_request_id"] in ids:
                raise ValueError(f"{name} duplicate")
            ids.add(row["provider_request_id"])

    validate("ledger", ledger)
    validate("invoice", invoice)
    ledger_by_id = {row["provider_request_id"]: row for row in ledger}
    invoice_by_id = {row["provider_request_id"]: row for row in invoice}
    ledger_total = sum(row["amount_tokens"] for row in ledger)
    invoice_total = sum(row["amount_tokens"] for row in invoice)
    missing_in_ledger = [
        row["provider_request_id"]
        for row in invoice
        if row["provider_request_id"] not in ledger_by_id
    ]
    missing_in_invoice = [
        row["provider_request_id"]
        for row in ledger
        if row["provider_request_id"] not in invoice_by_id
    ]
    mismatched = [
        {
            "provider_request_id": row["provider_request_id"],
            "ledger_tokens": ledger_by_id[row["provider_request_id"]]["amount_tokens"],
            "invoice_tokens": row["amount_tokens"],
        }
        for row in invoice
        if row["provider_request_id"] in ledger_by_id
        and ledger_by_id[row["provider_request_id"]]["amount_tokens"]
        != row["amount_tokens"]
    ]
    diff = invoice_total - ledger_total
    allowed = max(
        int(abs(invoice_total) * TOLERANCE["period_ratio"] + 0.999),
        TOLERANCE["period_floor_tokens"],
    )
    within = abs(diff) <= allowed
    status = "matched"
    if diff or missing_in_ledger or missing_in_invoice or mismatched:
        status = "within_tolerance" if within else "adjustment_required"
    return {
        "status": status,
        "ledger_total": ledger_total,
        "invoice_total": invoice_total,
        "diff_tokens": diff,
        "allowed_tokens": allowed,
        "missing_in_ledger": missing_in_ledger,
        "missing_in_invoice": missing_in_invoice,
        "mismatched": mismatched,
    }
