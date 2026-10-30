// Trust boundary: this supervisor is trusted and runs in the pool Pod. Every
// child it starts is untrusted code for exactly one Run. The parent alone owns
// the concurrency slots, deadlines, nonce, and process reaping; a child gets a
// minimal environment plus the nonce and may only answer with bounded frames.
// Nothing the child sends is allowed to widen the local capacity or outlive a
// result, and parent credentials are never inherited by the child.

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  PROTOCOL_VERSION,
  ProtocolError,
  createFrameReader,
  encodeFrame,
} from './protocol.mjs';

// The real Pi child is the default. Tests replace it through the server's
// WORK_CHILD_SCRIPT wrapper; the stub is never the production executor.
const CHILD_ENTRY = fileURLToPath(new URL('./child-pi.mjs', import.meta.url));
const RUN_LINE = `${encodeFrame({ v: PROTOCOL_VERSION, type: 'run' })}\n`;
const CHILD_BASE_ENV = ['SystemRoot', 'windir', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS'];
const MAX_CAPABILITY_BYTES = 8 * 1024;
const START_KEYS = new Set(['runId', 'fence', 'holderId', 'payload', 'capabilities', 'lease']);
const ADMIT_KEYS = new Set(['runFence', 'runtimeVersion']);
// The only settlements a lease owner may force. Every other status is decided
// by the child's own result, a timeout, a crash or a protocol violation.
const LEASE_STATUSES = new Set(['lease_lost', 'capability_expired', 'capability_refresh_failed']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isFence(value) {
  return isNonEmptyString(value) || (Number.isSafeInteger(value) && value >= 0);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function invalidStartRequest(request) {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return 'request_not_object';
  }
  if (!hasOnlyKeys(request, START_KEYS)) return 'unexpected_field';
  if (!isNonEmptyString(request.runId)) return 'run_id';
  if (!isFence(request.fence)) return 'fence';
  if (!isNonEmptyString(request.holderId)) return 'holder_id';
  if (!Object.hasOwn(request, 'payload')) return 'payload';
  if (request.capabilities !== undefined &&
      (typeof request.capabilities !== 'object' || request.capabilities === null ||
       Array.isArray(request.capabilities))) {
    return 'capabilities';
  }
  if (request.lease !== undefined &&
      (typeof request.lease !== 'object' || request.lease === null ||
       Array.isArray(request.lease) ||
       typeof request.lease.attach !== 'function' || typeof request.lease.detach !== 'function')) {
    return 'lease';
  }
  return null;
}

function invalidAdmitRequest(request) {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return 'request_not_object';
  }
  if (!hasOnlyKeys(request, ADMIT_KEYS)) return 'unexpected_field';
  if (!isFence(request.runFence)) return 'run_fence';
  if (!isNonEmptyString(request.runtimeVersion)) return 'runtime_version';
  return null;
}

function sameNonce(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
}

function childEnvironment(identity) {
  const env = { ...identity };
  for (const key of CHILD_BASE_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function serializePayload(payload) {
  // Strings and byte arrays pass verbatim; other JSON values are serialized once.
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');

  let json;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw new ProtocolError('payload_not_serializable');
  }
  if (json === undefined) throw new ProtocolError('payload_not_serializable');
  return Buffer.from(json, 'utf8');
}

function serializeCapabilities(capabilities) {
  if (capabilities === undefined || capabilities === null) return null;
  let json;
  try {
    json = JSON.stringify(capabilities);
  } catch {
    throw new ProtocolError('capabilities_not_serializable');
  }
  if (json === undefined) throw new ProtocolError('capabilities_not_serializable');
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.length > MAX_CAPABILITY_BYTES) {
    throw new ProtocolError('capabilities_too_large');
  }
  return bytes;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

export class Supervisor {
  #maxConcurrent;
  #runtimeVersion;
  #startTimeoutMs;
  #runTimeoutMs;
  #killGraceMs;
  #spawn;
  #now;
  #active = new Map();
  #draining = false;
  #drainPromise = null;
  #shutdownPromise = null;
  #idleWaiters = new Set();

  constructor({
    maxConcurrent,
    runtimeVersion,
    startTimeoutMs = 5000,
    runTimeoutMs = 30000,
    killGraceMs = 2000,
    spawn = nodeSpawn,
    now = Date.now,
  } = {}) {
    this.#maxConcurrent = positiveInteger(maxConcurrent, 'maxConcurrent');
    if (!isNonEmptyString(runtimeVersion)) {
      throw new TypeError('runtimeVersion must be a non-empty string');
    }
    this.#runtimeVersion = runtimeVersion;
    this.#startTimeoutMs = positiveInteger(startTimeoutMs, 'startTimeoutMs');
    this.#runTimeoutMs = positiveInteger(runTimeoutMs, 'runTimeoutMs');
    this.#killGraceMs = nonNegativeNumber(killGraceMs, 'killGraceMs');
    if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#spawn = spawn;
    this.#now = now;
  }

  get activeCount() {
    return this.#active.size;
  }

  get draining() {
    return this.#draining;
  }

  get runtimeVersion() {
    return this.#runtimeVersion;
  }

  admit(request) {
    if (invalidAdmitRequest(request) !== null) return { ok: false, reason: 'invalid_request' };
    if (this.#draining) return { ok: false, reason: 'draining' };
    if (this.#active.size >= this.#maxConcurrent) return { ok: false, reason: 'capacity' };
    if (request.runtimeVersion !== this.#runtimeVersion) {
      return { ok: false, reason: 'version_mismatch' };
    }
    return { ok: true };
  }

  start(request) {
    const invalid = invalidStartRequest(request);
    if (invalid !== null) return this.#rejected('invalid_request', invalid);
    if (this.#draining) return this.#rejected('draining');
    if (this.#active.has(request.runId)) return this.#rejected('run_active');
    if (this.#active.size >= this.#maxConcurrent) return this.#rejected('capacity');

    let payloadBytes;
    let capabilityBytes;
    try {
      payloadBytes = serializePayload(request.payload);
      capabilityBytes = serializeCapabilities(request.capabilities);
    } catch (error) {
      return this.#rejected('invalid_request', error.code ?? 'payload_not_serializable');
    }

    const entry = {
      runId: request.runId,
      payloadBytes,
      capabilityBytes,
      nonce: randomBytes(24).toString('hex'),
      startedAt: this.#now(),
      phase: 'await_hello',
      child: null,
      // Optional lease owner. It may stop the child when the execution lease or
      // the startup capability is no longer valid; it never settles the Run.
      lease: request.lease ?? null,
      result: null,
      resultOutcome: null,
      outcome: null,
      diagnostics: null,
      exitCode: null,
      signal: null,
      exited: false,
      settled: false,
      timers: { startup: null, run: null, exitGrace: null, force: null },
      resolve: null,
    };
    const promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    this.#active.set(entry.runId, entry);

    const env = childEnvironment({
      WORK_RUN_ID: request.runId,
      WORK_RUN_NONCE: entry.nonce,
      WORK_PROTOCOL_VERSION: String(PROTOCOL_VERSION),
      WORK_RUNTIME_VERSION: this.#runtimeVersion,
      WORK_CHILD_BOOTSTRAP_FD: '4',
      // fd 5 is the dedicated capability refresh pipe. It stays open for the
      // life of the Run; the lease session writes nested refresh frames here.
      WORK_CHILD_REFRESH_FD: '5',
    });

    let child;
    try {
      child = this.#spawn(process.execPath, [CHILD_ENTRY], {
        env,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.#active.delete(entry.runId);
      entry.settled = true;
      entry.resolve({
        status: 'crashed',
        exitCode: null,
        diagnostics: { phase: 'spawn', code: error.code ?? 'spawn_error' },
      });
      return promise;
    }

    entry.child = child;
    console.log(`work runtime child started run=${String(entry.runId).slice(0, 8)} pid=${child.pid}`);
    this.#watch(entry);

    // The lease starts renewing as soon as a child exists. attach() must not be
    // able to leave a live child without a lease owner, so a throwing owner is
    // itself a lease loss.
    if (entry.lease !== null) {
      try {
        entry.lease.attach({
          terminate: (status, code) => this.#terminateForLease(entry, status, code),
          refresh: (capabilities) => this.#writeCapabilityRefresh(entry, capabilities),
        });
      } catch {
        this.#beginTermination(entry, 'lease_lost', {
          phase: 'startup',
          code: 'lease_controller_failed',
        });
      }
    }

    if (entry.phase === 'await_hello' && !entry.settled) {
      entry.timers.startup = setTimeout(() => {
        entry.timers.startup = null;
        this.#beginTermination(entry, 'timed_out', {
          phase: 'startup',
          elapsedMs: this.#now() - entry.startedAt,
        });
      }, this.#startTimeoutMs);
    }

    return promise;
  }

  drain() {
    this.#draining = true;
    if (this.#drainPromise !== null) return this.#drainPromise;

    this.#drainPromise = (async () => {
      if (this.#active.size === 0) return;

      let graceTimer;
      const graceElapsed = new Promise((resolve) => {
        graceTimer = setTimeout(resolve, this.#killGraceMs);
      });
      await Promise.race([this.#waitForIdle(), graceElapsed]);
      clearTimeout(graceTimer);

      if (this.#active.size === 0) return;
      for (const entry of this.#active.values()) {
        if (entry.phase !== 'terminating') {
          this.#beginTermination(entry, entry.outcome ?? 'timed_out', entry.outcome
            ? entry.diagnostics
            : { phase: 'drain', code: 'drain_grace_elapsed' });
        }
      }
      await this.#waitForIdle();
    })();

    return this.#drainPromise;
  }

  shutdown({ force = false } = {}) {
    this.#draining = true;

    for (const entry of this.#active.values()) {
      if (entry.phase === 'terminating') {
        if (force && !entry.exited) this.#signal(entry, 'SIGKILL');
        continue;
      }
      const status = entry.outcome ?? 'failed';
      const diagnostics = entry.outcome
        ? entry.diagnostics
        : { phase: 'shutdown', code: 'supervisor_shutdown' };
      this.#beginTermination(entry, status, diagnostics, { force });
    }

    if (this.#shutdownPromise === null) {
      this.#shutdownPromise = this.#waitForIdle();
    }
    return this.#shutdownPromise;
  }

  #watch(entry) {
    const child = entry.child;

    child.on('error', (error) => {
      if (entry.settled) return;
      if (child.pid === undefined) {
        this.#finalize(entry, 'crashed', { phase: 'spawn', code: error.code ?? 'spawn_error' });
      } else {
        this.#beginTermination(entry, 'crashed', {
          phase: entry.phase,
          code: error.code ?? 'child_error',
        });
      }
    });

    if (!child.stdout || !child.stdin || !child.stderr || !child.stdio?.[3]) return;

    const reader = createFrameReader({
      onFrame: (frame) => {
        try {
          this.#onFrame(entry, frame);
        } catch {
          this.#violation(entry, 'frame_handler_failed');
        }
      },
      onError: (error) => this.#violation(entry, error.code ?? 'protocol_error'),
    });

    child.stdout.on('data', (chunk) => {
      try {
        reader.push(chunk);
      } catch {
        this.#violation(entry, 'frame_reader_failed');
      }
    });
    // Forward child stderr to the parent's stderr so a quiet child failure is
    // visible in the service journal. The child never prints tokens or bodies.
    child.stderr.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      process.stderr.write(`work runtime child run=${String(entry.runId).slice(0, 8)} stderr: ${text}`);
    });
    child.stdin.on('error', () => {});
    child.stdio[3].on('error', () => {
      if (entry.settled || entry.outcome !== null) return;
      this.#beginTermination(entry, 'crashed', {
        phase: entry.phase === 'await_hello' ? 'startup' : 'run',
        code: 'payload_pipe_error',
      });
    });
    child.stdio[4]?.on('error', () => {
      if (entry.settled || entry.outcome !== null) return;
      this.#beginTermination(entry, 'crashed', {
        phase: entry.phase === 'await_hello' ? 'startup' : 'run',
        code: 'capability_pipe_error',
      });
    });
    // A broken refresh pipe is an authority loss: the child will not receive
    // its next token, so it must not keep running toward expiry.
    child.stdio[5]?.on('error', () => {
      if (entry.settled || entry.outcome !== null) return;
      this.#beginTermination(entry, 'capability_refresh_failed', {
        phase: entry.phase === 'await_hello' ? 'startup' : 'run',
        code: 'capability_refresh_pipe_error',
      });
    });

    child.on('exit', (code, signal) => {
      entry.exited = true;
      entry.exitCode = code;
      entry.signal = signal;
      // Stop the lease owner at the real child exit, not a tick later at close.
      this.#detachLease(entry);
    });
    child.on('close', (code, signal) => {
      if (!entry.exited) {
        entry.exited = true;
        entry.exitCode = code;
        entry.signal = signal;
      }
      this.#finalize(entry);
    });
  }

  #sendPayload(entry) {
    if (entry.phase !== 'running' || entry.settled) return;
    const stream = entry.child.stdio[3];
    const payload = entry.payloadBytes;
    entry.payloadBytes = null;
    if (!stream) {
      this.#beginTermination(entry, 'crashed', { phase: 'run', code: 'missing_payload_pipe' });
      return;
    }
    if (!this.#sendCapabilities(entry)) return;
    try {
      stream.end(payload, () => {
        if (entry.settled) return;
        this.#sendRun(entry);
      });
    } catch {
      this.#beginTermination(entry, 'crashed', { phase: 'run', code: 'payload_pipe_error' });
    }
  }

  // The capability bootstrap is written once to fd 4 and immediately closed.
  // It never touches argv, the environment, the payload pipe or disk.
  #sendCapabilities(entry) {
    const stream = entry.child.stdio[4];
    const capabilityBytes = entry.capabilityBytes;
    entry.capabilityBytes = null;
    if (!stream) {
      if (capabilityBytes === null) return true;
      this.#beginTermination(entry, 'crashed', { phase: 'run', code: 'missing_capability_pipe' });
      return false;
    }
    try {
      stream.end(capabilityBytes ?? undefined, () => {});
    } catch {
      this.#beginTermination(entry, 'crashed', { phase: 'run', code: 'capability_pipe_error' });
      return false;
    }
    return true;
  }

  // One renewal frame on the private fd 5 pipe. The lease session has already
  // checked the strictly increasing generation; this method only enforces the
  // process/pipe state and the size bound. It returns false when the frame was
  // not handed to a live pipe, which the session treats as a terminal failure.
  #writeCapabilityRefresh(entry, capabilities) {
    if (entry.phase !== 'running' || entry.settled) return false;
    const stream = entry.child.stdio?.[5];
    if (!stream || stream.destroyed === true || stream.writableEnded === true) return false;
    // One line per side: the child's refresher accepts a single-key frame.
    let lines;
    try {
      lines = Object.entries(capabilities ?? {}).map(([side, credential]) =>
        `${JSON.stringify({ [side]: credential })}\n`);
      const bytes = lines.reduce((total, line) => total + Buffer.byteLength(line, 'utf8'), 0);
      if (lines.length === 0 || bytes > MAX_CAPABILITY_BYTES) return false;
    } catch {
      return false;
    }
    for (const line of lines) {
      try {
        stream.write(line, (error) => {
          if (!error || entry.settled || entry.outcome !== null) return;
          this.#beginTermination(entry, 'capability_refresh_failed', {
            phase: 'run',
            code: 'capability_refresh_pipe_error',
          });
        });
      } catch {
        return false;
      }
    }
    return true;
  }

  #sendRun(entry) {
    if (entry.phase !== 'running' || entry.settled) return;
    entry.child.stdin.write(RUN_LINE, (error) => {
      if (error && !entry.settled) this.#violation(entry, 'write_failed');
    });
  }

  #onFrame(entry, frame) {
    if (entry.settled || entry.phase === 'terminating') return;

    if (entry.phase === 'await_hello') {
      if (frame.type !== 'hello') return this.#violation(entry, 'unexpected_frame');
      if (frame.runId !== entry.runId) return this.#violation(entry, 'run_mismatch');
      if (!sameNonce(entry.nonce, frame.nonce)) return this.#violation(entry, 'nonce_mismatch');

      entry.phase = 'running';
      clearTimeout(entry.timers.startup);
      entry.timers.startup = null;
      entry.timers.run = setTimeout(() => {
        entry.timers.run = null;
        this.#beginTermination(entry, 'timed_out', {
          phase: 'run',
          elapsedMs: this.#now() - entry.startedAt,
        });
      }, this.#runTimeoutMs);
      this.#sendPayload(entry);
      return;
    }

    if (frame.type !== 'result') return this.#violation(entry, 'unexpected_frame');
    if (entry.result !== null) return this.#violation(entry, 'duplicate_result');

    console.log(`work runtime result run=${String(entry.runId).slice(0, 8)} status=${frame.status} hasOutcome=${Object.hasOwn(frame, 'outcome')} state=${frame.outcome?.state ?? '-'}`);
    entry.result = frame.status;
    // The frame reader has already validated the optional outcome against the
    // signed result union; the supervisor only carries it to the transport.
    entry.resultOutcome = Object.hasOwn(frame, 'outcome') ? frame.outcome : null;
    entry.outcome = frame.status === 'completed' ? 'completed' : 'failed';
    entry.diagnostics = frame.status === 'failed'
      ? { phase: 'run', code: 'child_reported_failure' }
      : null;
    // No more work is possible after the result. Stop renewal/refresh first so
    // a late timer cannot overwrite the delivered result, then close the
    // refresh pipe so the child drains and exits.
    this.#detachLease(entry);
    this.#closeRefreshPipe(entry);
    clearTimeout(entry.timers.run);
    entry.timers.run = null;
    entry.timers.exitGrace = setTimeout(() => {
      entry.timers.exitGrace = null;
      if (entry.phase === 'terminating') return;
      this.#beginTermination(entry, entry.outcome, entry.diagnostics);
    }, this.#killGraceMs);
  }

  #violation(entry, code) {
    this.#beginTermination(entry, 'protocol_violation', {
      phase: entry.phase === 'await_hello' ? 'startup' : 'run',
      code,
    });
  }

  // A lease owner may only ask for the two authority settlements. The child is
  // stopped through the normal SIGTERM -> SIGKILL escalation and the Run
  // settles with that status once the process is gone.
  #terminateForLease(entry, status, code) {
    if (!LEASE_STATUSES.has(status) || entry.settled) return;
    if (entry.phase === 'terminating') return;
    this.#beginTermination(entry, status, {
      phase: entry.phase === 'await_hello' ? 'startup' : 'run',
      code: typeof code === 'string' && code.length > 0 ? code : status,
    });
  }

  #detachLease(entry) {
    const lease = entry.lease;
    if (lease === null) return;
    entry.lease = null;
    try {
      lease.detach();
    } catch {
      // A failing lease owner must not keep the supervisor from reaping.
    }
  }

  #beginTermination(entry, status, diagnostics, { force = false } = {}) {
    if (entry.settled) return;
    if (entry.phase === 'terminating') {
      if (force && !entry.exited) this.#signal(entry, 'SIGKILL');
      return;
    }
    entry.outcome = status;
    entry.diagnostics = diagnostics;
    entry.phase = 'terminating';
    // Once termination starts the child is going away: no renewal may outlive
    // it, and a late lease reply can no longer change the settlement.
    this.#detachLease(entry);
    clearTimeout(entry.timers.startup);
    clearTimeout(entry.timers.run);
    clearTimeout(entry.timers.exitGrace);
    entry.timers.startup = null;
    entry.timers.run = null;
    entry.timers.exitGrace = null;

    if (entry.exited) return;

    this.#signal(entry, force ? 'SIGKILL' : 'SIGTERM');
    if (!force) {
      entry.timers.force = setTimeout(() => {
        entry.timers.force = null;
        if (!entry.exited) this.#signal(entry, 'SIGKILL');
      }, this.#killGraceMs);
    }
  }

  #signal(entry, signal) {
    try {
      entry.child.kill(signal);
    } catch {
      // The exit/close path settles the Run.
    }
  }

  #closeRefreshPipe(entry) {
    const stream = entry.child?.stdio?.[5];
    if (!stream || stream.destroyed === true || stream.writableEnded === true) return;
    try {
      stream.end();
    } catch {
      // The child may already have closed its end of the pipe.
    }
  }

  #finalize(entry, forcedStatus, forcedDiagnostics) {
    if (entry.settled) return;
    entry.settled = true;
    this.#closeRefreshPipe(entry);
    this.#detachLease(entry);
    clearTimeout(entry.timers.startup);
    clearTimeout(entry.timers.run);
    clearTimeout(entry.timers.exitGrace);
    clearTimeout(entry.timers.force);
    entry.timers.startup = null;
    entry.timers.run = null;
    entry.timers.exitGrace = null;
    entry.timers.force = null;
    entry.payloadBytes = null;
    entry.capabilityBytes = null;

    let status = forcedStatus ?? entry.outcome;
    let diagnostics = forcedDiagnostics ?? entry.diagnostics;

    if (status === null || status === undefined) {
      if (entry.result !== null) {
        status = entry.result;
      } else if (entry.exitCode === 0 && entry.signal === null) {
        status = 'protocol_violation';
        diagnostics = { phase: entry.phase === 'await_hello' ? 'startup' : 'run', code: 'missing_result' };
      } else {
        status = 'crashed';
        diagnostics = {
          phase: entry.phase === 'await_hello' ? 'startup' : 'run',
          exitCode: entry.exitCode,
          signal: entry.signal,
        };
      }
    }

    if (this.#active.get(entry.runId) === entry) this.#active.delete(entry.runId);
    this.#notifyIdle();

    // Only a run that settled on the child's own result may carry that
    // outcome. A violation, timeout, crash or forced kill withdraws it: the
    // transport must fall back to its conservative mapping instead of
    // publishing a result the child did not deliver.
    const carriesOutcome = entry.resultOutcome !== null &&
      forcedStatus === undefined &&
      (status === 'completed' || status === 'failed');

    console.log(`work runtime child settled run=${String(entry.runId).slice(0, 8)} status=${status} exit=${entry.exitCode ?? '-'}`);
    entry.resolve({
      status,
      exitCode: entry.exitCode,
      ...(diagnostics === null || diagnostics === undefined ? {} : { diagnostics }),
      ...(carriesOutcome ? { outcome: entry.resultOutcome } : {}),
    });
  }

  #waitForIdle() {
    if (this.#active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  #notifyIdle() {
    if (this.#active.size !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  #rejected(reason, code) {
    return Promise.resolve({
      status: 'rejected',
      exitCode: null,
      diagnostics: code === undefined ? { reason } : { reason, code },
    });
  }
}
