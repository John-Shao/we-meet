// Trust boundary: the supervisor (parent) is trusted; the per-Run child is not.
// The child may only speak versioned, bounded, schema-checked control frames.
// A result frame carries a terminal status and, optionally, the signed
// advance_result state variant (ids, hashes and one enum reason only). The task
// payload moves over a separate opaque pipe and never enters the framed
// protocol; the outcome explicitly refuses any unknown key, so task text,
// messages and provider bodies have no field to travel in.

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 64 * 1024;
// A result frame may carry an optional advance_result state variant. It is
// bounded independently so a result frame cannot be padded with ids/hashes.
export const MAX_OUTCOME_BYTES = 4 * 1024;

const FRAME_FIELDS = {
  hello: ['runId', 'nonce'],
  run: [],
  result: ['status'],
};
// Optional fields are admitted by the shape check but never required.
const FRAME_OPTIONAL_FIELDS = {
  result: ['outcome'],
};

const RESULT_STATUSES = new Set(['completed', 'failed']);

// The signed AdvanceRuntimeResult union, without the fixed envelope
// (kind/contractVersion/executionId). The child reports only the state variant;
// the parent transport supplies the envelope from the validated request, so a
// child can never rewrite the execution identity.
export const OUTCOME_STATES = Object.freeze([
  'MODEL_REQUEST',
  'CHECKPOINTED',
  'WAITING_RECONCILE',
  'FINISHED',
  'FAILED',
  'CANCELED',
]);

const OUTCOME_FIELDS = new Set([
  'state',
  'checkpoint',
  'intent',
  'receipt',
  'artifact',
  'operationId',
  'reason',
]);

const OUTCOME_REQUIRED = {
  MODEL_REQUEST: ['checkpoint', 'intent'],
  CHECKPOINTED: ['checkpoint', 'receipt'],
  WAITING_RECONCILE: ['operationId', 'reason'],
  FINISHED: ['checkpoint', 'artifact'],
  FAILED: ['reason'],
  CANCELED: ['reason'],
};

const OUTCOME_FORBIDDEN = {
  MODEL_REQUEST: ['receipt', 'artifact', 'operationId', 'reason'],
  CHECKPOINTED: ['intent', 'artifact', 'operationId', 'reason'],
  WAITING_RECONCILE: ['intent', 'receipt', 'artifact'],
  FINISHED: ['intent', 'receipt', 'operationId', 'reason'],
  FAILED: ['intent', 'receipt', 'artifact', 'operationId'],
  CANCELED: ['intent', 'receipt', 'artifact', 'operationId'],
};

const OUTCOME_REASONS = {
  WAITING_RECONCILE: new Set(['provider_unknown', 'receipt_unavailable']),
  FAILED: new Set(['invalid_context', 'checkpoint_failed', 'runtime_fault', 'deadline_exceeded']),
  CANCELED: new Set(['cancel_requested']),
};

// States whose checkpoint may be absent or null in the frame. The transport
// normalizes an absent checkpoint to null; the other states must name one.
const NULLABLE_CHECKPOINT_STATES = new Set(['WAITING_RECONCILE', 'FAILED', 'CANCELED']);

