// One-shot model invocation through the authenticated work-egress gateway
// (D4 §6.3, F0-R5). The child never sees a provider key, base URL, or raw
// provider response: it submits the frozen request reference and receives a
// trusted receipt reference (or a controlled rejection / unknown signal).
//
// `call` performs exactly one POST. There is no retry of any kind: a 429, 5xx,
// timeout, network failure, redirect, or unreadable 2xx body is an unknown
// outcome that must be reconciled, never re-sent and never turned into an
// invented receipt.

export const MAX_GATEWAY_RESPONSE_BYTES = 16 * 1024;
export const MAX_GATEWAY_REQUEST_BYTES = 16 * 1024;
// See content-client.mjs: the 30s ceiling is tracked locally because expires_at
// is not carried on the private refresh pipe.
export const CAPABILITY_TTL_MS = 30_000;
const MAX_TOKEN_LENGTH = 2048;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

export function unavailableUsage() {
  return Object.freeze({
    source: 'unavailable',
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
  });
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function normalizeBaseUrl(value) {
  const text = requireString(value, 'baseUrl');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError('baseUrl must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('baseUrl must use http or https');
  }
  return text.replace(/\/+$/, '');
}

function requireGeneration(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('generation must be a positive integer');
  }
  return value;
}

async function readBoundedBody(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;

  if (response.body === null || response.body === undefined) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > limit ? null : buffer;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) {
      try {
        await response.body.cancel();
      } catch {
        // The size refusal stands even if cancellation is unsupported.
      }
      return null;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function parseJSON(buffer) {
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function readCode(value) {
  if (value === null) return null;
  if (typeof value.code !== 'string' || !CODE_PATTERN.test(value.code)) return null;
  return value.code;
}

function readReceipt(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const expectedKeys = keys.filter((key) => key !== 'contentRef');
  if (expectedKeys.length !== 2 || keys.length > 3 ||
      !Object.hasOwn(value, 'refId') || !Object.hasOwn(value, 'hash')) {
    return null;
  }
  if (Object.hasOwn(value, 'contentRef') &&
      (typeof value.contentRef !== 'string' || value.contentRef.length === 0 ||
       value.contentRef.length > 512)) {
    return null;
  }
  if (typeof value.refId !== 'string' || !UUID_PATTERN.test(value.refId)) return null;
  if (typeof value.hash !== 'string' || !HASH_PATTERN.test(value.hash)) return null;
  return Object.freeze({ refId: value.refId, hash: value.hash });
}

function normalizeUsage(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return unavailableUsage();
  }
  const source = value.source === 'provider' || value.source === 'gateway_estimate'
    ? value.source
    : 'unavailable';
  const numberOrNull = (...fields) => {
    for (const field of fields) {
      if (Number.isSafeInteger(value[field]) && value[field] >= 0) return value[field];
    }
    return null;
  };
  // Canonical receipt names are inputTokens/outputTokens/cachedInputTokens;
  // the pi-ai names are accepted as a compatibility fallback.
  const inputTokens = numberOrNull('inputTokens', 'input');
  const outputTokens = numberOrNull('outputTokens', 'output');
  const cachedInputTokens = numberOrNull('cachedInputTokens') ?? 0;
  if (source === 'unavailable' || inputTokens === null || outputTokens === null) {
    return unavailableUsage();
  }
  return Object.freeze({ source, inputTokens, outputTokens, cachedInputTokens });
}

/**
 * Validate a 2xx gateway body. Success requires a receipt reference; a body
 * without one is not a success, because the child must never invent a receipt.
 * Returns null when the body is not actionable.
 */
function readSuccessBody(buffer) {
  const value = parseJSON(buffer);
  if (value === null) return null;
  const allowed = new Set([
    'outcome', 'sent', 'requestHash', 'gateState', 'code', 'providerRequestId',
    'receipt', 'content', 'contentBytes', 'usage',
    'answerRefId', 'rejectionEvidenceRefId',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return null;
  }
  if (Object.hasOwn(value, 'outcome') && value.outcome !== 'succeeded') return null;
  if (Object.hasOwn(value, 'sent') && value.sent !== true) return null;
  const receipt = readReceipt(value.receipt);
  if (receipt === null) return null;
  return {
    receipt,
    usage: normalizeUsage(value.usage),
  };
}

/**
 * Read the gateway's proven "the provider refused and nothing executed" body
 * (decision A1). Only the gateway can assert this, because it alone binds a
 * rejected_not_executed receipt to the dispatch slot; a body that does not
 * carry that outcome, a send flag, a code and a receipt reference stays an
 * unknown outcome rather than becoming a rejection.
 */
function readRejectionBody(buffer) {
  const value = parseJSON(buffer);
  if (value === null) return null;
  const allowed = new Set([
    'outcome', 'sent', 'requestHash', 'gateState', 'code', 'providerRequestId',
    'receipt', 'content', 'contentBytes', 'usage',
    'answerRefId', 'rejectionEvidenceRefId',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return null;
  }
  if (value.outcome !== 'rejected_not_executed' || value.sent !== true) return null;
  const code = readCode(value);
  if (code === null) return null;
  const receipt = readReceipt(value.receipt);
  if (receipt === null) return null;
  return { code, receipt };
}

/**
 * Create the child-side egress client. `call(payload)` performs one POST to
 * /runtime/v1/model/invoke and classifies the result:
 *
 *   2xx with receipt            -> { outcome: 'success', receipt, usage }
 *   2xx rejected_not_executed   -> { outcome: 'not_executed', code, receipt }
 *   4xx (except 408/429)        -> { outcome: 'rejected', status, code }
 *   3xx/408/429/5xx/timeout/net -> { outcome: 'unknown', reason }
 *
 * Nothing is retried; a success always carries a receipt reference and a usage
 * block whose unknown fields are null rather than zero.
 */
export function createGatewayClient({
  baseUrl,
  token,
  org,
  execution,
  generation,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  maxResponseBytes = MAX_GATEWAY_RESPONSE_BYTES,
  capabilityTtlMs = CAPABILITY_TTL_MS,
  expiresAt,
  now = Date.now,
} = {}) {
  const base = normalizeBaseUrl(baseUrl);
  requireString(token, 'token');
  requireString(org, 'org');
  if (typeof execution !== 'string' || !UUID_PATTERN.test(execution)) {
    throw new TypeError('execution must be a uuid');
  }
  requireGeneration(generation);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('maxResponseBytes must be a positive integer');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  if (!Number.isSafeInteger(capabilityTtlMs) || capabilityTtlMs <= 0) {
    throw new TypeError('capabilityTtlMs must be a positive integer');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= 0)) {
    throw new TypeError('expiresAt must be a positive epoch millisecond value');
  }

  // The authority's effective expiry (min(db TTL, lease, hard deadline)) caps
  // the local ceiling; a missing value falls back to the 30s contract.
  function expiryFor(provided) {
    const ceiling = now() + capabilityTtlMs;
    if (provided === undefined) return ceiling;
    if (!Number.isFinite(provided) || provided <= 0) return null;
    return Math.min(ceiling, provided);
  }

  // One immutable credential value is swapped at refresh time. A call captures
  // it before awaiting fetch, so an in-flight dispatch keeps its old token.
  let credential = Object.freeze({
    token,
    generation,
    expiresAt: expiryFor(expiresAt),
  });

  function headersFor(snapshot) {
    return {
      Authorization: `Bearer ${snapshot.token}`,
      'X-Work-Org': org,
      'X-Work-Execution': execution,
      'X-Work-Generation': String(snapshot.generation),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // Exactly one call; never keep an authenticated connection pooled.
      Connection: 'close',
    };
  }

  /**
   * Install a refreshed credential under the same rules as the content client:
   * same base URL, bounded non-empty token, strictly increasing generation.
   * Returns false and keeps the previous credential otherwise.
   */
  function updateCapability({
    baseUrl: nextBase, token: nextToken, generation: nextGeneration, expiresAt: nextExpiresAt,
  } = {}) {
    if (nextBase !== base) return false;
    if (typeof nextToken !== 'string' || nextToken.length === 0 ||
        nextToken.length > MAX_TOKEN_LENGTH) {
      return false;
    }
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= credential.generation) {
      return false;
    }
    if (nextExpiresAt !== undefined &&
        (!Number.isFinite(nextExpiresAt) || nextExpiresAt <= 0)) {
      return false;
    }
    const nextExpiry = expiryFor(nextExpiresAt);
    if (nextExpiry === null || nextExpiry <= now()) return false;
    credential = Object.freeze({
      token: nextToken,
      generation: nextGeneration,
      expiresAt: nextExpiry,
    });
    return true;
  }

  async function call(payload) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new TypeError('payload must be an object');
    }

    let body;
    try {
      body = JSON.stringify(payload);
    } catch {
      throw new TypeError('payload must be serializable');
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_GATEWAY_REQUEST_BYTES) {
      throw new TypeError('payload is too large');
    }

    const snapshot = credential;
    if (now() >= snapshot.expiresAt) {
      // No refresh arrived before the local 30s window closed. The request was
      // never sent, so this is a definite refusal, not an unknown outcome.
      return Object.freeze({
        outcome: 'rejected',
        status: null,
        code: 'capability_expired',
        usage: unavailableUsage(),
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}/runtime/v1/model/invoke`, {
        method: 'POST',
        headers: headersFor(snapshot),
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'timeout' : 'network_error';
      // Safe diagnostic only: the transport error class, never a body or token.
      console.error(`work gateway fetch failed reason=${reason} cause=${error?.cause?.code ?? error?.name ?? 'unknown'}`);
      return Object.freeze({ outcome: 'unknown', reason, usage: unavailableUsage() });
    } finally {
      clearTimeout(timer);
    }

    if (response.type === 'opaqueredirect' ||
        (response.status >= 300 && response.status < 400)) {
      return Object.freeze({ outcome: 'unknown', reason: 'redirect_refused', usage: unavailableUsage() });
    }

    if (response.status >= 200 && response.status < 300) {
      let buffer;
      try {
        buffer = await readBoundedBody(response, maxResponseBytes);
      } catch {
        return Object.freeze({ outcome: 'unknown', reason: 'response_unreadable', usage: unavailableUsage() });
      }
      if (buffer === null) {
        return Object.freeze({ outcome: 'unknown', reason: 'response_too_large', usage: unavailableUsage() });
      }
      const success = readSuccessBody(buffer);
      if (success !== null) {
        return Object.freeze({ outcome: 'success', ...success });
      }
      const rejection = readRejectionBody(buffer);
      if (rejection !== null) {
        return Object.freeze({ outcome: 'not_executed', ...rejection });
      }
      // The request may have reached the provider; a 2xx without a usable
      // receipt or an explicit rejection is unknown, never a failure and never
      // an invented success.
      return Object.freeze({ outcome: 'unknown', reason: 'response_invalid', usage: unavailableUsage() });
    }

    if (response.status === 429) {
      return Object.freeze({ outcome: 'unknown', reason: 'rate_limited', usage: unavailableUsage() });
    }
    if (response.status === 408) {
      return Object.freeze({ outcome: 'unknown', reason: 'timeout', usage: unavailableUsage() });
    }
    if (response.status >= 500 && response.status < 600) {
      return Object.freeze({ outcome: 'unknown', reason: 'server_error', usage: unavailableUsage() });
    }
    if (response.status >= 400 && response.status < 500) {
      let code = null;
      try {
        const buffer = await readBoundedBody(response, 4 * 1024);
        if (buffer !== null) code = readCode(parseJSON(buffer));
      } catch {
        // A missing rejection code still leaves the status as provable.
      }
      return Object.freeze({
        outcome: 'rejected',
        status: response.status,
        code: code ?? 'gateway_rejected',
        usage: unavailableUsage(),
      });
    }

    return Object.freeze({ outcome: 'unknown', reason: 'unexpected_status', usage: unavailableUsage() });
  }

  return Object.freeze({ call, updateCapability });
}
