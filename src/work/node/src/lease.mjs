// Execution lease ownership for one Run (D-3 option A, §6.2/§6.5).
//
// The parent, never the child, is the lease holder. Before any capability is
// issued or any child exists it claims the execution over its own mTLS
// identity. While the child runs it renews every 10s with a strictly
// increasing heartbeat sequence and stops the child the moment the lease is
// gone: a renewal that returns `expired` (no lease), names another holder, or
// fails at the transport is a lease loss. The supervisor then reaps the child
// with SIGTERM -> SIGKILL and the Run settles as `lease_lost`, never as a
// success.
//
// Holder identity: the signed claim command does not accept a client-supplied
// holder id; the authorization module mints one bound to the authenticated
// workload and returns it (§6.2). The parent accepts a replayed claim
// (`already_claimed`) only when it names the configured startup holder, adopts
// the returned holder for every renewal, and refuses any other holder at
// renewal time. A restart registers a new holder; nothing is inherited.
//
// Capability refresh (D4 §6.2): fd 4 is the one-shot bootstrap; fd 5 is a
// dedicated, private refresh pipe. While the child runs this session re-issues
// the execution's audience capability and writes each nested frame before the
// current token dies (default: 20s after the last issuance, or earlier when the
// issued expiry leaves less room). The generation is strictly monotonic and the
// child swaps it atomically; the issuer invalidates the old generation.
//
// A refresh failure is terminal: no retry, no further frames, and the child is
// reaped through the supervisor's SIGTERM -> SIGKILL path as
// `capability_refresh_failed`, so it can never keep calling with a token that
// is about to expire. A lease renewal loss keeps priority: it stops the session
// first, and an in-flight refresh may no longer write after that. No token ever
// appears in a control frame, the environment, argv, a log line or the settle
// result; only the private pipe carries it.

import { request as httpsRequest } from 'node:https';

/** Lease granted by claim_runtime_execution and extended by renew. */
export const LEASE_DURATION_MS = 30_000;
/** The parent renews at 10s: three chances inside one 30s lease. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Capability lifetime ceiling enforced by the authorization service. */
export const CAPABILITY_TTL_MS = 30_000;
/** Renew at 20s so a 30s token never reaches its expiry. */
export const CAPABILITY_REFRESH_INTERVAL_MS = 20_000;
/** Refresh at least this long before the issued expiry. */
export const CAPABILITY_REFRESH_MARGIN_MS = 1_000;

export const MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TOKEN_LENGTH = 2048;
const MAX_HOLDER_LENGTH = 256;
const CODE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
const LEASE_FIELDS = new Set(['execution_id', 'holder_id', 'state', 'lease_until']);
const CAPABILITY_FIELDS = new Set(['token', 'generation', 'expires_at']);
const CLAIM_STATES = new Set(['claimed', 'already_claimed']);
const RENEW_STATES = new Set(['active', 'expired']);

const HOLDER_MISMATCH_CODES = new Set([
  'runtime_execution_holder_mismatch',
  'runtime_capability_holder_mismatch',
  'holder_not_owned',
]);
const NOT_CLAIMABLE_CODES = new Set([
  'runtime_execution_not_claimable',
  'runtime_execution_not_found',
  'runtime_execution_expired',
  'runtime_execution_not_active',
  'run_not_current',
  'org_execution_unavailable',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * A lease/capability failure carrying one enumeration code only. The message is
 * the code; tokens, holder ids and remote text never travel through it.
 */
export class LeaseError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LeaseError';
    this.code = code;
  }
}

