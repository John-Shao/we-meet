// Capability refresh channel (D4 §6.2): fd 5 is a private, per-execution pipe
// that carries newline-delimited refresh frames from the parent to the child.
//
// A frame has the same nested shape as the fd 4 bootstrap, but exactly one
// audience per frame:
//
//   {"content":{"baseUrl","token","generation"}}
//   {"egress":{"baseUrl","token","generation"}}
//
// The pipe is not a control frame channel: tokens that travel here never enter
// fd 1 messaging, the environment, argv, logs or the settle result. Parsing is
// strict and bounded. A malformed or stale frame is ignored so the previous
// credential stays installed; the next call then fails closed once the locally
// tracked 30s capability lifetime is gone.

export const MAX_REFRESH_FRAME_BYTES = 8 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_TOKEN_LENGTH = 2048;
// A refresh that arrives before the clients exist is queued. The bound only
// protects memory: the real producer sends at most one frame every 20s.
const MAX_PENDING_FRAMES = 8;
const SIDE_FIELDS = new Set(['baseUrl', 'token', 'generation']);
const FRAME_SIDES = ['content', 'egress'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function readSide(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, SIDE_FIELDS) ||
      Object.keys(value).length !== SIDE_FIELDS.size) {
    return null;
  }
  if (typeof value.baseUrl !== 'string' || value.baseUrl.length === 0 ||
      value.baseUrl.length > MAX_URL_LENGTH) {
    return null;
  }
  if (typeof value.token !== 'string' || value.token.length === 0 ||
      value.token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  if (!Number.isSafeInteger(value.generation) || value.generation <= 0) {
    return null;
  }
  return { baseUrl: value.baseUrl, token: value.token, generation: value.generation };
}

/**
 * Parse one newline-delimited refresh line. Returns
 * `{ side, credential }` or null for anything malformed. The caller must not
 * treat null as a fatal protocol error: the previous token stays in force.
 */
export function parseRefreshFrame(line) {
  let text;
  if (typeof line === 'string') {
    text = line;
  } else if (Buffer.isBuffer(line)) {
    if (line.length > MAX_REFRESH_FRAME_BYTES) return null;
    text = line.toString('utf8');
  } else {
    return null;
  }
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_REFRESH_FRAME_BYTES) {
    return null;
  }
  if (text.endsWith('\r')) text = text.slice(0, -1);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  const side = FRAME_SIDES.find((name) => Object.hasOwn(value, name));
  if (side === undefined) return null;
  const credential = readSide(value[side]);
  if (credential === null) return null;
  return { side, credential };
}

/**
 * Split a byte stream into bounded lines. An over-long line is discarded up to
 * its newline without buffering it; the channel then continues. Blank lines are
 * skipped. This is deliberately independent of the fd 1 frame reader: a bad
 * refresh must never be a control-protocol violation.
 */
export function createLineReader({ maxLineBytes = MAX_REFRESH_FRAME_BYTES, onLine } = {}) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new TypeError('maxLineBytes must be a positive integer');
  }
  if (typeof onLine !== 'function') throw new TypeError('onLine must be a function');

  let buffered = Buffer.alloc(0);
  let discarding = false;

  function push(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (;;) {
      const newline = data.indexOf(0x0a, start);
      const end = newline === -1 ? data.length : newline;
      if (!discarding && end > start) {
        const piece = data.subarray(start, end);
        if (buffered.length + piece.length > maxLineBytes) {
          buffered = Buffer.alloc(0);
          discarding = true;
        } else {
          buffered = buffered.length === 0 ? Buffer.from(piece) : Buffer.concat([buffered, piece]);
        }
      }
      if (newline === -1) return;
      if (!discarding && buffered.length > 0) {
        const line = buffered.toString('utf8');
        buffered = Buffer.alloc(0);
        onLine(line);
      } else {
        buffered = Buffer.alloc(0);
      }
      discarding = false;
      start = newline + 1;
    }
  }

  return { push };
}

/**
 * Route refresh frames to the two clients. Frames that arrive before `attach`
 * are queued (bounded) and replayed in order. A side without a client is
 * dropped: a plan fragment has no egress client and an execute fragment has no
 * content client (D4 §6.2 narrows the content capability by mode).
 */
export function createCapabilityRefresher() {
  let contentClient = null;
  let gatewayClient = null;
  let attached = false;
  const pending = [];

  function clientFor(side) {
    return side === 'content' ? contentClient : gatewayClient;
  }

  function apply(frame) {
    if (frame === null) return false;
    const client = clientFor(frame.side);
    if (client === null || typeof client.updateCapability !== 'function') {
      if (!attached) {
        pending.push(frame);
        if (pending.length > MAX_PENDING_FRAMES) pending.shift();
      }
      return false;
    }
    try {
      return client.updateCapability(frame.credential) === true;
    } catch {
      return false;
    }
  }

  return {
    applyLine(line) {
      return apply(parseRefreshFrame(line));
    },
    attach({ contentClient: content = null, gatewayClient: gateway = null } = {}) {
      contentClient = content;
      gatewayClient = gateway;
      attached = true;
      const queued = pending.splice(0, pending.length);
      for (const frame of queued) apply(frame);
    },
  };
}