const LOGICAL_KEYS = new Set(['model:1', 'model:2', 'model:3']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const INTENT_FIELDS = new Set(['request', 'requestHash', 'logicalKey']);

export class ProtocolError extends Error {
  constructor(code, field) {
    super(field === undefined ? code : `${code}: ${field}`);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(frame, field) {
  if (typeof frame[field] !== 'string' || frame[field].length === 0) {
    throw new ProtocolError('invalid_field', field);
  }
}

function requireReference(value, field) {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'refId') || !Object.hasOwn(value, 'hash')) {
    throw new ProtocolError('invalid_field', field);
  }
  if (typeof value.refId !== 'string' || !UUID_PATTERN.test(value.refId)) {
    throw new ProtocolError('invalid_field', `${field}.refId`);
  }
  if (typeof value.hash !== 'string' || !HASH_PATTERN.test(value.hash)) {
    throw new ProtocolError('invalid_field', `${field}.hash`);
  }
  return { refId: value.refId, hash: value.hash };
}

function requireIntent(value) {
  if (!isRecord(value) || Object.keys(value).length !== INTENT_FIELDS.size ||
      [...INTENT_FIELDS].some((field) => !Object.hasOwn(value, field))) {
    throw new ProtocolError('invalid_field', 'intent');
  }
  const request = requireReference(value.request, 'intent.request');
  if (typeof value.requestHash !== 'string' || !HASH_PATTERN.test(value.requestHash)) {
    throw new ProtocolError('invalid_field', 'intent.requestHash');
  }
  if (!LOGICAL_KEYS.has(value.logicalKey)) {
    throw new ProtocolError('invalid_field', 'intent.logicalKey');
  }
  return { request, requestHash: value.requestHash, logicalKey: value.logicalKey };
}

/**
 * Validate the optional result-frame `outcome` against the signed
 * AdvanceRuntimeResult union. The envelope (kind/contractVersion/executionId)
 * is not part of the frame: it is supplied by the trusted parent. Unknown keys
 * at every level, unknown states, a reason outside its state's enum, a
 * non-reference checkpoint, a non-uuid operationId and a non-sha256 hash are
 * all refused. The serialized outcome is bounded to MAX_OUTCOME_BYTES so ids
 * and hashes can never be used as a smuggling channel.
 *
 * Returns a canonical copy; never the caller's object.
 */
export function validateOutcome(value) {
  if (!isRecord(value)) throw new ProtocolError('invalid_field', 'outcome');

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ProtocolError('outcome_not_serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OUTCOME_BYTES) {
    throw new ProtocolError('outcome_too_large');
  }

  for (const key of Object.keys(value)) {
    if (!OUTCOME_FIELDS.has(key)) throw new ProtocolError('unexpected_field', `outcome.${key}`);
  }
  if (!Object.hasOwn(value, 'state')) throw new ProtocolError('missing_field', 'outcome.state');
  if (typeof value.state !== 'string' || !Object.hasOwn(OUTCOME_REQUIRED, value.state)) {
    throw new ProtocolError('invalid_field', 'outcome.state');
  }

  const state = value.state;
  for (const field of OUTCOME_REQUIRED[state]) {
    if (!Object.hasOwn(value, field)) throw new ProtocolError('missing_field', `outcome.${field}`);
  }
  for (const field of OUTCOME_FORBIDDEN[state]) {
    if (Object.hasOwn(value, field)) throw new ProtocolError('unexpected_field', `outcome.${field}`);
  }

  const outcome = { state };

  if (Object.hasOwn(value, 'checkpoint')) {
    if (value.checkpoint === null) {
      if (!NULLABLE_CHECKPOINT_STATES.has(state)) {
        throw new ProtocolError('invalid_field', 'outcome.checkpoint');
      }
      outcome.checkpoint = null;
    } else {
      outcome.checkpoint = requireReference(value.checkpoint, 'outcome.checkpoint');
    }
  } else {
    // The signed union always names the checkpoint; the frame may omit it only
    // where the contract allows null.
    outcome.checkpoint = null;
  }

  if (Object.hasOwn(value, 'intent')) outcome.intent = requireIntent(value.intent);
  if (Object.hasOwn(value, 'receipt')) {
    outcome.receipt = requireReference(value.receipt, 'outcome.receipt');
  }
  if (Object.hasOwn(value, 'artifact')) {
    outcome.artifact = requireReference(value.artifact, 'outcome.artifact');
  }
  if (Object.hasOwn(value, 'operationId')) {
    if (typeof value.operationId !== 'string' || !UUID_PATTERN.test(value.operationId)) {
      throw new ProtocolError('invalid_field', 'outcome.operationId');
    }
    outcome.operationId = value.operationId;
  }
  if (Object.hasOwn(value, 'reason')) {
    if (typeof value.reason !== 'string' || !OUTCOME_REASONS[state].has(value.reason)) {
      throw new ProtocolError('invalid_field', 'outcome.reason');
    }
    outcome.reason = value.reason;
  }

  return outcome;
}

export function validateFrame(frame) {
  if (!isRecord(frame)) throw new ProtocolError('not_object');
  if (!Object.hasOwn(frame, 'type')) throw new ProtocolError('missing_type');
  if (typeof frame.type !== 'string' || !Object.hasOwn(FRAME_FIELDS, frame.type)) {
    throw new ProtocolError('unknown_type');
  }
  if (!Object.hasOwn(frame, 'v')) throw new ProtocolError('missing_version');
  if (frame.v !== PROTOCOL_VERSION) throw new ProtocolError('wrong_version');

  const optional = FRAME_OPTIONAL_FIELDS[frame.type] ?? [];
  const allowed = new Set(['v', 'type', ...FRAME_FIELDS[frame.type], ...optional]);
  for (const key of Object.keys(frame)) {
    if (!allowed.has(key)) throw new ProtocolError('unexpected_field', key);
  }
  for (const field of FRAME_FIELDS[frame.type]) {
    if (!Object.hasOwn(frame, field)) throw new ProtocolError('missing_field', field);
  }

  if (frame.type === 'hello') {
    requireNonEmptyString(frame, 'runId');
    requireNonEmptyString(frame, 'nonce');
  } else if (frame.type === 'result') {
    if (!RESULT_STATUSES.has(frame.status)) {
      throw new ProtocolError('invalid_field', 'status');
    }
    if (Object.hasOwn(frame, 'outcome')) validateOutcome(frame.outcome);
  }

  return frame;
}

export function encodeFrame(frame) {
  validateFrame(frame);
  let json;
  try {
    json = JSON.stringify(frame);
  } catch {
    throw new ProtocolError('not_serializable');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_FRAME_BYTES) {
    throw new ProtocolError('frame_too_large');
  }
  return json;
}

export function decodeFrame(input) {
  let buffer;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_FRAME_BYTES) {
      throw new ProtocolError('frame_too_large');
    }
    buffer = Buffer.from(input, 'utf8');
  } else if (Buffer.isBuffer(input)) {
    if (input.length > MAX_FRAME_BYTES) throw new ProtocolError('frame_too_large');
    buffer = input;
  } else {
    throw new ProtocolError('not_serialized');
  }

  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ProtocolError('invalid_json');
  }
  return validateFrame(value);
}

export function writeFrame(stream, frame, callback) {
  const line = `${encodeFrame(frame)}\n`;
  return callback === undefined ? stream.write(line) : stream.write(line, callback);
}

export function createFrameReader({ onFrame, onError }) {
  let buffer = Buffer.alloc(0);
  let failed = false;

  function fail(error) {
    if (failed) return;
    failed = true;
    onError(error);
  }

  return {
    push(chunk) {
      if (failed) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      let newline = buffer.indexOf(0x0a);
      while (newline !== -1) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > MAX_FRAME_BYTES) {
          fail(new ProtocolError('frame_too_large'));
          return;
        }
        let frame;
        try {
          frame = decodeFrame(line);
        } catch (error) {
          fail(error);
          return;
        }
        onFrame(frame);
        if (failed) return;
        newline = buffer.indexOf(0x0a);
      }

      if (buffer.length > MAX_FRAME_BYTES) fail(new ProtocolError('frame_too_large'));
    },
  };
}
