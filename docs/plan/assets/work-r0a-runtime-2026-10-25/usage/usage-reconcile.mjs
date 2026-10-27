// R0a token usage normalization, per-operation settlement and period
// reconciliation rules. Pure functions; integer tokens only (D-08: Work counts
// tokens, it does not price them).

export const TOLERANCE = Object.freeze({
  // Gateway-counted vs provider-reported tokens for one operation.
  operationTokenRatio: 0.05,
  operationTokenFloor: 50,
  // Provider invoice vs internal ledger token totals for one org/period/provider.
  periodRatio: 0.01,
  periodFloorTokens: 100,
});

const TOKEN_CLASSES = ['input', 'cached_input', 'output'];

function int(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// Provider usage → canonical token classes. Unknown shape returns null so the
// caller must treat usage as missing rather than guessing.
export function normalizeUsage(raw, { reasoningBilledSeparately = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = int(raw.prompt_tokens ?? raw.input_tokens);
  const completion = int(raw.completion_tokens ?? raw.output_tokens);
  if (prompt === null || completion === null) return null;
  const cached = int(raw.prompt_tokens_details?.cached_tokens ?? raw.cached_input_tokens ?? 0) ?? 0;
  const reasoning = int(raw.completion_tokens_details?.reasoning_tokens ?? 0) ?? 0;
  return {
    input: Math.max(prompt - cached, 0),
    cached_input: Math.min(cached, prompt),
    // Providers that already count reasoning inside completion_tokens must not
    // be counted twice; only an explicit flag adds it on top.
    output: completion + (reasoningBilledSeparately ? reasoning : 0),
  };
}

export function totalTokens(t) {
  return t.input + t.cached_input + t.output;
}

export function upperBoundTokens({ maxInputTokens, maxOutputTokens }) {
  if (
    !Number.isInteger(maxInputTokens) ||
    !Number.isInteger(maxOutputTokens) ||
    maxInputTokens < 0 ||
    maxOutputTokens < 1
  ) {
    throw Object.assign(new Error('maxInputTokens/maxOutputTokens must be integers'), {
      code: 'invalid_token_bound',
    });
  }
  return maxInputTokens + maxOutputTokens;
}

// Gateway counts come from our own proxy; a NaN/negative/fractional count is a bug, not "zero usage".
function validateGatewayTokens(tokens) {
  if (tokens == null) return null;
  const bad = TOKEN_CLASSES.filter((cls) => !Number.isInteger(tokens[cls]) || tokens[cls] < 0);
  if (bad.length) {
    throw Object.assign(new Error(`invalid gateway token counts: ${bad.join(', ')}`), {
      code: 'invalid_gateway_usage',
    });
  }
  return { input: tokens.input, cached_input: tokens.cached_input, output: tokens.output };
}

// The operation must carry the provider/model the Run was routed to.
function assertOperationBinding(operation) {
  if (!operation?.provider || !operation?.model) {
    throw Object.assign(new Error('operation must carry provider and model'), {
      code: 'operation_binding_mismatch',
    });
  }
}

// Decide what to settle for one model operation and which flags to raise.
export function settleOperation({
  reservedTokens,
  operation,
  providerUsage,
  gatewayTokens: rawGateway,
  reasoningBilledSeparately = false,
}) {
  assertOperationBinding(operation);
  if (!Number.isInteger(reservedTokens) || reservedTokens < 0) {
    throw Object.assign(new Error('reservedTokens must be a non-negative integer'), {
      code: 'invalid_reservation_amount',
    });
  }
  const gatewayTokens = validateGatewayTokens(rawGateway);
  const flags = [];
  const provider = normalizeUsage(providerUsage, { reasoningBilledSeparately });
  let basis;
  let tokens;
  if (provider) {
    basis = 'provider';
    tokens = provider;
    if (gatewayTokens) {
      const diff = Math.abs(totalTokens(provider) - totalTokens(gatewayTokens));
      const allowed = Math.max(
        Math.ceil(totalTokens(provider) * TOLERANCE.operationTokenRatio),
        TOLERANCE.operationTokenFloor,
      );
      if (diff > allowed) flags.push('usage_mismatch');
    }
  } else if (gatewayTokens) {
    basis = 'gateway_estimate';
    tokens = gatewayTokens;
    flags.push('usage_estimated');
  } else {
    // No evidence at all: keep the reservation; reconciliation decides later.
    return {
      action: 'hold_unknown',
      settleTokens: null,
      overageTokens: 0,
      flags: ['usage_missing'],
      basis: null,
    };
  }
  const measured = totalTokens(tokens);
  const settleTokens = Math.min(measured, reservedTokens);
  const overageTokens = measured - settleTokens;
  if (overageTokens > 0) flags.push('quota_overrun');
  return {
    action: 'settle',
    settleTokens,
    overageTokens,
    flags,
    basis,
    usage: { ...tokens },
  };
}

// Compare one org/period/provider invoice with internal ledger entries.
export function reconcilePeriod({ ledger, invoice }) {
  for (const [name, rows] of [
    ['ledger', ledger],
    ['invoice', invoice],
  ]) {
    const ids = new Set();
    for (const row of rows) {
      if (!row.provider_request_id || !Number.isInteger(row.tokens) || row.tokens < 0) {
        throw Object.assign(new Error(`${name} row needs provider_request_id and non-negative integer tokens`), {
          code: 'invalid_reconciliation_input',
        });
      }
      if (ids.has(row.provider_request_id)) {
        throw Object.assign(new Error(`${name} has duplicate provider_request_id`), {
          code: 'invalid_reconciliation_input',
        });
      }
      ids.add(row.provider_request_id);
    }
  }
  const byId = (rows) => new Map(rows.map((row) => [row.provider_request_id, row]));
  const ledgerById = byId(ledger);
  const invoiceById = byId(invoice);
  const ledgerTotal = ledger.reduce((sum, row) => sum + row.tokens, 0);
  const invoiceTotal = invoice.reduce((sum, row) => sum + row.tokens, 0);
  const missingInLedger = invoice
    .filter((row) => !ledgerById.has(row.provider_request_id))
    .map((row) => row.provider_request_id);
  const missingInInvoice = ledger
    .filter((row) => !invoiceById.has(row.provider_request_id))
    .map((row) => row.provider_request_id);
  const mismatched = invoice
    .filter((row) => ledgerById.has(row.provider_request_id))
    .filter((row) => ledgerById.get(row.provider_request_id).tokens !== row.tokens)
    .map((row) => ({
      provider_request_id: row.provider_request_id,
      ledger_tokens: ledgerById.get(row.provider_request_id).tokens,
      invoice_tokens: row.tokens,
    }));
  const diffTokens = invoiceTotal - ledgerTotal;
  const allowed = Math.max(
    Math.ceil(Math.abs(invoiceTotal) * TOLERANCE.periodRatio),
    TOLERANCE.periodFloorTokens,
  );
  const withinTolerance = Math.abs(diffTokens) <= allowed;
  let status = 'matched';
  if (diffTokens !== 0 || missingInLedger.length || missingInInvoice.length || mismatched.length) {
    status = withinTolerance ? 'within_tolerance' : 'adjustment_required';
  }
  return {
    status,
    ledgerTotal,
    invoiceTotal,
    diffTokens,
    allowedTokens: allowed,
    missingInLedger,
    missingInInvoice,
    mismatched,
  };
}
