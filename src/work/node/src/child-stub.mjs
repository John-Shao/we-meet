// Test/local-wiring child for the Work runtime supervisor. The real Pi agent
// loop is out of scope; this process only exercises the signed IPC handshake,
// bounded control framing, off-protocol payload intake, hangs, crashes, and
// deliberate violations.

import { createReadStream, writeFileSync } from 'node:fs';
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  createFrameReader,
  writeFrame,
} from './protocol.mjs';

const runId = process.env.WORK_RUN_ID ?? '';
const nonce = process.env.WORK_RUN_NONCE ?? '';
const behavior = process.env.WORK_STUB_BEHAVIOR ?? 'ok';
const violation = process.env.WORK_STUB_VIOLATION ?? 'nonce';
const skipHello = process.env.WORK_STUB_SKIP_HELLO === '1';
const ignoreSigterm = process.env.WORK_STUB_IGNORE_SIGTERM === '1';
const delayMs = Math.max(0, Number(process.env.WORK_STUB_DELAY_MS ?? 0) || 0);

if (process.env.WORK_STUB_PID_FILE) {
  try {
    writeFileSync(process.env.WORK_STUB_PID_FILE, String(process.pid));
  } catch {
    // The pid file is only a test affordance.
  }
}

if (ignoreSigterm) process.on('SIGTERM', () => {});

let finishing = false;
let payloadDone = false;
let runReceived = false;
let started = false;
const payloadChunks = [];

function halt() {
  setInterval(() => {}, 1000);
}
function exitAfterFlush(code) {
  if (finishing) return;
  finishing = true;
  process.stdout.write('', () => process.exit(code));
}
function send(frame, done) {
  writeFrame(process.stdout, frame, done);
}
function sendRaw(text, done) {
  process.stdout.write(`${text}\n`, done);
}
function failClosed(code) {
  exitAfterFlush(code);
}

function maybeStart() {
  if (started || !payloadDone || !runReceived) return;
  started = true;
  runBehavior();
}

function sendBadHello() {
  const hello = { v: PROTOCOL_VERSION, type: 'hello', runId, nonce };
  if (violation === 'malformed') {
    sendRaw('{"v":1,"type":"hello"', halt);
  } else if (violation === 'version') {
    sendRaw(JSON.stringify({ ...hello, v: PROTOCOL_VERSION + 1 }), halt);
  } else if (violation === 'unknown_type') {
    sendRaw(JSON.stringify({ v: PROTOCOL_VERSION, type: 'bogus', runId, nonce }), halt);
  } else if (violation === 'extra_field') {
    sendRaw(JSON.stringify({ ...hello, body: 'not allowed' }), halt);
  } else {
    sendRaw(JSON.stringify({ ...hello, nonce: 'f'.repeat(nonce.length || 32) }), halt);
  }
}

function runBehavior() {
  if (behavior === 'ok') {
    setTimeout(() => {
      send({ v: PROTOCOL_VERSION, type: 'result', status: 'completed' }, () => exitAfterFlush(0));
    }, delayMs);
    return;
  }
  if (behavior === 'error') {
    setTimeout(() => {
      send({ v: PROTOCOL_VERSION, type: 'result', status: 'failed' }, () => exitAfterFlush(1));
    }, delayMs);
    return;
  }
  if (behavior === 'outcome') {
    // Test affordance: deliver a pre-built result frame (status + optional
    // outcome). The frame still passes through the real protocol validator.
    let frame;
    try {
      frame = JSON.parse(process.env.WORK_STUB_RESULT_FRAME ?? '');
    } catch {
      exitAfterFlush(8);
      return;
    }
    setTimeout(() => {
      // Raw write: the point is to exercise the parent's validator, so a
      // deliberately malformed frame must reach the wire.
      sendRaw(JSON.stringify(frame), () =>
        exitAfterFlush(frame.status === 'completed' ? 0 : 1));
    }, delayMs);
    return;
  }
  if (behavior === 'crash') {
    setTimeout(() => process.exit(3), delayMs);
    return;
  }
  if (behavior === 'oversized') {
    const padded = JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'result',
      status: 'completed',
      pad: 'x'.repeat(MAX_FRAME_BYTES),
    });
    sendRaw(padded, halt);
    return;
  }
  if (behavior === 'protocol_violation') {
    sendRaw(JSON.stringify({ v: PROTOCOL_VERSION, type: 'bogus', status: 'completed' }), halt);
    return;
  }
  if (behavior !== 'hang') process.exit(6);
  halt();
}

const reader = createFrameReader({
  onFrame(frame) {
    if (frame.type !== 'run') return failClosed(5);
    runReceived = true;
    maybeStart();
  },
  onError() {
    failClosed(4);
  },
});

const payload = createReadStream(null, { fd: 3, autoClose: false });
payload.on('data', (chunk) => payloadChunks.push(chunk));
payload.on('error', () => failClosed(7));
payload.on('end', () => {
  const bytes = Buffer.concat(payloadChunks);
  if (process.env.WORK_STUB_PAYLOAD_FILE) {
    try {
      writeFileSync(process.env.WORK_STUB_PAYLOAD_FILE, bytes);
    } catch {
      // The payload file is only a test affordance.
    }
  }
  payloadDone = true;
  maybeStart();
});

process.stdin.on('data', (chunk) => reader.push(chunk));
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

if (skipHello) {
  halt();
} else if (behavior === 'protocol_violation') {
  sendBadHello();
} else {
  send({ v: PROTOCOL_VERSION, type: 'hello', runId, nonce }, () => {
    if (behavior === 'hang') halt();
  });
}
