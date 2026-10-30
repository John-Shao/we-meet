// Per-Run Pi child entrypoint (D4 §6.2/§6.3, §8.1).
//
// Trust boundary: this process is not trusted with provider keys, PostgreSQL,
// Temporal, KMS, object-store credentials, or the parent's TLS identity. It
// speaks the existing bounded supervisor frames (hello/run/result), receives
// the advance_request payload on the private fd 3 pipe, reads authorised content
// only through the work-content proxy, and performs at most one model call
// through the authenticated work-egress gateway.
//
// The capability tokens arrive through a private bootstrap pipe (fd 4,
// selected by WORK_CHILD_BOOTSTRAP_FD) and are renewed through a private
// refresh pipe (fd 5, selected by WORK_CHILD_REFRESH_FD), never through argv,
// environment, disk, logs, or the advance_request payload. A refresh swaps the
// token/generation as one immutable value; an in-flight call keeps the
// credential it started with. A malformed or stale refresh is ignored, and a
// call made after the local 30s window closes fails closed with
// capability_expired instead of dispatching an expired bearer.
//
// The result frame carries the signed `outcome` state variant (ids, hashes and
// one enum reason) alongside the coarse terminal status. Task text, messages,
// templates, usage and provider bodies never enter a control frame, and the
// child always reads/writes content through the work-content proxy.

import { createReadStream, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Agent } from '@earendil-works/pi-agent-core';

import { createCapabilityRefresher, createLineReader } from './capability-refresh.mjs';
import { createContentClient, ContentClientError } from './content-client.mjs';
import { createGatewayClient, unavailableUsage } from './gateway-client.mjs';
import {
  PROTOCOL_VERSION,
  ProtocolError,
  createFrameReader,
  validateOutcome,
  writeFrame,
} from './protocol.mjs';

export const CONTRACT_VERSION = 'work-runtime-fragment-v1';
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_BOOTSTRAP_BYTES = 8 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The model descriptor is local and inert: the only stream function is the
// gateway adapter, so pi-ai never sees a provider, base URL, or API key.
const GATEWAY_MODEL = Object.freeze({
  id: 'work-frozen-request',
  name: 'work frozen request',
  api: 'work-egress',
  provider: 'work-egress',
  baseUrl: '',
  reasoning: false,
  input: [],
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
  contextWindow: 0,
  maxTokens: 0,
});

const ZERO_PI_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRef(value) {
  return isRecord(value) &&
    hasOnlyKeys(value, new Set(['refId', 'hash'])) &&
    Object.hasOwn(value, 'refId') &&
    Object.hasOwn(value, 'hash') &&
    typeof value.refId === 'string' && REF_PATTERN.test(value.refId) &&
    typeof value.hash === 'string' && HASH_PATTERN.test(value.hash);
}

function copyRef(value) {
  return isRef(value) ? { refId: value.refId, hash: value.hash } : null;
}

function outcomeBase(payload) {
  return {
    kind: 'advance_result',
    contractVersion: CONTRACT_VERSION,
    executionId: typeof payload?.executionId === 'string' ? payload.executionId : null,
  };
}

function failedOutcome(payload, reason, errorCode) {
  return {
    ...outcomeBase(payload),
    state: 'FAILED',
    checkpoint: copyRef(payload?.checkpoint),
    receipt: null,
    operationId: null,
    reason,
    errorCode,
    usage: unavailableUsage(),
  };
}

function waitingOutcome(payload) {
  return {
    ...outcomeBase(payload),
    state: 'WAITING_RECONCILE',
    checkpoint: copyRef(payload.checkpoint),
    receipt: null,
    operationId: payload.permit.operationId,
    reason: 'provider_unknown',
    errorCode: null,
    usage: unavailableUsage(),
  };
}