class RpcError extends Error {
  constructor(status, code) {
    super('authz_rpc_failed');
    this.name = 'RpcError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Validate the node-side authorization client configuration. `authz` is the
 * parent's mTLS identity; the URL must be https and must not embed credentials.
 */
export function normalizeAuthzConfig(value) {
  if (!isRecord(value)) throw new TypeError('authz configuration is required');
  let base;
  try {
    base = new URL(value.url);
  } catch {
    throw new TypeError('authz.url must be an https URL');
  }
  if (base.protocol !== 'https:' || base.username !== '' || base.password !== '') {
    throw new TypeError('authz.url must be an https URL');
  }
  if (value.ca === undefined || value.cert === undefined || value.key === undefined) {
    throw new TypeError('authz.ca, authz.cert and authz.key are required');
  }
  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('authz.timeoutMs must be a positive integer');
  }
  const serverName = value.serverName ?? base.hostname;
  if (typeof serverName !== 'string' || serverName.length === 0) {
    throw new TypeError('authz.serverName is required');
  }
  return {
    host: base.hostname,
    port: base.port === '' ? 443 : Number(base.port),
    ca: value.ca,
    cert: value.cert,
    key: value.key,
    serverName,
    timeoutMs,
  };
}

function readRemoteCode(buffer) {
  if (buffer.length === 0) return null;
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 ||
      typeof value.code !== 'string' || !CODE_PATTERN.test(value.code)) {
    return null;
  }
  return value.code;
}

// One command over the parent's mTLS identity. The response is read exactly
// once, bounded, and never logged; failures carry an enumeration code only.
function postCommand(config, command, body) {
  return new Promise((resolve, reject) => {
    let payload;
    try {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
    } catch {
      reject(new LeaseError('lease_unavailable'));
      return;
    }

    let settled = false;
    let responseReceived = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = httpsRequest({
      host: config.host,
      port: config.port,
      path: `/internal/v1/commands/${command}`,
      method: 'POST',
      ca: config.ca,
      cert: config.cert,
      key: config.key,
      servername: config.serverName,
      minVersion: 'TLSv1.2',
      timeout: config.timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        accept: 'application/json',
      },
    }, (response) => {
      responseReceived = true;
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          request.destroy();
          fail(new LeaseError('lease_unavailable'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        const buffer = Buffer.concat(chunks, total);
        if (response.statusCode !== 200) {
          fail(new RpcError(response.statusCode, readRemoteCode(buffer)));
          return;
        }
        settled = true;
        resolve(buffer);
      });
      response.on('aborted', () => fail(new LeaseError('lease_unavailable')));
      response.on('error', () => fail(new LeaseError('lease_unavailable')));
      response.on('close', () => {
        if (!response.complete) fail(new LeaseError('lease_unavailable'));
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => fail(new LeaseError('lease_unavailable')));
    // A destroyed socket without an 'error' must not leave the command pending;
    // once a response exists, its own end/error handlers decide the outcome.
    request.on('close', () => {
      if (!responseReceived) fail(new LeaseError('lease_unavailable'));
    });
    request.end(payload);
  });
}

function claimFailure(error) {
  if (error instanceof RpcError && error.code !== null) {
    if (HOLDER_MISMATCH_CODES.has(error.code)) return new LeaseError('lease_holder_mismatch');
    if (NOT_CLAIMABLE_CODES.has(error.code)) return new LeaseError('lease_not_claimable');
  }
  return new LeaseError('lease_unavailable');
}

function parseLease(buffer, { executionId, states, requireLeaseUntil }) {
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, LEASE_FIELDS) ||
      !Object.hasOwn(value, 'execution_id') || !Object.hasOwn(value, 'holder_id') ||
      !Object.hasOwn(value, 'state')) {
    return null;
  }
  if (value.execution_id !== executionId) return null;
  if (typeof value.holder_id !== 'string' || value.holder_id.length === 0 ||
      value.holder_id.length > MAX_HOLDER_LENGTH) {
    return null;
  }
  if (typeof value.state !== 'string' || !states.has(value.state)) return null;

  let leaseUntil = null;
  if (Object.hasOwn(value, 'lease_until')) {
    if (typeof value.lease_until !== 'string') return null;
    const parsed = Date.parse(value.lease_until);
    if (!Number.isFinite(parsed)) return null;
    leaseUntil = parsed;
  }
  if (requireLeaseUntil && value.state === 'active') {
    // A renewal must hand back a lease that is still in the future; a "null
    // lease" is the expired path and is handled by the caller.
    if (leaseUntil === null || leaseUntil <= Date.now()) return null;
  }

  return { executionId: value.execution_id, holderId: value.holder_id, state: value.state, leaseUntil };
}

