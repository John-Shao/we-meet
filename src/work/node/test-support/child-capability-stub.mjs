// Test-only child that speaks the supervisor handshake and records the private
// fd-4 capability bootstrap, the fd-5 refresh frames, and its own
// argv/environment. It exists to prove the parent delivers tokens only over the
// private pipes and never over control frames or the environment.
//
// WORK_STUB_CAP_HANG=1 keeps the child alive after the handshake (no result
// frame) so lease renewal and capability-refresh tests can observe a running
// child; WORK_STUB_IGNORE_SIGTERM=1 exercises the SIGTERM -> SIGKILL path.

import { createReadStream, writeFileSync } from 'node:fs';
import { PROTOCOL_VERSION, createFrameReader, writeFrame } from '../src/protocol.mjs';

const runId = process.env.WORK_RUN_ID ?? '';
const nonce = process.env.WORK_RUN_NONCE ?? '';
const recordFile = process.env.WORK_STUB_CAP_FILE;
const hang = process.env.WORK_STUB_CAP_HANG === '1';

if (process.env.WORK_STUB_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {});

const frames = [];
const refreshFrames = [];
const state = { bootstrap: null, payload: null, run: false, written: false };
let finished = false;
let hanging = false;

function finish() {
  if (finished) return;
  finished = true;
  if (hang) {
    // Stay alive without a result; the supervisor must stop this child when
    // the lease is gone or a capability refresh cannot be delivered.
    hanging = true;
    setInterval(() => {}, 1000);
    return;
  }
  writeFrame(process.stdout, { v: PROTOCOL_VERSION, type: 'result', status: 'completed' }, () => {
    process.exit(0);
  });
}

// Rewrites on every refresh so a hang test can observe increasing generations.
function writeRecord() {
  if (!runId || state.bootstrap === null || state.payload === null || !state.run) {
    return;
  }
  state.written = true;
  const record = {
    pid: process.pid,
    bootstrapRaw: state.bootstrap,
    payloadRaw: state.payload,
    frames,
    refreshFrames,
    argv: process.argv,
    env: process.env,
  };
  if (recordFile !== undefined) {
    try {
      writeFileSync(recordFile, JSON.stringify(record));
    } catch {
      // A failed record write only fails the test that asked for it.
    }
  }
  if (!hanging) finish();
}

const hello = { v: PROTOCOL_VERSION, type: 'hello', runId, nonce };
frames.push(hello);
writeFrame(process.stdout, hello);

const bootstrapChunks = [];
const bootstrap = createReadStream(null, { fd: 4, autoClose: false });
bootstrap.on('data', (chunk) => bootstrapChunks.push(chunk));
bootstrap.on('error', () => process.exit(7));
bootstrap.on('end', () => {
  state.bootstrap = Buffer.concat(bootstrapChunks).toString('utf8');
  writeRecord();
});

// The fd-5 refresh pipe stays open for the Run. Record each raw line so tests
// can assert the nested shape and strictly increasing generations.
const MAX_REFRESH_LINE = 8 * 1024;
let refreshBuffer = '';
let refreshDiscarding = false;
const refresh = createReadStream(null, { fd: 5, autoClose: false });
refresh.on('data', (chunk) => {
  let text = chunk.toString('utf8');
  for (;;) {
    const newline = text.indexOf('\n');
    const piece = newline === -1 ? text : text.slice(0, newline);
    if (!refreshDiscarding) {
      if (refreshBuffer.length + piece.length > MAX_REFRESH_LINE) {
        refreshBuffer = '';
        refreshDiscarding = true;
      } else {
        refreshBuffer += piece;
      }
    }
    if (newline === -1) return;
    if (!refreshDiscarding && refreshBuffer.length > 0) {
      refreshFrames.push(refreshBuffer);
      refreshBuffer = '';
      writeRecord();
    }
    refreshBuffer = '';
    refreshDiscarding = false;
    text = text.slice(newline + 1);
  }
});
refresh.on('error', () => {});
refresh.on('end', () => {});

const payloadChunks = [];
const payload = createReadStream(null, { fd: 3, autoClose: false });
payload.on('data', (chunk) => payloadChunks.push(chunk));
payload.on('error', () => process.exit(8));
payload.on('end', () => {
  state.payload = Buffer.concat(payloadChunks).toString('utf8');
  writeRecord();
});

const reader = createFrameReader({
  onFrame(frame) {
    // Record every inbound control frame so tests can prove no token travels
    // over the frame protocol (the run frame carries no fields).
    frames.push(frame);
    if (frame.type !== 'run') process.exit(5);
    state.run = true;
    writeRecord();
  },
  onError() {
    process.exit(4);
  },
});

process.stdin.on('data', (chunk) => reader.push(chunk));
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
