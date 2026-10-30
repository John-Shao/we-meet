// Bound content access for the per-Run Pi child (D4 §6.3, F0-R5).
//
// The child never talks to object storage and never holds an object-store
// credential. It presents the opaque `work-content` capability (four headers)
// to the internal content proxy and receives bytes for one reference that is
// already bound to this execution. It also writes one checkpoint candidate per
// successful execute to the landed `POST /internal/v1/checkpoints` route. The
// child chooses neither the object location nor the execution binding: the
// proxy reserves the preallocated slot, stores the bytes and commits them.
// Redirects are never followed: a redirect would move the request outside the
// authenticated proxy route. Every body is bounded and every returned object is
// checked against the caller's expected digest before any byte is handed to the
// agent. Writes are attempted exactly once.

import { createHash } from 'node:crypto';

export const MAX_CONTENT_BYTES = 256 * 1024;
// Mirrors the authorization service ceiling (D4 §6.2). The child never sees
// expires_at on the private pipe, so it tracks the 30s window from the moment
// a credential was installed and fails closed when a refresh did not arrive.
export const CAPABILITY_TTL_MS = 30_000;
const MAX_ERROR_BYTES = 4 * 1024;
const MAX_TOKEN_LENGTH = 2048;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_PATTERN = /^[a-z0-9_]{1,64}$/;
// Mirrors contentref.slotPattern: the candidate slot names the execution and
// logical key but is otherwise an opaque registry key.
const SLOT_PATTERN = /^[A-Za-z0-9_.:@/-]{1,512}$/;
const WRITE_STATUS_CODES = new Map([
  [401, 'capability_invalid'],
  [409, 'content_slot_conflict'],
  [413, 'request_too_large'],
  [422, 'invalid_request'],
]);

/** A content failure carrying an enumeration code only, never content or token text. */
export class ContentClientError extends Error {
  constructor(code, { status = null, cause } = {}) {
    super(code);
    this.name = 'ContentClientError';
    this.code = code;
    this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
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

function errorCodeFromBody(buffer) {
  if (buffer.length === 0) return null;
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (typeof value.code !== 'string' || !CODE_PATTERN.test(value.code)) return null;
  return value.code;
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
        // The reader is aborted by the size refusal either way.
      }
      return null;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

/** Canonical JSON per D4 §8.1: sorted keys, no whitespace, integers only. */
function encodeCanonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new ContentClientError('content_invalid_document');
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeCanonical(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const fields = keys.map((key) => {
      if (value[key] === undefined) throw new ContentClientError('content_invalid_document');
      return `${JSON.stringify(key)}:${encodeCanonical(value[key])}`;
    });
    return `{${fields.join(',')}}`;
  }
  throw new ContentClientError('content_invalid_document');
}

/**
 * Recompute the domain-prefixed document hash from stored bytes:
 * SHA256(schemaVersion + LF + canonical_json), lowercase sha256:<hex>.
 * Used for model_request / canonical_state / model_receipt references, whose
 * reference hash is the document hash rather than the raw-byte digest.
 */
export function documentHash(bytes) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new ContentClientError('content_invalid_document');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContentClientError('content_invalid_document');
  }
  if (typeof value.schemaVersion !== 'string' || value.schemaVersion.length === 0) {
    throw new ContentClientError('content_invalid_document');
  }
  let canonical;
  try {
    canonical = encodeCanonical(value);
  } catch (error) {
    if (error instanceof ContentClientError) throw error;
    throw new ContentClientError('content_invalid_document');
  }
  return `sha256:${createHash('sha256')
    .update(`${value.schemaVersion}\n${canonical}`, 'utf8')
    .digest('hex')}`;
}

function verifyDigest(bytes, expectedHash, digest) {
  if (digest === 'bytes') {
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actual !== expectedHash) throw new ContentClientError('content_hash_mismatch');
    return;
  }
  if (digest === 'document') {
    if (documentHash(bytes) !== expectedHash) {
      throw new ContentClientError('content_hash_mismatch');
    }
    return;
  }
  throw new TypeError("digest must be 'bytes' or 'document'");
}

/**
 * Validate the one landed write-route response:
 * {ref_id, content_hash, bytes} with no other keys. The declared binding must
 * come back unchanged; anything else means the proxy did not commit what this
 * caller asked for, so no reference is surfaced.
 */
function readCheckpointResponse(buffer, refId, hash) {
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !Object.hasOwn(value, 'ref_id') ||
      !Object.hasOwn(value, 'content_hash') || !Object.hasOwn(value, 'bytes')) {
    return null;
  }
  if (value.ref_id !== refId || value.content_hash !== hash) return null;
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) return null;
  return { refId: value.ref_id, hash: value.content_hash, bytes: value.bytes };
}

/**
 * Create the child-side content reader.
 *
 * `get(refId, expectedHash, { digest })` returns the raw bytes only after the
 * proxy answered 2xx without a redirect, the body stayed within the bound, and
 * the digest recomputed locally matches the reference hash supplied by the
 * caller. Failures throw ContentClientError with an enumeration code.
 */