function modelRequestOutcome(payload, intent) {
  return {
    ...outcomeBase(payload),
    state: 'MODEL_REQUEST',
    checkpoint: copyRef(payload.checkpoint),
    receipt: null,
    operationId: null,
    reason: null,
    errorCode: null,
    intent: {
      request: { refId: intent.request.refId, hash: intent.request.hash },
      requestHash: intent.requestHash,
      logicalKey: intent.logicalKey,
    },
    usage: unavailableUsage(),
  };
}

function pendingIntent(state, payload) {
  if (!isRecord(state) || state.kind !== 'canonical_state' ||
      state.schemaVersion !== 'work-canonical-v1' || !isRecord(state.binding)) {
    return null;
  }
  if (state.binding.orgId !== payload.orgId ||
      state.binding.taskId !== payload.taskId ||
      state.binding.runId !== payload.runId ||
      state.binding.snapshotId !== payload.snapshotId ||
      state.binding.runtimeVersion !== payload.runtimeVersion) {
    return null;
  }
  const pending = state.pending;
  if (!isRecord(pending) || !isRef(pending.request)) return null;
  if (typeof pending.requestHash !== 'string' || !HASH_PATTERN.test(pending.requestHash)) {
    return null;
  }
  if (pending.request.hash !== pending.requestHash) return null;
  if (pending.logicalKey !== 'model:1' && pending.logicalKey !== 'model:2' &&
      pending.logicalKey !== 'model:3') {
    return null;
  }
  return pending;
}

function checkpointedOutcome(payload, checkpoint, receipt, usage) {
  return {
    ...outcomeBase(payload),
    state: 'CHECKPOINTED',
    checkpoint: { refId: checkpoint.refId, hash: checkpoint.hash },
    receipt: { refId: receipt.refId, hash: receipt.hash },
    operationId: payload.permit.operationId,
    reason: null,
    errorCode: null,
    usage,
  };
}

function invalidEnvelope(payload, errorCode = 'invalid_request') {
  return failedOutcome(isRecord(payload) ? payload : null, 'invalid_context', errorCode);
}

function validateEnvelope(payload) {
  if (!isRecord(payload)) return 'invalid_request';
  if (payload.kind !== 'advance_request') return 'invalid_request';
  if (payload.contractVersion !== CONTRACT_VERSION) return 'version_mismatch';
  if (payload.mode !== 'plan' && payload.mode !== 'execute') return 'invalid_mode';
  if (typeof payload.executionId !== 'string' || !UUID_PATTERN.test(payload.executionId)) {
    return 'invalid_execution';
  }
  for (const field of ['runId', 'taskId', 'snapshotId']) {
    if (typeof payload[field] !== 'string' || !UUID_PATTERN.test(payload[field])) {
      return `invalid_${field}`;
    }
  }
  if (typeof payload.orgId !== 'string' || payload.orgId.length === 0) return 'invalid_org';
  if (typeof payload.runtimeVersion !== 'string' || payload.runtimeVersion.length === 0) {
    return 'invalid_runtime_version';
  }
  if (!Number.isSafeInteger(payload.deadlineUnixMs) || payload.deadlineUnixMs <= 0) {
    return 'invalid_deadline';
  }
  if (payload.checkpoint !== null && payload.checkpoint !== undefined && !isRef(payload.checkpoint)) {
    return 'invalid_checkpoint';
  }
  if (payload.mode === 'execute') {
    if (!isRef(payload.checkpoint)) return 'invalid_checkpoint';
    if (!isRecord(payload.intent) || !isRef(payload.intent.request)) return 'invalid_intent';
    if (typeof payload.intent.requestHash !== 'string' ||
        !HASH_PATTERN.test(payload.intent.requestHash)) {
      return 'invalid_intent';
    }
    if (payload.intent.logicalKey !== 'model:1' && payload.intent.logicalKey !== 'model:2' &&
        payload.intent.logicalKey !== 'model:3') {
      return 'invalid_intent';
    }
    if (payload.intent.request.hash !== payload.intent.requestHash) {
      return 'request_hash_mismatch';
    }
    if (!isRecord(payload.permit) || typeof payload.permit.operationId !== 'string' ||
        !UUID_PATTERN.test(payload.permit.operationId)) {
      return 'invalid_permit';
    }
    if (typeof payload.permit.dispatchAttemptId !== 'string' ||
        !UUID_PATTERN.test(payload.permit.dispatchAttemptId)) {
      return 'invalid_permit';
    }
    if (payload.permit.requestHash !== payload.intent.requestHash) return 'permit_mismatch';
  } else if (payload.intent !== null && payload.intent !== undefined) {
    return 'plan_carries_intent';
  } else if (payload.permit !== null && payload.permit !== undefined) {
    return 'plan_carries_permit';
  }
  return null;
}

