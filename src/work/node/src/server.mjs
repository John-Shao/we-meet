// Internal control-plane transport for one advanceRuntime fragment.
//
// Trust boundary: the listener requires a verified client certificate and
// accepts only the fixed fragment route. The request is validated with the
// signed wire shape (unknown fields rejected) and handed to the Supervisor as
// an opaque payload. Nothing from the request or the child is echoed in an
// error response; failures are enumeration codes only.

import { createServer as createHTTPSServer } from 'node:https';

import { ProtocolError, validateOutcome } from './protocol.mjs';
import { LeaseError, createAuthzClient, createLeaseSession } from './lease.mjs';

export const ROUTE = '/internal/v1/advanceRuntime';
export const MAX_BODY_BYTES = 16 * 1024;
export const CONTRACT_VERSION = 'work-runtime-fragment-v1';
export const REQUEST_KIND = 'advance_request';
export const RESULT_KIND = 'advance_result';

const MODE_AUDIENCE = Object.freeze({ plan: 'work-content', execute: 'work-egress' });
const LEASE_OPTION_KEYS = new Set([
  'heartbeatIntervalMs',
  'capabilityRefreshIntervalMs',
  'now',
  'timers',
]);

const TOP_LEVEL_FIELDS = new Set([
  'kind',
  'contractVersion',
  'executionId',
  'runId',
  'taskId',
  'orgId',
  'snapshotId',
  'runtimeVersion',
  'fence',
  'deadlineUnixMs',
  'mode',
  'checkpoint',
  'intent',
  'permit',
]);
const REFERENCE_FIELDS = new Set(['refId', 'hash']);
const INTENT_FIELDS = new Set(['request', 'requestHash', 'logicalKey']);
const PERMIT_FIELDS = new Set(['operationId', 'dispatchAttemptId', 'requestHash']);
const FENCE_PATTERN = /^[1-9][0-9]{0,18}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ORG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_FENCE = 9223372036854775807n;
const LOGICAL_KEYS = new Set(['model:1', 'model:2', 'model:3']);

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(422, 'invalid_request');
  }
  return value;
}

function requireReference(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, REFERENCE_FIELDS) || !Object.hasOwn(value, 'refId') ||
      !Object.hasOwn(value, 'hash')) {
    throw new HttpError(422, 'invalid_request');
  }
  if (typeof value.refId !== 'string' || !UUID_PATTERN.test(value.refId)) {
    throw new HttpError(422, 'invalid_request');
  }
  if (typeof value.hash !== 'string' || !HASH_PATTERN.test(value.hash)) {
    throw new HttpError(422, 'invalid_request');
  }
  return { refId: value.refId, hash: value.hash };
}

function optionalReference(value) {
  if (value === null) return null;
  return requireReference(value);
}

function requireIntent(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, INTENT_FIELDS) ||
      !Object.hasOwn(value, 'request') || !Object.hasOwn(value, 'requestHash') ||
      !Object.hasOwn(value, 'logicalKey')) {
    throw new HttpError(422, 'invalid_request');
  }
  const request = requireReference(value.request);
  const requestHash = requireString(value.requestHash, 'requestHash');
  if (!HASH_PATTERN.test(requestHash)) throw new HttpError(422, 'invalid_request');
  if (!LOGICAL_KEYS.has(value.logicalKey)) throw new HttpError(422, 'invalid_request');
  return { request, requestHash, logicalKey: value.logicalKey };
}

function requirePermit(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, PERMIT_FIELDS) ||
      !Object.hasOwn(value, 'operationId') || !Object.hasOwn(value, 'dispatchAttemptId') ||
      !Object.hasOwn(value, 'requestHash')) {
    throw new HttpError(422, 'invalid_request');
  }
  const operationId = requireString(value.operationId, 'operationId');
  const dispatchAttemptId = requireString(value.dispatchAttemptId, 'dispatchAttemptId');
  const requestHash = requireString(value.requestHash, 'requestHash');
  if (!UUID_PATTERN.test(operationId) || !UUID_PATTERN.test(dispatchAttemptId) ||
      !HASH_PATTERN.test(requestHash)) {
    throw new HttpError(422, 'invalid_request');
  }
  return { operationId, dispatchAttemptId, requestHash };
}

function validateFence(value) {
  if (typeof value !== 'string' || !FENCE_PATTERN.test(value)) {
    throw new HttpError(422, 'invalid_request');
  }
  if (BigInt(value) > MAX_FENCE) throw new HttpError(422, 'invalid_request');
  return value;
}

