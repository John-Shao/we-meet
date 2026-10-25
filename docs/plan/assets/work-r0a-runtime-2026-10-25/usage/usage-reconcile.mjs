// R0a usage pricing, per-operation settlement and period reconciliation rules.
// Pure functions; integer cents only. Prices are placeholders until the
// provider's written price sheet is archived (D4-11).

export const TOLERANCE = Object.freeze({
  // Gateway-counted vs provider-reported tokens for one operation.
  operationTokenRatio: 0.05,
  operationTokenFloor: 50,
  // Provider invoice vs internal ledger for one org/period/provider.
  periodRatio: 0.01,
  periodFloorCents: 100,
});

const TOKEN_CLASSES = ['input', 'cached_input', 'output'];

export function validatePriceTable(table) {
  const errors = [];
  if (!/^[a-z0-9][a-z0-9.-]{2,63}$/.test(table?.price_version ?? '')) errors.push('price_version');
  if (!/^[A-Z]{3}$/.test(table?.currency ?? '')) errors.push('currency');
  for (const cls of TOKEN_CLASSES) {
    const value = table?.per_million_cents?.[cls];
    if (!Number.isInteger(value) || value < 0) errors.push(`per_million_cents.${cls}`);
  }
  if (!Number.isInteger(table?.max_output_tokens) || table.max_output_tokens < 1) {
    errors.push('max_output_tokens');
  }
  if (typeof table?.reasoning_billed_separately !== 'boolean') errors.push('reasoning_billed_separately');
  if (errors.length) {
    throw Object.assign(new Error(`invalid price table: ${errors.join(', ')}`), { code: 'invalid_price_version' });
  }
  return table;
}

function int(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// Provider usage → canonical token classes. Unknown shape returns null so the
// caller must treat usage as missing rather than guessing.
export function normalizeUsage(raw, table) {
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
    // be charged twice; only a price table flag adds it on top.
    output: completion + (table.reasoning_billed_separately ? reasoning : 0),
  };
}

export function priceTokens(tokens, table) {
  let micro = 0;
  for (const cls of TOKEN_CLASSES) micro += tokens[cls] * table.per_million_cents[cls];
  return Math.ceil(micro / 1_000_000);
}

export function upperBoundCents(table, { maxInputTokens }) {
  validatePriceTable(table);
  return priceTokens(
    { input: maxInputTokens, cached_input: 0, output: table.max_output_tokens },
    table,
  );
}

function totalTokens(t) {
  return t.input + t.cached_input + t.output;
}

// Decide what to settle for one model operation and which flags to raise.
export function settleOperation({ reservedCents, priceTable, providerUsage, gatewayTokens }) {
  validatePriceTable(priceTable);
  if (!Number.isInteger(reservedCents) || reservedCents < 0) {
    throw Object.assign(new Error('reservedCents must be a non-negative integer'), { code: 'invalid_billable_amount' });
  }
  const flags = [];
  const provider = normalizeUsage(providerUsage, priceTable);
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
    return { action: 'hold_unknown', settleCents: null, overageCents: 0, flags: ['usage_missing'], basis: null };
  }
  const priced = priceTokens(tokens, priceTable);
  const settleCents = Math.min(priced, reservedCents);
  const overageCents = priced - settleCents;
  if (overageCents > 0) flags.push('budget_overrun');
  return {
    action: 'settle',
    settleCents,
    overageCents,
    flags,
    basis,
    usage: { ...tokens, price_version: priceTable.price_version },
  };
}

// Compare one org/period/provider invoice with internal ledger entries.
export function reconcilePeriod({ ledger, invoice }) {
  const byId = (rows) => new Map(rows.map((row) => [row.provider_request_id, row]));
  const ledgerById = byId(ledger);
  const invoiceById = byId(invoice);
  const ledgerTotal = ledger.reduce((sum, row) => sum + row.amount_cents, 0);
  const invoiceTotal = invoice.reduce((sum, row) => sum + row.amount_cents, 0);
  const missingInLedger = invoice
    .filter((row) => !ledgerById.has(row.provider_request_id))
    .map((row) => row.provider_request_id);
  const missingInInvoice = ledger
    .filter((row) => !invoiceById.has(row.provider_request_id))
    .map((row) => row.provider_request_id);
  const mismatched = invoice
    .filter((row) => ledgerById.has(row.provider_request_id))
    .filter((row) => ledgerById.get(row.provider_request_id).amount_cents !== row.amount_cents)
    .map((row) => ({
      provider_request_id: row.provider_request_id,
      ledger_cents: ledgerById.get(row.provider_request_id).amount_cents,
      invoice_cents: row.amount_cents,
    }));
  const diffCents = invoiceTotal - ledgerTotal;
  const allowed = Math.max(
    Math.ceil(Math.abs(invoiceTotal) * TOLERANCE.periodRatio),
    TOLERANCE.periodFloorCents,
  );
  const withinTolerance = Math.abs(diffCents) <= allowed;
  let status = 'matched';
  if (diffCents !== 0 || missingInLedger.length || missingInInvoice.length || mismatched.length) {
    status = withinTolerance ? 'within_tolerance' : 'adjustment_required';
  }
  return {
    status,
    ledgerTotal,
    invoiceTotal,
    diffCents,
    allowedCents: allowed,
    missingInLedger,
    missingInInvoice,
    mismatched,
  };
}
