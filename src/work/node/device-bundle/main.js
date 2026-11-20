// The device Node executor entrypoint (execution-face design §6.2/§6.3, E2 甲). It runs the
// pi-agent-core multi-turn loop with FOUR injected seams, all routed through the Broker pipe:
//   - StreamFn (model boundary): no pi-ai provider transport is constructed; the transcript becomes a
//     local_model_request v1 (§5.1) handed to the Broker, which proxies the device_local endpoint and
//     returns a one-time JSON assistant message (§5.2). Failures are encoded in the stream, never thrown.
//   - AgentTool.execute (tool boundary): the four tools open NO path; they hand name+validated args to
//     the Broker, which does handle-relative execution + sealed-buffer verification (DD:190-197).
//   - the permit/approval gate (DD:123/43): the Broker answers each tool_call with tool_permit_gate
//     before any execution; pending approval terminates the whole remaining batch.
//   - finishTurn (candidate end): the loop ending is only a CANDIDATE (DD:137); the Broker stops the
//     sidecar and judges outcome solely from journal/receipt/sealed artifacts. Node's self-reported
//     completion never enters an uplink frame.
//
// Node is untrusted (DD:17/20): no root handle, journal, CNG key, provider key or network capability.
// The AppContainer + Job Object + --permission model carry the boundary; this pipe is the only channel.
// The SDK does NOT auto-call the model (DD:113): it waits for run_bootstrap before starting the loop.

import net from 'node:net';

import { Agent } from '@earendil-works/pi-agent-core';

import toolSchemas from './tool-schemas.json' with { type: 'json' };

import {
  FrameReader,
  ProtocolError,
  encodeFrame,
  frame,
  loopEnd,
  modelRequest,
  toolCall,
  validateBody,
} from './protocol.mjs';

// The model descriptor is local and inert: the only stream function is the Broker pipe adapter, so
// pi-ai never sees a provider, base URL or API key (child-pi.mjs GATEWAY_MODEL precedent).
const DEVICE_LOCAL_MODEL = Object.freeze({
  id: 'work-device-local',
  name: 'work device local',
  api: 'work-device-local',
  provider: 'device-local',
  baseUrl: '',
  reasoning: false,
  input: [],
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
  contextWindow: 0,
  maxTokens: 0,
});

const ZERO_USAGE = Object.freeze({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A minimal AssistantMessageEventStream with the surface the Pi loop consumes: async iteration plus
// result() (child-pi.mjs createTurnStream precedent). Local so no pi-ai provider transport is imported.
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
      if (queue.length > 0) waiter({ value: queue.shift(), done: false });
      else waiter({ value: undefined, done: true });
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
      closed = true;
      flush();
    },
    result() {
      return resultPromise;
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

function assistantMessage({ stopReason, content = [], toolCalls = [], usage = ZERO_USAGE, errorMessage }) {
  const blocks = [...content];
  for (const call of toolCalls) {
    blocks.push({ type: 'toolCall', id: call.id, name: call.name, arguments: call.arguments ?? {} });
  }
  return {
    role: 'assistant',
    content: blocks,
    stopReason,
    usage,
    timestamp: Date.now(),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

// The pipe RPC: one outstanding request at a time (the loop is sequential). Sends a request frame and
// reads frames until one of the expected response types arrives; an unexpected type fails closed.
class BrokerLink {
  constructor(socket) {
    this.socket = socket;
    this.reader = new FrameReader();
    this.pending = [];
    this.waiters = [];
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = this.reader.push(chunk);
      } catch (err) {
        this.fail(err);
        return;
      }
      for (const f of frames) this.deliver(f);
    });
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new ProtocolError('pipe_closed')));
  }

  deliver(f) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(f);
    else this.pending.push(f);
  }

  fail(err) {
    while (this.waiters.length) this.waiters.shift().reject(err);
    this.error = err;
  }

  nextFrame() {
    if (this.pending.length) return Promise.resolve(this.pending.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  send(value) {
    this.socket.write(encodeFrame(value));
  }

  // Send a request and await the first response whose type is in `expect`.
  async request(value, expect) {
    this.send(value);
    for (;;) {
      const f = await this.nextFrame();
      // A proceed gate is intermediate, not the tool result. A blocked gate pauses the batch.
      if (value.type === 'tool_call' && f.type === 'tool_permit_gate') {
        const gate = validateBody(f.type, f.body);
        if (gate.tool_call_id !== value.body.tool_call_id) throw new ProtocolError('unexpected_response');
        if (gate.decision === 'proceed' && gate.terminate === false) continue;
        if (gate.decision !== 'blocked' || gate.terminate !== true) throw new ProtocolError('unexpected_response');
        return frame('tool_blocked', {
          tool_call_id: gate.tool_call_id, reason: gate.reason, terminate: true, is_error: true,
        });
      }
      if (expect.includes(f.type)) {
        validateBody(f.type, f.body);
        return f;
      }
      // A model_blocked / tool_blocked can arrive in place of the normal response.
      if (f.type === 'model_blocked' || f.type === 'tool_blocked') {
        validateBody(f.type, f.body);
        return f;
      }
      throw new ProtocolError('unexpected_response');
    }
  }
}

// Connect to the Broker's per-Run named pipe, run the one-time Node handshake, read run_bootstrap.
// The Broker creates the pipe while the sidecar is suspended, so it exists before this first connect.
async function connectAndBootstrap(pipeName) {
  const socket = net.connect({ path: pipeName });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const link = new BrokerLink(socket);
  // The Broker writes a bare server_hello {nonce, protocol_major}; echo a bare client hello declaring
  // client_kind=node (the handshake frames are NOT {type, body} envelopes — ipc/handshake.rs).
  const hello = await link.nextFrame();
  link.send({
    nonce: hello.nonce,
    protocol_major: hello.protocol_major,
    client_kind: 'node',
  });
  const bootstrapFrame = await link.nextFrame();
  if (bootstrapFrame.type !== 'run_bootstrap') throw new ProtocolError('bootstrap_expected');
  const bootstrap = validateBody('run_bootstrap', bootstrapFrame.body);
  return { link, bootstrap };
}

// Build the local_model_request v1 canonical doc (§5.1) from the transcript context + bootstrap route.
// The Broker canonicalizes (JCS) and hashes it; Node never names an endpoint. logical_key is assigned
// by the Broker's turn counter — Node supplies a placeholder the Broker overrides (DD:147).
function buildModelRequest(context, bootstrap, turnNo) {
  const messages = (context.messages ?? []).map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
  }));
  return {
    v: 1,
    binding: {
      org: bootstrap.run_id,
      run: bootstrap.run_id,
      logical_key: `model:${turnNo}`,
      checkpoint_seq: '0',
    },
    route: {
      provider: bootstrap.model_route.provider,
      model: bootstrap.model_route.model,
      config_revision: bootstrap.model_route.config_revision,
      compat_profile_version: bootstrap.compat_profile_version,
    },
    parameters: {},
    template: { id: 'device-default', version: '1', hash: bootstrap.tool_manifest_hash },
    source_manifest_hash: bootstrap.tool_manifest_hash,
    messages,
    tools: [],
  };
}