function contentFailure(error) {
  if (error instanceof ContentClientError) {
    if (typeof error.status === 'number' &&
        [400, 401, 403, 404, 409, 422].includes(error.status)) {
      return { reason: 'invalid_context', code: error.code };
    }
    if (error.code === 'content_invalid_ref' || error.code === 'content_invalid_hash' ||
        error.code === 'content_invalid_document') {
      return { reason: 'invalid_context', code: error.code };
    }
    return { reason: 'runtime_fault', code: error.code };
  }
  return { reason: 'runtime_fault', code: 'content_unavailable' };
}


function toPiUsage(usage) {
  if (usage === null || usage === undefined || usage.source === 'unavailable' ||
      typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') {
    return ZERO_PI_USAGE;
  }
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cachedInputTokens ?? 0,
    cacheWrite: 0,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMessage({ stopReason, usage, errorMessage }) {
  return {
    role: 'assistant',
    content: [],
    api: GATEWAY_MODEL.api,
    provider: GATEWAY_MODEL.provider,
    model: GATEWAY_MODEL.id,
    usage,
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: Date.now(),
  };
}

/**
 * Minimal stream with the AssistantMessageEventStream surface the Pi loop
 * consumes (async iteration plus result()). It is local so no pi-ai provider
 * transport is imported or constructed.
 */
function createTurnStream() {
  const queue = [];
  const waiters = [];
  let closed = false;
  let resolveResult;
  const resultPromise = new Promise((resolve) => {
    resolveResult = resolve;
  });

  function flush() {
    while (waiters.length > 0 && (queue.length > 0 || closed)) {
      const waiter = waiters.shift();
      if (queue.length > 0) {
        waiter({ value: queue.shift(), done: false });
      } else {
        waiter({ value: undefined, done: true });
      }
    }
  }

  return {
    push(event) {
      if (closed) return;
      if (event.type === 'done' || event.type === 'error') {
        closed = true;
        resolveResult(event.type === 'done' ? event.message : event.error);
      }
      queue.push(event);
      flush();
    },
    end(result) {
      if (result !== undefined) resolveResult(result);
      if (!closed) {
        closed = true;
        flush();
      } else {
        flush();
      }
    },
    result() {
      return resultPromise;
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

/**
 * The only seam for the Pi turn. The real implementation drives one
 * pi-agent-core Agent turn with an injected stream function; tests can replace
 * the whole seam without any provider.
 */
export async function runPiTurn({ messages, streamFn, signal } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('messages must be a non-empty array');
  }
  if (typeof streamFn !== 'function') throw new TypeError('streamFn must be a function');

  const systemText = messages
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
  const conversation = messages.filter((message) => message.role !== 'system');

  const agent = new Agent({
    initialState: {
      model: GATEWAY_MODEL,
      ...(systemText.length > 0 ? { systemPrompt: systemText } : {}),
      messages: conversation,
      thinkingLevel: 'off',
    },
    streamFn,
    // Deliberately no getApiKey and no tools: the gateway is the only route.
  });

  const events = [];
  const unsubscribe = agent.subscribe((event) => {
    events.push(event.type);
  });
  try {
    await agent.continue();
  } finally {
    unsubscribe();
  }

  const final = agent.state.messages[agent.state.messages.length - 1];
  return {
    messages: agent.state.messages.slice(),
    message: final ?? null,
    events,
    ...(signal === undefined ? {} : { aborted: signal.aborted === true }),
  };
}

/**
 * Build the stream function that routes one Pi turn to the egress gateway.
 * It never throws and never retries: failures are encoded in the stream.
 */
export function createGatewayStreamFn({
  gatewayClient,
  executionId,
  requestRef,
  requestHash,
  onOutcome,
}) {
  return function gatewayStreamFn() {
    const stream = createTurnStream();
    void (async () => {
      let outcome;
      try {
        outcome = await gatewayClient.call({
          executionId,
          requestRef: { refId: requestRef.refId, hash: requestRef.hash },
          requestHash,
        });
      } catch {
        outcome = Object.freeze({
          outcome: 'unknown',
          reason: 'client_error',
          usage: unavailableUsage(),
        });
      }
      onOutcome(outcome);

      if (outcome.outcome === 'success') {
        const message = assistantMessage({
          stopReason: 'stop',
          usage: toPiUsage(outcome.usage),
        });
        stream.push({ type: 'start', partial: { ...message } });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
        return;
      }

      const label = outcome.outcome === 'rejected'
        ? `rejected_${outcome.code}`
        : `unknown_${outcome.reason}`;
      const message = assistantMessage({
        stopReason: 'error',
        usage: ZERO_PI_USAGE,
        errorMessage: label,
      });
      stream.push({ type: 'start', partial: { ...message } });
      stream.push({ type: 'error', reason: 'error', error: message });
      stream.end(message);
    })();
    return stream;
  };
}

async function fetchDocument(contentClient, reference) {
  const bytes = await contentClient.get(reference.refId, reference.hash, { digest: 'document' });
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ContentClientError('content_invalid_document');
  }
  return document;
}

async function runPlan(payload, { contentClient }) {
  if (!isRef(payload.checkpoint)) {
    return failedOutcome(payload, 'invalid_context', 'checkpoint_required');
  }
  if (contentClient === null || contentClient === undefined) {
    return failedOutcome(payload, 'runtime_fault', 'capability_unavailable');
  }

  let state;
  try {
    state = await fetchDocument(contentClient, payload.checkpoint);
  } catch (error) {
    const failure = contentFailure(error);
    return failedOutcome(payload, failure.reason, failure.code);
  }

  // A checkpoint that already carries a pending model intent can be surfaced
  // as the next MODEL_REQUEST without writing anything. Producing a brand-new
  // model_request candidate needs the content-candidate write route, which is
  // not part of this child, so that case fails closed before dispatch.
  const intent = pendingIntent(state, payload);
  if (intent !== null) return modelRequestOutcome(payload, intent);
  return failedOutcome(payload, 'runtime_fault', 'plan_model_request_candidate_unavailable');
}

async function runExecute(payload, { gatewayClient, runPiTurn: turnRunner }) {
  // D4 §6.2 narrows the content capability by mode: an execute fragment holds
  // only work-egress. The child never reads input, template or intent bodies;
  // work-egress assembles the frozen request's messages server-side from the
  // same references. A successful receipt and answer are written by egress and
  // the control plane commits the canonical successor from them.
  if (gatewayClient === null || gatewayClient === undefined) {
    return failedOutcome(payload, 'runtime_fault', 'capability_unavailable');
  }

  const intent = payload.intent;
  const permit = payload.permit;
  const checkpoint = payload.checkpoint;
  if (!isRecord(intent) || !isRecord(intent.request) ||
      typeof intent.request.refId !== 'string' || typeof intent.request.hash !== 'string' ||
      !isRecord(permit) || typeof permit.requestHash !== 'string' ||
      !isRecord(checkpoint) || typeof checkpoint.refId !== 'string' ||
      typeof checkpoint.hash !== 'string') {
    return failedOutcome(payload, 'invalid_context', 'model_request_invalid');
  }
  if (Date.now() >= payload.deadlineUnixMs) {
    return failedOutcome(payload, 'deadline_exceeded', 'deadline_exceeded');
  }

  // The concrete prompt is assembled by the gateway; this turn only drives the
  // single bound call. The child's local message never reaches the provider.
  const messages = [{
    role: 'user',
    content: 'Execute the bound model request.',
    timestamp: Date.now(),
  }];

  const call = { count: 0, outcome: null };
  const streamFn = createGatewayStreamFn({
    gatewayClient,
    executionId: payload.executionId,
    requestRef: intent.request,
    requestHash: permit.requestHash,
    onOutcome(outcome) {
      call.count += 1;
      call.outcome = outcome;
    },
  });

  try {
    await turnRunner({ messages, streamFn });
  } catch {
    return failedOutcome(payload, 'runtime_fault', 'pi_turn_failed');
  }

  if (call.count === 0) {
    return failedOutcome(payload, 'runtime_fault', 'pi_turn_without_gateway_call');
  }
  if (call.count > 1) {
    // More than one dispatch attempt cannot be proven terminal from here.
    return waitingOutcome(payload);
  }

  const outcome = call.outcome;
  if (outcome.outcome === 'success') {
    return checkpointedOutcome(payload, checkpoint, outcome.receipt, outcome.usage);
  }
  if (outcome.outcome === 'rejected') {
    return failedOutcome(payload, 'runtime_fault', outcome.code);
  }
  return waitingOutcome(payload);
}

/**
 * Execute one advance_request. Returns an advance_result-shaped object that
 * carries only ids, hashes, enum reasons, and usage (unknown usage is null,
 * never zero). No input, template, prompt, or model text is included.
 */
export async function runAdvance(payload, {
  contentClient = null,
  gatewayClient = null,
  runPiTurn: turnRunner = runPiTurn,
} = {}) {
  const invalid = validateEnvelope(payload);
  if (invalid !== null) return invalidEnvelope(payload, invalid);
  if (Date.now() >= payload.deadlineUnixMs) {
    return failedOutcome(payload, 'deadline_exceeded', 'deadline_exceeded');
  }
  if (payload.mode === 'plan') return runPlan(payload, { contentClient });
  return runExecute(payload, { contentClient, gatewayClient, runPiTurn: turnRunner });
}

function readFd(fd, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const stream = createReadStream(null, { fd, autoClose: false });
    stream.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        stream.destroy();
        reject(new Error('input_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
  });
}

/**
 * Start the refresh channel. The stream stays open for the life of the Run and
 * is not an error channel: a closed pipe, an oversized line or malformed JSON
 * only leaves the previous credential installed. Lines are consumed in order,
 * and the refresher queues them until the clients exist.
 */
function startRefreshReader(fd, refresher) {
  const stream = createReadStream(null, { fd, autoClose: false });
  const reader = createLineReader({
    onLine(line) {
      refresher.applyLine(line);
    },
  });
  stream.on('data', (chunk) => {
    try {
      reader.push(chunk);
    } catch {
      // A broken refresh line never escalates to a control-protocol failure.
    }
  });
  stream.on('error', () => {});
  return stream;
}

function waitForRun(stdin) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const reader = createFrameReader({
      onFrame(frame) {
        if (frame.type === 'run') finish(resolve);
        else finish(reject, new ProtocolError('unexpected_frame'));
      },
      onError(error) {
        finish(reject, error);
      },
    });
    stdin.on('data', (chunk) => reader.push(chunk));
    stdin.on('end', () => finish(reject, new ProtocolError('stdin_closed')));
    stdin.on('error', () => finish(reject, new ProtocolError('stdin_error')));
  });
}