/**
 * Validate a parsed fragment request against the signed wire shape and return
 * a canonical object. Unknown fields at every level are a structure error.
 */
export function validateAdvanceRequest(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, TOP_LEVEL_FIELDS)) {
    throw new HttpError(422, 'invalid_request');
  }
  for (const field of TOP_LEVEL_FIELDS) {
    if (field === 'checkpoint' || field === 'intent' || field === 'permit') continue;
    if (!Object.hasOwn(value, field)) throw new HttpError(422, 'invalid_request');
  }
  if (value.kind !== REQUEST_KIND) throw new HttpError(422, 'invalid_request');
  if (value.contractVersion !== CONTRACT_VERSION) throw new HttpError(422, 'version_mismatch');

  const executionId = requireString(value.executionId, 'executionId');
  const runId = requireString(value.runId, 'runId');
  const taskId = requireString(value.taskId, 'taskId');
  const orgId = requireString(value.orgId, 'orgId');
  const snapshotId = requireString(value.snapshotId, 'snapshotId');
  const runtimeVersion = requireString(value.runtimeVersion, 'runtimeVersion');
  for (const identifier of [executionId, runId, taskId, snapshotId]) {
    if (!UUID_PATTERN.test(identifier)) throw new HttpError(422, 'invalid_request');
  }
  if (!ORG_PATTERN.test(orgId) || !VERSION_PATTERN.test(runtimeVersion)) {
    throw new HttpError(422, 'invalid_request');
  }
  const fence = validateFence(value.fence);
  if (!Number.isSafeInteger(value.deadlineUnixMs) || value.deadlineUnixMs <= 0) {
    throw new HttpError(422, 'invalid_request');
  }
  if (value.mode !== 'plan' && value.mode !== 'execute') {
    throw new HttpError(422, 'invalid_request');
  }

  let checkpoint = null;
  let intent = null;
  let permit = null;
  if (value.mode === 'plan') {
    checkpoint = optionalReference(Object.hasOwn(value, 'checkpoint') ? value.checkpoint : null);
    if ((Object.hasOwn(value, 'intent') && value.intent !== null) ||
        (Object.hasOwn(value, 'permit') && value.permit !== null)) {
      throw new HttpError(422, 'invalid_request');
    }
  } else {
    if (!Object.hasOwn(value, 'checkpoint') || !Object.hasOwn(value, 'intent') ||
        !Object.hasOwn(value, 'permit') || value.checkpoint === null ||
        value.intent === null || value.permit === null) {
      throw new HttpError(422, 'invalid_request');
    }
    checkpoint = requireReference(value.checkpoint);
    intent = requireIntent(value.intent);
    permit = requirePermit(value.permit);
    if (intent.requestHash !== permit.requestHash) {
      throw new HttpError(422, 'invalid_request');
    }
  }

  return {
    kind: REQUEST_KIND,
    contractVersion: CONTRACT_VERSION,
    executionId,
    runId,
    taskId,
    orgId,
    snapshotId,
    runtimeVersion,
    fence,
    deadlineUnixMs: value.deadlineUnixMs,
    mode: value.mode,
    checkpoint,
    intent,
    permit,
  };
}

/** Parse and validate a fragment body. Size is enforced by the HTTP reader. */
export function parseAdvanceRequest(body) {
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(422, 'invalid_request');
  }
  return validateAdvanceRequest(value);
}

function sendJSON(res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(value);
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
    });
    res.end(body);
  } catch {
    // The peer already went away; there is no second channel to report on.
  }
}

function sendError(res, status, code) {
  if (res.headersSent || res.destroyed) return;
  if (status === 413) res.setHeader('Connection', 'close');
  sendJSON(res, status, { code });
}