// The four tools. execute() opens NO path: it hands name+args to the Broker and adapts the reply into
// an AgentToolResult. replay:'never' (tool side effects are not replayable; unknown goes to reconcile).
function makeTools(link, counters) {
  const specs = [
    { name: 'workspace.list', label: 'List workspace', description: 'List workspace entries (handle-relative).' },
    { name: 'workspace.read', label: 'Read workspace', description: 'Read a workspace document (handle-relative).' },
    { name: 'workspace.search', label: 'Search workspace', description: 'Search workspace content (handle-relative).' },
    { name: 'artifact.write', label: 'Write artifact', description: 'Write a sealed artifact version (handle-relative).' },
  ];
  return specs.map((spec) => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    // The sealed tool schema (tool-schemas.json, the tool_manifest_hash preimage) is the argument
    // contract pi-ai validates each tool_call against before execute; a dummy empty schema would
    // reject every argument set and the tool would never reach the Broker.
    parameters: toolSchemas[spec.name],
    replay: 'never',
    async execute(toolCallId, params) {
      const logicalKey = `tool:${counters.turn}:${counters.call++}`;
      let reply;
      try {
        reply = await link.request(toolCall(toolCallId, spec.name, params ?? {}, logicalKey), [
          'tool_result', 'tool_unknown',
        ]);
      } catch {
        // The SDK turns thrown execute errors into non-terminating results. An uncertain RPC must
        // instead stop the whole batch, never retry or continue with another tool/model request.
        reply = { type: 'tool_unknown', body: { reason: 'client_error' } };
      }
      if (reply.type === 'tool_blocked') {
        return {
          content: [{ type: 'text', text: `blocked:${reply.body.reason}` }],
          details: { reason: reply.body.reason },
          isError: true,
          terminate: reply.body.terminate === true,
        };
      }
      if (reply.type === 'tool_unknown') {
        return {
          content: [{ type: 'text', text: `unknown:${reply.body.reason}` }],
          details: { reason: reply.body.reason },
          isError: true,
          terminate: true,
        };
      }
      const b = reply.body;
      return {
        content: Array.isArray(b.content) ? b.content
          : [{ type: 'text', text: JSON.stringify(b.content) }],
        structuredContent: b.structured_content,
        details: b.details,
        isError: b.is_error === true,
        terminate: b.terminate === true,
      };
    },
  }));
}

// The compat profile convertToLlm: preserve tool_calls (the cloud adapter drops them, DD:250 gap).
// pi-ai Message carries toolCall blocks; we pass content through verbatim so the model sees its calls.
function convertToLlm(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }],
  }));
}