function parseBootstrap(buffer) {
  if (buffer === null) return null;
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['content', 'egress']))) return null;
  const readSide = (side) => {
    if (!isRecord(side) || !hasOnlyKeys(side, new Set(['baseUrl', 'token', 'generation']))) {
      return null;
    }
    if (typeof side.baseUrl !== 'string' || side.baseUrl.length === 0 ||
        typeof side.token !== 'string' || side.token.length === 0 ||
        !Number.isSafeInteger(side.generation) || side.generation <= 0) {
      return null;
    }
    return { baseUrl: side.baseUrl, token: side.token, generation: side.generation };
  };
  const content = value.content === undefined ? null : readSide(value.content);
  const egress = value.egress === undefined ? null : readSide(value.egress);
  if (value.content !== undefined && content === null) return null;
  if (value.egress !== undefined && egress === null) return null;
  return { content, egress };
}

function clientsFromBootstrap(bootstrap, payload) {
  if (bootstrap === null) return { contentClient: null, gatewayClient: null };
  const common = {
    org: typeof payload?.orgId === 'string' ? payload.orgId : null,
    execution: typeof payload?.executionId === 'string' ? payload.executionId : null,
  };
  if (typeof common.org !== 'string' || common.org.length === 0 ||
      typeof common.execution !== 'string' || !UUID_PATTERN.test(common.execution)) {
    return { contentClient: null, gatewayClient: null };
  }
  let contentClient = null;
  let gatewayClient = null;
  try {
    if (bootstrap.content !== null) {
      contentClient = createContentClient({
        baseUrl: bootstrap.content.baseUrl,
        token: bootstrap.content.token,
        org: common.org,
        execution: common.execution,
        generation: bootstrap.content.generation,
      });
    }
    if (bootstrap.egress !== null) {
      gatewayClient = createGatewayClient({
        baseUrl: bootstrap.egress.baseUrl,
        token: bootstrap.egress.token,
        org: common.org,
        execution: common.execution,
        generation: bootstrap.egress.generation,
      });
    }
  } catch {
    return { contentClient: null, gatewayClient: null };
  }
  return { contentClient, gatewayClient };
}

