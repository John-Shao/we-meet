// The Node side of the Node↔Broker closed message set (execution-face design §6.3). This mirrors the
// Rust contract in src/device/src/ipc/nodemsg.rs byte-for-byte: every body is a CLOSED key set, u64
// members cross as decimal strings, and the frame envelope is {type, body}. Node is untrusted — it
// names a tool from the four-tool closed set and supplies validated args, but never sees an endpoint
// URL, a filesystem path, a provider key or a capability; the Broker does every handle-relative
// execution and permit gate. The pipe is the only channel back to the Broker (DD:20).

import { readFileSync, writeFileSync } from 'node:fs';

export const MAX_FRAME_BYTES = 64 * 1024;
export const LENGTH_PREFIX = 4;

export const TOOL_NAMES = Object.freeze([
  'workspace.list',
  'workspace.read',
  'workspace.search',
  'artifact.write',
]);

// Closed top-level key sets per frame type (run_bootstrap is validated against its own set).
const CLOSED_KEYS = Object.freeze({
  run_bootstrap: [
    'run_id', 'binding_revision', 'start_nonce', 'profile_id', 'compat_profile_version',
    'tool_manifest_hash', 'runtime_digest', 'model_route', 'sealed_input_refs',
    'max_turns', 'max_tokens', 'max_bytes', 'deadline',
  ],
  capability_refresh: ['credential', 'generation'],
  model_request: ['request', 'logical_key'],
  model_response: ['outcome', 'assistant_message', 'answer_hash', 'answer_bytes', 'usage', 'provider_request_id'],
  model_blocked: ['reason', 'terminate'],
  model_unknown: ['outcome', 'reason'],
  tool_call: ['tool_call_id', 'tool_name', 'args', 'logical_key'],
  tool_permit_gate: ['tool_call_id', 'decision', 'reason', 'terminate'],
  tool_result: ['tool_call_id', 'content', 'structured_content', 'details', 'is_error', 'terminate'],
  tool_blocked: ['tool_call_id', 'reason', 'terminate', 'is_error'],
  tool_unknown: ['tool_call_id', 'reason'],
  loop_end: ['transcript_final', 'turn_count'],
});

export class ProtocolError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Validate a body against its closed key set. An extra or missing key is refused, never guessed.
export function validateBody(type, body) {
  const keys = CLOSED_KEYS[type];
  if (!keys) throw new ProtocolError('unknown_type');
  if (!isRecord(body)) throw new ProtocolError('not_object');
  for (const key of keys) {
    if (!Object.hasOwn(body, key)) throw new ProtocolError('missing_key');
  }
  for (const key of Object.keys(body)) {
    if (!keys.includes(key)) throw new ProtocolError('extra_key');
  }
  if (type === 'tool_call' && !TOOL_NAMES.includes(body.tool_name)) {
    throw new ProtocolError('unknown_tool');
  }
  if (type === 'loop_end') {
    if (!isRecord(body.transcript_final) || !Array.isArray(body.transcript_final.messages)
      || typeof body.turn_count !== 'string' || !/^[0-9]+$/.test(body.turn_count)
      || !body.transcript_final.messages.every((message) => isRecord(message) && typeof message.role === 'string')) {
      throw new ProtocolError('bad_enum');
    }
  }
  return body;
}

export function frame(type, body) {
  return { type, body };
}

// Node→Broker builders (the only messages Node originates).
export function modelRequest(request, logicalKey) {
  return frame('model_request', { request, logical_key: logicalKey });
}

export function toolCall(toolCallId, toolName, args, logicalKey) {
  if (!TOOL_NAMES.includes(toolName)) throw new ProtocolError('unknown_tool');
  return frame('tool_call', {
    tool_call_id: toolCallId,
    tool_name: toolName,
    args,
    logical_key: logicalKey,
  });
}

export function loopEnd(transcriptFinal, turnCount) {
  return frame('loop_end', {
    transcript_final: transcriptFinal,
    turn_count: String(turnCount),
  });
}

// 4-byte big-endian length prefix + ≤64KiB payload (ipc/frame.rs same discipline).
export function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) throw new ProtocolError('frame_too_large');
  const out = Buffer.alloc(LENGTH_PREFIX + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, LENGTH_PREFIX);
  return out;
}

// A streaming frame reader over a duplex socket (the Windows named pipe). Buffers partial reads and
// yields one complete frame at a time; a malformed prefix or oversize frame fails closed.
export class FrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= LENGTH_PREFIX) {
      const len = this.buffer.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) throw new ProtocolError('frame_too_large');
      if (this.buffer.length < LENGTH_PREFIX + len) break;
      const payload = this.buffer.subarray(LENGTH_PREFIX, LENGTH_PREFIX + len);
      this.buffer = this.buffer.subarray(LENGTH_PREFIX + len);
      let value;
      try {
        value = JSON.parse(payload.toString('utf8'));
      } catch {
        throw new ProtocolError('not_json');
      }
      // The handshake frames (server_hello/client_hello) are bare objects; the message frames are
      // {type, body} envelopes. The reader only requires a JSON object; the envelope is validated at
      // the message layer (BrokerLink.request / bootstrap), so both shapes pass through here.
      if (!isRecord(value)) {
        throw new ProtocolError('bad_envelope');
      }
      frames.push(value);
    }
    return frames;
  }
}

// Read the one-time bootstrap from a private fd (the spawn passes the bootstrap pipe fd, capability
// never via argv/env/disk/log — child-pi.mjs fd4 precedent). Returns the validated run_bootstrap body.
export function readBootstrapFd(fd) {
  const raw = readFileSync(fd);
  const reader = new FrameReader();
  const frames = reader.push(raw);
  if (frames.length !== 1 || frames[0].type !== 'run_bootstrap') {
    throw new ProtocolError('bootstrap_expected');
  }
  return validateBody('run_bootstrap', frames[0].body);
}

export function writeFrameFd(fd, value) {
  writeFileSync(fd, encodeFrame(value));
}