async function main() {
  const pipeName = process.argv[2];
  if (typeof pipeName !== 'string' || !pipeName.startsWith('\\\\.\\pipe\\')) {
    throw new ProtocolError('pipe_name_required');
  }
  const { link, bootstrap } = await connectAndBootstrap(pipeName);
  // Bootstrap u64 values cross the protocol as decimal strings, not lossy JS numbers. No fallback
  // or local token policy: enforce only the Broker-supplied turn bound, failing closed if invalid.
  if (typeof bootstrap.max_turns !== 'string' || !/^[0-9]+$/.test(bootstrap.max_turns)
    || BigInt(bootstrap.max_turns) > 18446744073709551615n) {
    link.socket.destroy();
    throw new ProtocolError('invalid_max_turns');
  }
  const maxTurns = BigInt(bootstrap.max_turns);
  const counters = { turn: 0n, call: 0 };
  const tools = makeTools(link, counters);

  // StreamFn: one model turn via the Broker pipe. Never throws; failures encode stopReason='error'.
  const streamFn = () => {
    const stream = createTurnStream();
    const turnNo = counters.turn++;
    void (async () => {
      let reply;
      try {
        const context = { messages: agent.state.messages.slice() };
        reply = await link.request(modelRequest(buildModelRequest(context, bootstrap, turnNo), `model:${turnNo}`), [
          'model_response', 'model_unknown',
        ]);
      } catch {
        reply = { type: 'model_unknown', body: { outcome: 'unknown', reason: 'client_error' } };
      }
      if (reply.type === 'model_blocked') {
        const message = assistantMessage({ stopReason: 'error', errorMessage: `blocked:${reply.body.reason}` });
        stream.push({ type: 'start', partial: { ...message } });
        stream.push({ type: 'error', reason: 'error', error: message });
        stream.end(message);
        return;
      }
      if (reply.type === 'model_unknown' || reply.body.outcome === 'unknown') {
        const message = assistantMessage({ stopReason: 'error', errorMessage: `unknown:${reply.body.reason ?? 'unknown'}` });
        stream.push({ type: 'start', partial: { ...message } });
        stream.push({ type: 'error', reason: 'error', error: message });
        stream.end(message);
        return;
      }
      const am = isRecord(reply.body.assistant_message) ? reply.body.assistant_message : {};
      // The device_local proxy passes the Chat Completions message verbatim (§5.2), so tool_calls carry
      // the OpenAI {id, function:{name, arguments(JSON string)}} shape. pi-agent-core's AgentToolCall
      // block is flat {id, name, arguments(object)} — normalize here (the compat tool_calls seam, §6.2).
      const toolCalls = (Array.isArray(am.tool_calls) ? am.tool_calls : []).map((c) => {
        const fn = isRecord(c.function) ? c.function : {};
        const rawArgs = fn.arguments ?? c.arguments;
        let args = {};
        if (typeof rawArgs === 'string') {
          try { args = JSON.parse(rawArgs); } catch { args = {}; }
        } else if (isRecord(rawArgs)) {
          args = rawArgs;
        }
        return { id: c.id, name: fn.name ?? c.name, arguments: args };
      });
      const message = assistantMessage({
        // The loop executes tools only when the turn ends in toolUse (pi-ai StopReason).
        stopReason: toolCalls.length > 0 ? 'toolUse' : 'stop',
        content: typeof am.content === 'string' ? [{ type: 'text', text: am.content }]
          : Array.isArray(am.content) ? am.content : [],
        toolCalls,
        usage: isRecord(reply.body.usage) ? reply.body.usage : ZERO_USAGE,
      });
      stream.push({ type: 'start', partial: { ...message } });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end(message);
    })();
    return stream;
  };

  const agent = new Agent({
    initialState: {
      model: DEVICE_LOCAL_MODEL,
      tools,
      messages: [],
      thinkingLevel: 'off',
    },
    streamFn,
    convertToLlm,
    toolExecution: 'sequential',
    // Leave successful tool turns to the SDK's natural loop; no-tool turns stop naturally. Explicit
    // end is only for a terminated batch or the sealed turn bound, and remains a candidate (DD:137).
    finishTurn: () => terminate || counters.turn >= maxTurns ? { action: 'end' } : undefined,
  });

  // The bootstrap carries sealed input refs; the initial prompt is the Broker-sealed input the Node
  // reads only through the pipe (DD:194). For the fixture loop the first user turn is empty content
  // the Broker fills; successful tools naturally feed the next model turn.
  let terminate = false;
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'tool_execution_end' && event.result?.terminate === true) {
      terminate = true;
      // Vendored sequential execution checks abort after emitting the tool result, before the next
      // call. Its batch terminate uses every(), so finishTurn must also stop mixed success/terminate.
      agent.abort();
    }
  });
  try {
    if (maxTurns > 0n) {
      await agent.prompt([{ role: 'user', content: [{ type: 'text', text: 'begin' }] }]);
      await agent.waitForIdle();
    }
  } finally {
    unsubscribe();
  }
  // loop_end is a candidate; the transcript final state never enters an uplink frame (DD:137).
  link.send(loopEnd({ messages: agent.state.messages.slice() }, counters.turn));
  link.socket.end();
}

main().catch((err) => {
  process.stderr.write(`work-device-bundle: ${err?.code ?? err?.message ?? 'failed'}\n`);
  process.exitCode = 1;
});