/**
 * Reduce the internal result to the signed frame outcome. Only the envelope-free
 * state variant (state, references, operationId, reason) survives; usage,
 * errorCode and null placeholders never cross the control frame. Anything that
 * does not validate is dropped so the parent falls back to its conservative
 * mapping instead of receiving a malformed result.
 */
function frameOutcome(outcome) {
  if (!isRecord(outcome)) return null;
  let checkpoint;
  if (outcome.checkpoint === null) checkpoint = null;
  else if (isRef(outcome.checkpoint)) checkpoint = copyRef(outcome.checkpoint);
  let wire;
  switch (outcome.state) {
    case 'MODEL_REQUEST':
      wire = {
        state: outcome.state,
        checkpoint: checkpoint ?? undefined,
        intent: isRecord(outcome.intent) && isRef(outcome.intent.request)
          ? {
              request: copyRef(outcome.intent.request),
              requestHash: outcome.intent.requestHash,
              logicalKey: outcome.intent.logicalKey,
            }
          : undefined,
      };
      break;
    case 'CHECKPOINTED':
      wire = {
        state: outcome.state,
        checkpoint: checkpoint ?? undefined,
        receipt: isRef(outcome.receipt) ? copyRef(outcome.receipt) : undefined,
      };
      break;
    case 'WAITING_RECONCILE':
      wire = {
        state: outcome.state,
        checkpoint,
        operationId: outcome.operationId,
        reason: outcome.reason,
      };
      break;
    case 'FINISHED':
      wire = {
        state: outcome.state,
        checkpoint: checkpoint ?? undefined,
        artifact: isRef(outcome.artifact) ? copyRef(outcome.artifact) : undefined,
      };
      break;
    case 'FAILED':
    case 'CANCELED':
      wire = { state: outcome.state, checkpoint, reason: outcome.reason };
      break;
    default:
      return null;
  }
  for (const key of Object.keys(wire)) {
    if (wire[key] === undefined) delete wire[key];
  }

  try {
    return validateOutcome(wire);
  } catch (error) {
    // Safe diagnostic only: the protocol code, never the outcome body.
    writeSync(2, `work child outcome rejected code=${error?.code ?? error?.name ?? 'unknown'}\n`);
    return null;
  }
}