function statusForReason(reason) {
  switch (reason) {
    case 'capacity':
      return { status: 429, code: 'resource_exhausted' };
    case 'draining':
      return { status: 503, code: 'draining' };
    case 'version_mismatch':
      return { status: 422, code: 'version_mismatch' };
    case 'run_active':
      return { status: 409, code: 'run_active' };
    case 'invalid_request':
      return { status: 422, code: 'invalid_request' };
    default:
      return { status: 500, code: 'internal_error' };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.on('error', () => {});
      req.pause();
      reject(new HttpError(413, 'body_too_large'));
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;
    // Keep a no-op listener after settlement so an aborting peer cannot raise
    // an unhandled 'error' event.
    req.on('error', () => {});
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      callback(value);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.pause();
        finish(reject, new HttpError(413, 'body_too_large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks, total));
    const onError = () => finish(reject, new HttpError(400, 'invalid_request'));
    const onAborted = () => finish(reject, new HttpError(400, 'invalid_request'));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/**
 * Convert a validated request plus the supervisor's settled status into the
 * signed advance_result envelope.
 *
 * When the child delivered an `outcome` on its result frame, that outcome is
 * the only source of ids/hashes/reason: it is re-validated here against the
 * signed union and returned with the trusted envelope (kind, contractVersion
 * and executionId always come from the request, never from the child). A
 * status-only frame keeps the conservative mapping below: the transport
 * cannot fabricate a checkpoint, receipt, artifact or model intent. An execute
 * fragment holds a permit, so any terminal child status without a delivered
 * result leaves the provider outcome unknown and is surfaced as
 * WAITING_RECONCILE / provider_unknown rather than as a business failure. A
 * plan fragment cannot dispatch, so its missing result is a runtime fault (or
 * deadline_exceeded).
 *
 * A malformed outcome throws ProtocolError; the handler treats that as a
 * protocol_violation (the supervisor has already killed the child) and falls
 * back to the conservative mapping instead of guessing a result.
 *
 * `lease_lost`, `capability_expired` and `capability_refresh_failed` are
 * distinct authority settlements: they map to FAILED with their own errorCode
 * for a plan fragment. An execute fragment may already have consumed its gate,
 * so it keeps the signed WAITING_RECONCILE / provider_unknown mapping instead
 * of inventing a terminal business result.
 */
export function advanceResult(request, settled) {
  const base = {
    kind: RESULT_KIND,
    contractVersion: CONTRACT_VERSION,
    executionId: request.executionId,
  };

  const supplied = settled !== null && typeof settled === 'object' &&
    (settled.status === 'completed' || settled.status === 'failed') &&
    Object.hasOwn(settled, 'outcome') && settled.outcome !== null &&
    settled.outcome !== undefined;
  if (supplied) {
    const outcome = validateOutcome(settled.outcome);
    return {
      ...base,
      state: outcome.state,
      checkpoint: outcome.checkpoint,
      ...(Object.hasOwn(outcome, 'intent') ? { intent: outcome.intent } : {}),
      ...(Object.hasOwn(outcome, 'receipt') ? { receipt: outcome.receipt } : {}),
      ...(Object.hasOwn(outcome, 'artifact') ? { artifact: outcome.artifact } : {}),
      ...(Object.hasOwn(outcome, 'operationId') ? { operationId: outcome.operationId } : {}),
      ...(Object.hasOwn(outcome, 'reason') ? { reason: outcome.reason } : {}),
    };
  }

  const checkpoint = request.checkpoint === null ? null : { ...request.checkpoint };
  if (request.mode === 'execute') {
    return {
      ...base,
      state: 'WAITING_RECONCILE',
      checkpoint,
      operationId: request.permit.operationId,
      reason: 'provider_unknown',
    };
  }
  switch (settled.status) {
    case 'timed_out':
      return { ...base, state: 'FAILED', checkpoint, errorCode: 'deadline_exceeded' };
    case 'lease_lost':
      // The parent lost the execution lease. This is never a success and never
      // a business failure: the child was reaped before it could finish.
      return { ...base, state: 'FAILED', checkpoint, errorCode: 'lease_lost' };
    case 'capability_expired':
      // An authority settlement, e.g. a lease owner that can prove the token
      // is unusable. The scheduled 25s stop was replaced by fd 5 refresh.
      return { ...base, state: 'FAILED', checkpoint, errorCode: 'capability_expired' };
    case 'capability_refresh_failed':
      // The refresh loop could not issue or deliver the next generation, so
      // the child was stopped before it could call with an expiring token.
      return { ...base, state: 'FAILED', checkpoint, errorCode: 'capability_refresh_failed' };
    case 'completed':
    case 'failed':
    case 'crashed':
    case 'protocol_violation':
      return { ...base, state: 'FAILED', checkpoint, errorCode: 'runtime_fault' };
    default:
      return null;
  }
}

function normalizeRuntimeUrl(value, fallback) {
  const text = value === undefined || value === '' ? fallback : value;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError('runtime endpoint must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('runtime endpoint must use http or https');
  }
  return text.replace(/\/+$/, '');
}

// The capability is issued after the claim and before any child exists. Its
// token is only ever written to the private fd 4 bootstrap pipe (startup) or
// the private fd 5 refresh pipe (renewal); the issuance metadata
// (audience/expiry/generation) stays in the parent lease session.
async function issueCapabilitiesForRequest(authzClient, request, endpoints) {
  // D4 §6.2: content is narrowed by mode. A plan fragment holds only the
  // work-content capability; an execute fragment holds only the work-egress
  // capability. An execute child never reads content; the gateway assembles
  // the frozen request's messages server-side.
  const audience = MODE_AUDIENCE[request.mode];
  const issued = await authzClient.issueCapability({
    orgId: request.orgId,
    executionId: request.executionId,
    audience,
  });
  // The child expects the nested bootstrap shape with the endpoint it may use.
  const capabilities = request.mode === 'plan'
    ? {
        content: {
          baseUrl: endpoints.contentBaseUrl,
          token: issued.token,
          generation: issued.generation,
          expiresAt: issued.expiresAt,
        },
      }
    : {
        egress: {
          baseUrl: endpoints.egressBaseUrl,
          token: issued.token,
          generation: issued.generation,
          expiresAt: issued.expiresAt,
        },
      };
  return { capabilities, issued };
}

function normalizeLeaseOptions(value) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError('lease configuration must be an object');
  if (!Object.keys(value).every((key) => LEASE_OPTION_KEYS.has(key))) {
    throw new TypeError('lease configuration has unknown options');
  }
  return { ...value };
}

// Claim refusals are scheduling/ownership failures: the caller may retry a
// fresh fragment, but this Run gets no child and no capability.
function leaseFailure(error) {
  if (error instanceof LeaseError) {
    switch (error.code) {
      case 'lease_holder_mismatch':
        return { status: 409, code: 'lease_holder_mismatch' };
      case 'lease_not_claimable':
        return { status: 409, code: 'lease_not_claimable' };
      default:
        return { status: 503, code: 'lease_unavailable' };
    }
  }
  return { status: 503, code: 'lease_unavailable' };
}

/**
 * HTTP handler for POST /internal/v1/advanceRuntime.
 *
 * The caller identity comes from the verified TLS client certificate, never
 * from the body. holderId is the parent's registered startup identity and is
 * deliberately not a fragment field; the claim command mints the per-run holder
 * bound to this workload, and an `already_claimed` replay is accepted only when
 * it names this configured holder.
 */
export function createAdvanceHandler({
  supervisor,
  holderId,
  authz,
  contentBaseUrl,
  egressBaseUrl,
  lease,
}) {
  if (supervisor === null || typeof supervisor !== 'object' ||
      typeof supervisor.admit !== 'function' || typeof supervisor.start !== 'function') {
    throw new TypeError('supervisor is required');
  }
  if (typeof holderId !== 'string' || holderId.length === 0) {
    throw new TypeError('holderId is required');
  }
  const authzClient = createAuthzClient(authz);
  const leaseOptions = normalizeLeaseOptions(lease);
  const endpoints = {
    contentBaseUrl: normalizeRuntimeUrl(contentBaseUrl, 'http://127.0.0.1:8444'),
    egressBaseUrl: normalizeRuntimeUrl(egressBaseUrl, 'http://127.0.0.1:8445'),
  };

  return async function handle(req, res) {
    const started = Date.now();
    let runLabel = '-';
    const stage = (name) => {
      console.log(`work runtime request run=${runLabel} stage=${name} elapsed_ms=${Date.now() - started}`);
    };
    res.on('finish', () => {
      console.log(`work runtime response run=${runLabel} status=${res.statusCode} elapsed_ms=${Date.now() - started}`);
    });
    try {
      const socket = req.socket;
      if (!socket.encrypted || socket.authorized !== true ||
          typeof socket.getPeerCertificate !== 'function' || !socket.getPeerCertificate().raw) {
        sendError(res, 401, 'client_certificate_required');
        return;
      }

      let path;
      try {
        path = new URL(req.url, 'https://internal').pathname;
      } catch {
        sendError(res, 404, 'not_found');
        return;
      }
      if (path !== ROUTE) {
        sendError(res, 404, 'not_found');
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'method_not_allowed');
        return;
      }

      const body = await readBody(req);
      const request = parseAdvanceRequest(body);
      runLabel = String(request.runId).slice(0, 8);
      stage('parsed');

      // Admission is checked before any child is spawned so capacity, drain and
      // version refusals stay retryable scheduling failures. It also runs
      // before the claim, so a refused fragment never takes the lease.
      const admission = supervisor.admit({
        runFence: request.fence,
        runtimeVersion: request.runtimeVersion,
      });
      if (!admission.ok) {
        const mapping = statusForReason(admission.reason);
        sendError(res, mapping.status, mapping.code);
        return;
      }

      // The parent owns the execution lease (D-3 A). Claim before a capability
      // or a child exists: a holder mismatch or claim failure refuses the Run
      // outright, so no child can act without an owned execution.
      let claim;
      try {
        claim = await authzClient.claim({
          orgId: request.orgId,
          executionId: request.executionId,
          expectedHolderId: holderId,
        });
      } catch (error) {
        const failure = leaseFailure(error);
        sendError(res, failure.status, failure.code);
        return;
      }
      stage('claimed');

      // Issue the mode's capability after the claim and before any child
      // exists: a failed issuance refuses the Run instead of spawning a child
      // that cannot act.
      let capabilityBundle;
      try {
        capabilityBundle = await issueCapabilitiesForRequest(authzClient, request, endpoints);
      } catch {
        sendError(res, 503, 'capability_unavailable');
        return;
      }
      stage('capability_issued');

      // The run is bound to the holder the authorization service named; the
      // configured holderId is the startup identity used to accept a replay.
      // The session re-issues the same audience while the child runs; the
      // resulting nested frame goes over the supervisor's private fd 5 only.
      const session = createLeaseSession({
        authz: authzClient,
        holderId: claim.holderId,
        orgId: request.orgId,
        executionId: request.executionId,
        capabilityExpiresAt: capabilityBundle.issued.expiresAt,
        capabilityGeneration: capabilityBundle.issued.generation,
        refreshCapability: async () => {
          const refreshed = await issueCapabilitiesForRequest(authzClient, request, endpoints);
          return {
            capabilities: refreshed.capabilities,
            generation: refreshed.issued.generation,
            expiresAt: refreshed.issued.expiresAt,
          };
        },
        ...leaseOptions,
      });

      let settled;
      try {
        settled = await supervisor.start({
          runId: request.runId,
          fence: request.fence,
          holderId: claim.holderId,
          payload: request,
          capabilities: capabilityBundle.capabilities,
          lease: session,
        });
      } catch {
        sendError(res, 500, 'internal_error');
        return;
      } finally {
        // Covers spawn failures and rejected starts where attach never ran.
        session.detach();
      }
      stage(`child_${settled.status}`);

      if (settled.status === 'rejected') {
        const mapping = statusForReason(settled.diagnostics?.reason);
        sendError(res, mapping.status, mapping.code);
        return;
      }

      let result;
      try {
        result = advanceResult(request, settled);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        // A malformed outcome never becomes a guessed advance_result. The
        // supervisor has already killed the child (protocol_violation); the
        // conservative mapping below reports no ids/hashes at all.
        result = advanceResult(request, { status: 'protocol_violation' });
      }
      if (result === null) {
        sendError(res, 500, 'internal_error');
        return;
      }
      sendJSON(res, 200, result);
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code);
        return;
      }
      sendError(res, 500, 'internal_error');
    }
  };
}