export function createContentClient({
  baseUrl,
  token,
  org,
  execution,
  generation,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  maxBytes = MAX_CONTENT_BYTES,
  capabilityTtlMs = CAPABILITY_TTL_MS,
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
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive integer');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  if (!Number.isSafeInteger(capabilityTtlMs) || capabilityTtlMs <= 0) {
    throw new TypeError('capabilityTtlMs must be a positive integer');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  // The active credential is swapped as one immutable value. A request captures
  // the value it started with, so an in-flight read keeps its old token.
  let credential = Object.freeze({
    token,
    generation,
    expiresAt: now() + capabilityTtlMs,
  });

  function headersFor(snapshot, extra) {
    return {
      Authorization: `Bearer ${snapshot.token}`,
      'X-Work-Org': org,
      'X-Work-Execution': execution,
      'X-Work-Generation': String(snapshot.generation),
      // One request per capability; do not leave an authenticated socket pooled.
      Connection: 'close',
      ...extra,
    };
  }

  function requireFresh() {
    if (now() >= credential.expiresAt) {
      throw new ContentClientError('capability_expired');
    }
    return credential;
  }

  /**
   * Install a refreshed credential. The base URL may not move on refresh (the
   * refresh pipe renews a token, it does not re-target the child), the token
   * must be a bounded non-empty string and the generation must strictly
   * increase. Returns false and keeps the previous credential otherwise.
   */
  function updateCapability({ baseUrl: nextBase, token: nextToken, generation: nextGeneration } = {}) {
    if (nextBase !== base) return false;
    if (typeof nextToken !== 'string' || nextToken.length === 0 ||
        nextToken.length > MAX_TOKEN_LENGTH) {
      return false;
    }
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= credential.generation) {
      return false;
    }
    credential = Object.freeze({
      token: nextToken,
      generation: nextGeneration,
      expiresAt: now() + capabilityTtlMs,
    });
    return true;
  }

  async function get(refId, expectedHash, { digest = 'bytes' } = {}) {
    if (typeof refId !== 'string' || !UUID_PATTERN.test(refId)) {
      throw new ContentClientError('content_invalid_ref');
    }
    if (typeof expectedHash !== 'string' || !HASH_PATTERN.test(expectedHash)) {
      throw new ContentClientError('content_invalid_hash');
    }
    if (digest !== 'bytes' && digest !== 'document') {
      throw new TypeError("digest must be 'bytes' or 'document'");
    }

    const snapshot = requireFresh();
    const headers = headersFor(snapshot);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}/internal/v1/content/${refId}`, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'content_timeout' : 'content_unavailable';
      throw new ContentClientError(code, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (response.type === 'opaqueredirect' ||
        (response.status >= 300 && response.status < 400)) {
      throw new ContentClientError('redirect_refused', { status: response.status });
    }

    if (response.status < 200 || response.status >= 300) {
      let code = null;
      try {
        const body = await readBoundedBody(response, MAX_ERROR_BYTES);
        if (body !== null) code = errorCodeFromBody(body);
      } catch {
        // An unreadable error body is still one enumeration failure.
      }
      throw new ContentClientError(code ?? 'content_request_failed', {
        status: response.status,
      });
    }

    let bytes;
    try {
      bytes = await readBoundedBody(response, maxBytes);
    } catch (error) {
      throw new ContentClientError('content_unavailable', { cause: error });
    }
    if (bytes === null) throw new ContentClientError('content_too_large');

    verifyDigest(bytes, expectedHash, digest);
    return bytes;
  }

  /**
   * Write one checkpoint candidate through the landed proxy route
   * `POST /internal/v1/checkpoints`. The caller supplies the preallocated refId,
   * the logical slot, the declared digest and the bytes. There is exactly one
   * attempt: no retry of any kind. Every failure is a ContentClientError with
   * an enumeration code only (never a body, token or slot echo).
   *
   * The proxy hashes raw bytes, so `hash` must be sha256 over `bytes`; a
   * mismatch is refused locally before the request (no reservation burned).
   */
  async function putCheckpoint({ refId, logicalSlot, hash, bytes } = {}) {
    if (typeof refId !== 'string' || !UUID_PATTERN.test(refId)) {
      throw new ContentClientError('content_invalid_ref');
    }
    if (typeof logicalSlot !== 'string' || !SLOT_PATTERN.test(logicalSlot)) {
      throw new ContentClientError('content_invalid_slot');
    }
    if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
      throw new ContentClientError('content_invalid_hash');
    }
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      throw new ContentClientError('content_invalid_body');
    }
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (body.length === 0) throw new ContentClientError('content_invalid_body');
    if (body.length > maxBytes) throw new ContentClientError('content_too_large');
    const actual = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    if (actual !== hash) throw new ContentClientError('content_hash_mismatch');

    const snapshot = requireFresh();
    const headers = headersFor(snapshot, {
      'X-Work-Ref-Id': refId,
      'X-Work-Logical-Slot': logicalSlot,
      'X-Work-Content-Hash': hash,
      'Content-Type': 'application/octet-stream',
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}/internal/v1/checkpoints`, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'content_timeout' : 'content_unavailable';
      throw new ContentClientError(code, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (response.type === 'opaqueredirect' ||
        (response.status >= 300 && response.status < 400)) {
      throw new ContentClientError('redirect_refused', { status: response.status });
    }

    if (response.status < 200 || response.status >= 300) {
      let code = null;
      try {
        const errorBody = await readBoundedBody(response, MAX_ERROR_BYTES);
        if (errorBody !== null) code = errorCodeFromBody(errorBody);
      } catch {
        // An unreadable error body is still one enumeration failure.
      }
      throw new ContentClientError(
        code ?? WRITE_STATUS_CODES.get(response.status) ?? 'content_write_failed',
        { status: response.status },
      );
    }

    let responseBody;
    try {
      responseBody = await readBoundedBody(response, MAX_ERROR_BYTES);
    } catch (error) {
      throw new ContentClientError('content_unavailable', { cause: error });
    }
    if (responseBody === null) throw new ContentClientError('content_invalid_response');
    const committed = readCheckpointResponse(responseBody, refId, hash);
    if (committed === null || committed.bytes !== body.length) {
      throw new ContentClientError('content_invalid_response');
    }
    return Object.freeze({ refId: committed.refId, hash: committed.hash, bytes: committed.bytes });
  }

  return Object.freeze({ get, putCheckpoint, updateCapability });
}