/**
 * Entrypoint. Sends hello with the supervisor nonce, reads the advance_request
 * from fd 3, waits for the run frame, runs one advance, and answers with the
 * bounded result frame plus the signed outcome (when it validates).
 * Returns the process exit code.
 */
export async function main({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  const runId = env.WORK_RUN_ID ?? env.WORK_CHILD_RUN_ID ?? '';
  const nonce = env.WORK_CHILD_NONCE ?? env.WORK_RUN_NONCE ?? '';
  if (runId.length === 0 || nonce.length === 0) return 2;

  const runPromise = waitForRun(stdin);
  runPromise.catch(() => {});
  writeFrame(stdout, { v: PROTOCOL_VERSION, type: 'hello', runId, nonce });

  const bootstrapFdRaw = env.WORK_CHILD_BOOTSTRAP_FD;
  const bootstrapFd = bootstrapFdRaw === undefined ? null : Number(bootstrapFdRaw);
  const bootstrapPromise = Number.isSafeInteger(bootstrapFd) && bootstrapFd > 0
    ? readFd(bootstrapFd, MAX_BOOTSTRAP_BYTES).catch(() => null)
    : Promise.resolve(null);

  // fd 5 stays open for the whole Run. Reading starts before the clients exist
  // so an early refresh is queued instead of lost.
  const refresher = createCapabilityRefresher();
  const refreshFdRaw = env.WORK_CHILD_REFRESH_FD;
  const refreshFd = refreshFdRaw === undefined ? null : Number(refreshFdRaw);
  const refreshStream = Number.isSafeInteger(refreshFd) && refreshFd > 0 &&
      refreshFd !== 3 && refreshFd !== bootstrapFd
    ? startRefreshReader(refreshFd, refresher)
    : null;

  const [payloadResult, bootstrapResult] = await Promise.all([
    readFd(3, MAX_PAYLOAD_BYTES).then(
      (bytes) => ({ ok: true, bytes }),
      () => ({ ok: false, bytes: null }),
    ),
    bootstrapPromise,
  ]);

  let run;
  try {
    run = await runPromise;
  } catch {
    refreshStream?.destroy();
    return 4;
  }
  void run;

  let payload = null;
  let outcome;
  if (!payloadResult.ok) {
    outcome = invalidEnvelope(null, 'invalid_request');
  } else {
    try {
      payload = JSON.parse(payloadResult.bytes.toString('utf8'));
    } catch {
      outcome = invalidEnvelope(null, 'invalid_request');
    }
  }

  if (outcome === undefined) {
    const bootstrap = parseBootstrap(bootstrapResult);
    const { contentClient, gatewayClient } = clientsFromBootstrap(bootstrap, payload);
    refresher.attach({ contentClient, gatewayClient });
    outcome = await runAdvance(payload, { contentClient, gatewayClient });
  }

  // The parent closes fd 5 when it accepts the result (or starts termination).
  // Leaving the read side alone avoids an EPIPE race with an in-flight refresh
  // that could otherwise overwrite the result this frame reports.

  const status = outcome.state === 'CHECKPOINTED' ? 'completed' : 'failed';
  const exitCode = status === 'completed' ? 0 : 1;
  const wire = frameOutcome(outcome);
  if (wire === null) {
    writeSync(2, `work child outcome null state=${typeof outcome?.state === 'string' ? outcome.state : '-'}\n`);
  }
  const frame = {
    v: PROTOCOL_VERSION,
    type: 'result',
    status,
    ...(wire === null ? {} : { outcome: wire }),
  };
  return new Promise((resolve) => {
    writeFrame(stdout, frame, () => {
      resolve(exitCode);
    });
  });
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => {
      // Let the loop drain instead of calling process.exit while the fs read
      // handles for fd 3/4 and the piped stdio are still closing. The result
      // frame has already been flushed by main().
      process.exitCode = code;
      try {
        process.stdin.destroy();
        process.stdout.end();
      } catch {
        // The parent may already have closed its side of the pipes.
      }
    },
    () => {
      process.exitCode = 5;
      try {
        process.stderr.end();
      } catch {
        // Nothing left to report on.
      }
    },
  );
}