/**
 * Create the HTTPS listener. The caller must supply the server certificate,
 * key, and the client CA; client certificates are mandatory and verified.
 */
export function createAdvanceServer({
  supervisor,
  holderId,
  cert,
  key,
  ca,
  authz,
  contentBaseUrl,
  egressBaseUrl,
  lease,
}) {
  if (cert === undefined || key === undefined || ca === undefined) {
    throw new TypeError('server certificate, key and client CA are required');
  }
  // The parent workload certificate already authenticates this process to the
  // control plane. Reuse it for the authorization hop unless a dedicated
  // client identity is configured.
  const handler = createAdvanceHandler({
    supervisor,
    holderId,
    authz: { ca, cert, key, ...(authz ?? {}) },
    contentBaseUrl,
    egressBaseUrl,
    lease,
  });
  const server = createHTTPSServer({
    cert,
    key,
    ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  }, (req, res) => {
    handler(req, res).catch(() => sendError(res, 500, 'internal_error'));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_error, socket) => {
    if (!socket.writable) return;
    const body = '{"code":"invalid_request"}';
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\nConnection: close\r\n\r\n${body}`,
    );
  });
  server.on('tlsClientError', () => {
    // A failed handshake (including a missing client certificate) ends at TLS.
  });
  return server;
}

// Short aliases for local wiring and tests.
export const createServer = createAdvanceServer;
export const createHandler = createAdvanceHandler;
export const MAX_REQUEST_BYTES = MAX_BODY_BYTES;
export const ADVANCE_RUNTIME_PATH = ROUTE;