function parseCapabilityResponse(buffer) {
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, CAPABILITY_FIELDS) ||
      !Object.hasOwn(value, 'token') || !Object.hasOwn(value, 'generation') ||
      !Object.hasOwn(value, 'expires_at')) {
    return null;
  }
  if (typeof value.token !== 'string' || value.token.length === 0 ||
      value.token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  if (!Number.isSafeInteger(value.generation) || value.generation <= 0) return null;
  if (typeof value.expires_at !== 'string') return null;
  const expiresAt = Date.parse(value.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return { token: value.token, generation: value.generation, expiresAt };
}

/**
 * Create the parent-side authorization client. Every method either returns a
 * strictly shaped value or throws LeaseError; none of them log, echo a body or
 * expose a token to a caller other than the capability bootstrap writer.
 */
export function createAuthzClient(value) {
  const config = normalizeAuthzConfig(value);

  async function claim({ orgId, executionId, expectedHolderId } = {}) {
    if (typeof orgId !== 'string' || orgId.length === 0 ||
        typeof executionId !== 'string' || executionId.length === 0 ||
        typeof expectedHolderId !== 'string' || expectedHolderId.length === 0) {
      throw new TypeError('claim requires orgId, executionId and expectedHolderId');
    }
    let buffer;
    try {
      // The signed wire names only the execution; the holder is minted by the
      // authorization service and bound to this authenticated workload.
      buffer = await postCommand(config, 'claim_runtime_execution', {
        org_id: orgId,
        execution_id: executionId,
      });
    } catch (error) {
      throw claimFailure(error);
    }
    const lease = parseLease(buffer, {
      executionId,
      states: CLAIM_STATES,
      requireLeaseUntil: false,
    });
    if (lease === null) throw new LeaseError('lease_unavailable');
    if (lease.state === 'already_claimed' && lease.holderId !== expectedHolderId) {
      // A replay may only be the same holder; a different one means this
      // execution already belongs to another parent (restart means new holder).
      throw new LeaseError('lease_holder_mismatch');
    }
    return lease;
  }

  async function renew({ orgId, executionId, holderId, heartbeatSeq } = {}) {
    if (typeof orgId !== 'string' || orgId.length === 0 ||
        typeof executionId !== 'string' || executionId.length === 0 ||
        typeof holderId !== 'string' || holderId.length === 0 ||
        !Number.isSafeInteger(heartbeatSeq) || heartbeatSeq <= 0) {
      throw new TypeError('renew requires orgId, executionId, holderId and a positive heartbeatSeq');
    }
    let buffer;
    try {
      buffer = await postCommand(config, 'renew_runtime_execution', {
        org_id: orgId,
        execution_id: executionId,
        holder_id: holderId,
        heartbeat_seq: heartbeatSeq,
      });
    } catch {
      throw new LeaseError('lease_unavailable');
    }
    const lease = parseLease(buffer, {
      executionId,
      states: RENEW_STATES,
      requireLeaseUntil: true,
    });
    if (lease === null) throw new LeaseError('lease_unavailable');
    return lease;
  }

  async function issueCapability({ orgId, executionId, audience } = {}) {
    if (typeof orgId !== 'string' || orgId.length === 0 ||
        typeof executionId !== 'string' || executionId.length === 0 ||
        (audience !== 'work-content' && audience !== 'work-egress')) {
      throw new TypeError('issueCapability requires orgId, executionId and a runtime audience');
    }
    let buffer;
    try {
      buffer = await postCommand(config, 'issue_capability', {
        org_id: orgId,
        execution_id: executionId,
        audience,
      });
    } catch {
      throw new LeaseError('capability_unavailable');
    }
    const issued = parseCapabilityResponse(buffer);
    if (issued === null) throw new LeaseError('capability_unavailable');
    return issued;
  }

  return Object.freeze({ claim, renew, issueCapability });
}

/**
 * One Run's lease owner. `attach` is called by the supervisor immediately after
 * the child was spawned; `detach` on child exit or settlement. A lost lease or
 * a failed capability refresh terminates the child through the supervisor's
 * SIGTERM -> SIGKILL path exactly once.
 *
 * `refreshCapability` re-issues the execution's audience capability and returns
 * `{ capabilities, generation, expiresAt }`. The session checks that the
 * generation strictly increased and hands the nested frame to the supervisor's
 * fd 5 writer. There is no retry: a failure is a terminal authority loss.
 *
 * `now` and `timers` are injectable so tests can drive refresh timing
 * deterministically.
 */
export function createLeaseSession({
  authz,
  holderId,
  orgId,
  executionId,
  capabilityExpiresAt,
  capabilityGeneration,
  refreshCapability = null,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  capabilityRefreshIntervalMs = CAPABILITY_REFRESH_INTERVAL_MS,
  now = Date.now,
  timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
} = {}) {
  if (authz === null || typeof authz !== 'object' || typeof authz.renew !== 'function') {
    throw new TypeError('authz client is required');
  }
  if (typeof holderId !== 'string' || holderId.length === 0) {
    throw new TypeError('holderId is required');
  }
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new TypeError('orgId is required');
  }
  if (typeof executionId !== 'string' || executionId.length === 0) {
    throw new TypeError('executionId is required');
  }
  if (typeof capabilityExpiresAt !== 'number' || !Number.isFinite(capabilityExpiresAt)) {
    throw new TypeError('capabilityExpiresAt is required');
  }
  positiveInteger(heartbeatIntervalMs, 'heartbeatIntervalMs');
  if (heartbeatIntervalMs >= LEASE_DURATION_MS) {
    // A heartbeat at or beyond the lease leaves no renewal window.
    throw new TypeError('heartbeatIntervalMs must be shorter than the lease');
  }
  positiveInteger(capabilityRefreshIntervalMs, 'capabilityRefreshIntervalMs');
  if (capabilityRefreshIntervalMs >= CAPABILITY_TTL_MS) {
    // A refresh at or beyond the TTL leaves no live-token window.
    throw new TypeError('capabilityRefreshIntervalMs must be shorter than the capability TTL');
  }
  if (refreshCapability !== null && typeof refreshCapability !== 'function') {
    throw new TypeError('refreshCapability must be a function');
  }
  if (refreshCapability !== null) {
    positiveInteger(capabilityGeneration, 'capabilityGeneration');
  } else if (capabilityGeneration !== undefined) {
    positiveInteger(capabilityGeneration, 'capabilityGeneration');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (timers === null || typeof timers !== 'object' ||
      typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new TypeError('timers must expose setTimeout and clearTimeout');
  }

  let state = 'idle'; // idle -> running -> stopped | lost
  let control = null;
  let heartbeatTimer = null;
  let refreshTimer = null;
  let heartbeatSeq = 0;
  let renewInFlight = false;
  let refreshInFlight = false;
  // A refresh failure observed while a renewal is in flight waits for the
  // renewal verdict: a lease loss always wins over a refresh failure.
  let pendingRefreshLoss = null;
  let currentGeneration = capabilityGeneration ?? 0;
  let currentExpiresAt = capabilityExpiresAt;

  function clearTimers() {
    if (heartbeatTimer !== null) {
      timers.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (refreshTimer !== null) {
      timers.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  function stop() {
    if (state === 'stopped' || state === 'lost') return;
    state = 'stopped';
    clearTimers();
    control = null;
  }

  function lose(status, code) {
    if (state !== 'running') return;
    state = 'lost';
    clearTimers();
    const terminate = control?.terminate;
    control = null;
    if (typeof terminate === 'function') {
      try {
        terminate(status, code);
      } catch {
        // The supervisor owns the reaping path; there is no second channel here.
      }
    }
  }

  function scheduleHeartbeat() {
    if (state !== 'running') return;
    heartbeatTimer = timers.setTimeout(() => {
      heartbeatTimer = null;
      void renew();
    }, heartbeatIntervalMs);
  }

  function scheduleRefresh() {
    if (state !== 'running' || refreshCapability === null) return;
    // Normal case: the 20s interval fires with 10s of token life left. When the
    // issued expiry is shorter (short lease/hard deadline), refresh earlier
    // rather than let the token die.
    const remaining = currentExpiresAt - now();
    const delay = Math.max(
      0,
      Math.min(capabilityRefreshIntervalMs, remaining - CAPABILITY_REFRESH_MARGIN_MS),
    );
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, delay);
  }

  function validRefresh(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.capabilities === null || typeof value.capabilities !== 'object' ||
        Array.isArray(value.capabilities)) {
      return false;
    }
    if (!Number.isSafeInteger(value.generation) || value.generation <= 0) return false;
    if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return false;
    return true;
  }

  // No retry on any refresh failure. When a renewal is in flight the loss is
  // recorded and the renewal verdict decides: a lost lease terminates as
  // lease_lost, otherwise the refresh failure terminates.
  function failRefresh(code) {
    if (renewInFlight) {
      pendingRefreshLoss = code;
      return;
    }
    lose('capability_refresh_failed', code);
  }

  async function refresh() {
    if (state !== 'running' || refreshInFlight || refreshCapability === null) return;
    refreshInFlight = true;
    let refreshed;
    try {
      refreshed = await refreshCapability();
    } catch {
      refreshInFlight = false;
      failRefresh('refresh_failed');
      return;
    }
    refreshInFlight = false;
    // The child may have exited, the lease may have been lost, or the session
    // may have been stopped while the issuance was in flight. Never write,
    // reschedule or kill after that.
    if (state !== 'running') return;
    if (!validRefresh(refreshed) || refreshed.generation <= currentGeneration) {
      failRefresh('refresh_generation');
      return;
    }
    if (refreshed.expiresAt - now() <= CAPABILITY_REFRESH_MARGIN_MS) {
      // A token that is already inside the safety margin cannot be refreshed
      // again in time; stop instead of spinning or letting it lapse.
      failRefresh('refresh_expired');
      return;
    }
    const write = control?.refresh;
    if (typeof write !== 'function') {
      failRefresh('refresh_pipe_missing');
      return;
    }
    let written;
    try {
      written = write(refreshed.capabilities);
    } catch {
      written = false;
    }
    if (written !== true) {
      failRefresh('refresh_write_failed');
      return;
    }
    currentGeneration = refreshed.generation;
    currentExpiresAt = refreshed.expiresAt;
    scheduleRefresh();
  }

  async function renew() {
    if (state !== 'running' || renewInFlight) return;
    renewInFlight = true;
    heartbeatSeq += 1;
    const sequence = heartbeatSeq;
    let lease;
    try {
      lease = await authz.renew({ orgId, executionId, holderId, heartbeatSeq: sequence });
    } catch {
      renewInFlight = false;
      lose('lease_lost', 'renew_failed');
      return;
    }
    renewInFlight = false;
    // The child may have exited, the lease may have been lost, or a refresh
    // failure may have settled the session while the call was in flight;
    // never renew, kill or reschedule after that.
    if (state !== 'running') return;
    if (lease.state === 'expired' || lease.leaseUntil === null) {
      lose('lease_lost', 'lease_expired');
      return;
    }
    if (lease.holderId !== holderId) {
      lose('lease_lost', 'holder_mismatch');
      return;
    }
    // The lease is still ours, so a refresh failure recorded during this
    // renewal is now the governing settlement.
    if (pendingRefreshLoss !== null) {
      const code = pendingRefreshLoss;
      pendingRefreshLoss = null;
      lose('capability_refresh_failed', code);
      return;
    }
    scheduleHeartbeat();
  }

  return Object.freeze({
    attach(controls) {
      if (state !== 'idle') return false;
      if (controls === null || typeof controls !== 'object' ||
          typeof controls.terminate !== 'function') {
        throw new TypeError('lease control must expose terminate');
      }
      if (controls.refresh !== undefined && typeof controls.refresh !== 'function') {
        throw new TypeError('lease refresh must be a function');
      }
      control = { terminate: controls.terminate, refresh: controls.refresh };
      state = 'running';
      scheduleHeartbeat();
      // The child may have completed during startup; only a running session
      // with a refresh source arms the loop.
      scheduleRefresh();
      return true;
    },
    detach: stop,
    get state() {
      return state;
    },
    get heartbeatSeq() {
      return heartbeatSeq;
    },
  });
}
