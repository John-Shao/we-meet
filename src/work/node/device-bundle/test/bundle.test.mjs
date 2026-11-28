// Integration regression for execution-face §6.2/§6.3: the vendored SDK and a real Windows named
// pipe, with mock Broker replies. This is NOT a production Broker / AppContainer E2E proof.
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

import { FrameReader, encodeFrame, validateBody } from '../protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainJs = path.join(here, '..', 'main.js');
const pipeTest = { skip: process.platform !== 'win32', timeout: 25000 };
const writeArgs = {
  grant_id: 'g1', artifact_id: 'a', version_id: 'v1', format: 'md', body_ref: 'buf-1',
  content_hash: `sha256:${'a'.repeat(64)}`, byte_count: '10',
};
const readArgs = { grant_id: 'g1', entry_ref: 'entry-1', expected_identity: 'identity-1', max_bytes: '1024' };
const listArgs = { grant_id: 'g1', relative_dir: '', limit: '10' };
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const readCall = call('tc-read', 'workspace.read', readArgs);
const listCall = call('tc-list', 'workspace.list', listArgs);
const writeCall = call('tc-write', 'artifact.write', writeArgs);

function bootstrapBody() {
  return {
    run_id: 'run-1', binding_revision: '1', start_nonce: 'nonce-1', profile_id: 'profile-dev-fixture-v1',
    compat_profile_version: '1', tool_manifest_hash: 'tmh', runtime_digest: 'rd',
    model_route: { provider: 'device-local', model: 'fixture-model', config_revision: '1' },
    sealed_input_b64: null, max_turns: '8', max_tokens: '4096', max_bytes: '262144',
    deadline: '2026-11-19T01:00:00Z',
  };
}

const probeTemplateId = 'device-model-probe-v1';
const probeTemplateHash = createHash('sha256').update(probeTemplateId, 'utf8').digest('hex');
const probeBootstrap = {
  binding_id: 'binding-1', probe_id: 'probe-1', preview_hash: 'c'.repeat(64),
  template_hash: probeTemplateHash,
};

function modelReply(content, tool_calls = []) {
  return { type: 'model_response', body: {
    outcome: 'success', assistant_message: { content, tool_calls }, answer_hash: 'sha256:aa',
    answer_bytes: '10', usage: { input: 1, output: 1 }, provider_request_id: 'req-1',
  } };
}

function toolResult(f, terminate = false) {
  return { type: 'tool_result', body: {
    tool_call_id: f.body.tool_call_id,
    content: [{ type: 'text', text: `result:${f.body.tool_name}` }],
    structured_content: { ok: true }, details: {}, is_error: false, terminate,
  } };
}

function permitGate(f, decision = 'proceed') {
  return { type: 'tool_permit_gate', body: {
    tool_call_id: f.body.tool_call_id, decision,
    reason: decision === 'proceed' ? null : 'pending_approval', terminate: decision !== 'proceed',
  } };
}

// Collect until socket close, not merely loop_end: extra model/tool frames must remain observable.
async function runOnce({ bootstrap = {}, model = () => modelReply('done'), tool = (f) => [toolResult(f)] } = {}) {
  const pipeName = `\\\\.\\pipe\\work-device-bundle-test-${process.pid}-${randomUUID()}`;
  const server = net.createServer();
  let socket;
  let child;
  let timer;
  const received = [];
  const trace = [];
  let modelTurn = 0;
  let toolIndex = 0;
  const brokerDone = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('broker timeout')), 20000);
    server.on('error', reject);
    server.on('connection', (connected) => {
      socket = connected;
      const reader = new FrameReader();
      let hello = true;
      const send = (value) => {
        trace.push(value.type ?? 'server_hello');
        socket.write(encodeFrame(value));
      };
      socket.on('error', reject);
      socket.on('close', resolve);
      socket.on('data', (chunk) => {
        try {
          for (const f of reader.push(chunk)) {
            if (hello) {
              assert.equal(f.client_kind, 'node');
              assert.equal(f.protocol_major, 1);
              assert.equal(f.nonce, 'n-1');
              send({ type: 'run_bootstrap', body: { ...bootstrapBody(), ...bootstrap } });
              hello = false;
              continue;
            }
            received.push(f);
            trace.push(f.type === 'tool_call' ? f.body.tool_name : f.type);
            validateBody(f.type, f.body);
            if (f.type === 'model_request') send(model(modelTurn++, f));
            else if (f.type === 'tool_call') {
              for (const reply of tool(f, toolIndex++)) send(reply);
            } else assert.equal(f.type, 'loop_end');
          }
        } catch (err) { reject(err); }
      });
      send({ nonce: 'n-1', protocol_major: 1 });
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipeName, resolve);
    });
    child = spawn(process.execPath, [mainJs, pipeName], {
      cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const childExit = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    const [, exit] = await Promise.all([brokerDone, childExit]);
    return { received, trace, stderr, ...exit };
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) child.kill();
    socket?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

function assertLoop(result, expected, turns) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.received.map((f) => f.type === 'tool_call' ? f.body.tool_name : f.type), expected);
  const models = result.received.filter((f) => f.type === 'model_request');
  assert.equal(models.length, turns, 'exact model request count (no retry)');
  assert.deepEqual(models.map((f) => f.body.logical_key), Array.from({ length: turns }, (_, n) => `model:${n}`));
  assert.equal(result.received.at(-1).body.turn_count, String(turns));
}

const finalMessages = (result) => result.received.at(-1).body.transcript_final.messages;

test('probe template hash is bare SHA-256 hex of the literal UTF-8 template ID', () => {
  assert.equal(probeTemplateHash, 'a3995f6cf85cd80e9649ab0ef3eb8082dc99936e64c9c895f2b722b48b94fab2');
});

test('run_bootstrap accepts omitted, null, and exact object-shaped probe metadata', () => {
  const ordinary = bootstrapBody();
  assert.equal(validateBody('run_bootstrap', ordinary), ordinary);
  assert.doesNotThrow(() => validateBody('run_bootstrap', { ...ordinary, probe: null }));
  const body = { ...ordinary, probe: { ...probeBootstrap } };
  assert.equal(validateBody('run_bootstrap', body), body);
});

for (const [name, probe] of [
  ['array', []],
  ['string', 'probe'],
  ['missing field', { binding_id: 'binding-1', probe_id: 'probe-1', preview_hash: 'preview' }],
  ['extra field', { ...probeBootstrap, extra: 'no' }],
  ['non-string field', { ...probeBootstrap, probe_id: 1 }],
]) {
  test(`run_bootstrap rejects ${name} probe metadata`, () => {
    assert.throws(
      () => validateBody('run_bootstrap', { ...bootstrapBody(), probe }),
      (err) => err.code === 'invalid_probe',
    );
  });
}

test('staged Composer text becomes the first model prompt', pipeTest, async () => {
  const text = 'pasted local_only contract\n第二行';
  const result = await runOnce({
    bootstrap: { sealed_input_b64: Buffer.from(text, 'utf8').toString('base64url') },
  });
  assertLoop(result, ['model_request', 'loop_end'], 1);
  const messages = result.received[0].body.request.messages;
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.deepEqual(JSON.parse(messages[1].content), [{ type: 'text', text }]);
});

test('probe ignores sealed input, exposes no tools, and makes exactly one bounded model turn', pipeTest, async () => {
  const result = await runOnce({
    bootstrap: {
      probe: { ...probeBootstrap },
      sealed_input_b64: Buffer.from('SEALED_USER_INPUT_MUST_NOT_LEAK', 'utf8').toString('base64url'),
      max_turns: '8',
      max_tokens: '4096',
    },
    // Even a provider-requested tool call cannot escape the probe's no-tool, one-turn boundary.
    model: () => modelReply('probe ok', [readCall]),
  });
  assertLoop(result, ['model_request', 'loop_end'], 1);
  const request = result.received[0].body.request;
  assert.deepEqual(request.messages, []);
  assert.deepEqual(request.tools, []);
  assert.deepEqual(request.parameters, { max_tokens: 16 });
  assert.deepEqual(request.template, {
    id: 'device-model-probe-v1', version: '1', hash: probeTemplateHash,
  });
  assert.equal(JSON.stringify(request).includes('SEALED_USER_INPUT_MUST_NOT_LEAK'), false);
  assert.equal(finalMessages(result).some((message) => message.role === 'user'), false);
  assert.equal(result.received.some((frame) => frame.type === 'tool_call'), false);
});

test('probe template hash mismatch fails closed before any model or tool frame', pipeTest, async () => {
  const result = await runOnce({
    bootstrap: { probe: { ...probeBootstrap, template_hash: '0'.repeat(64) } },
  });
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /work-device-bundle: invalid_probe_template_hash/);
  assert.deepEqual(result.received, []);
});

for (const [name, bootstrap] of [
  ['omitted', {}],
  ['null', { probe: null }],
]) {
  test(`ordinary run with ${name} probe metadata keeps its prompt, tools, template, and turn budget`, pipeTest, async () => {
    const result = await runOnce({
      bootstrap,
      model: (turn) => turn === 0 ? modelReply('inspect', [readCall]) : modelReply('done'),
      tool: (f) => [permitGate(f), toolResult(f)],
    });
    assertLoop(result, ['model_request', 'workspace.read', 'model_request', 'loop_end'], 2);
    const request = result.received[0].body.request;
    assert.deepEqual(request.parameters, { max_tokens: 4096 });
    assert.deepEqual(request.template, { id: 'device-default', version: '1', hash: 'tmh' });
    assert.deepEqual(request.tools, []);
    assert.deepEqual(JSON.parse(request.messages.at(-1).content), [{ type: 'text', text: 'begin' }]);
  });
}

test('loop_end transcript shape is closed and validated', () => {
  assert.doesNotThrow(() => validateBody('loop_end', {
    transcript_final: { messages: [{ role: 'assistant', content: 'done' }] }, turn_count: '1',
  }));
  assert.throws(() => validateBody('loop_end', {
    transcript_final: { messages: [{ content: 'missing role' }] }, turn_count: '1',
  }), /bad_enum/);
  assert.throws(() => validateBody('loop_end', {
    transcript_final: { messages: [] }, turn_count: '1\n',
  }), /bad_enum/);
});

test('model -> read/list -> model -> write -> model(stop), sequential with full transcript', pipeTest, async () => {
  const result = await runOnce({
    model: (turn) => turn === 0 ? modelReply('inspect first', [readCall, listCall])
      : turn === 1 ? modelReply([{ type: 'text', text: 'write next' }], [writeCall]) : modelReply('done'),
    tool: (f) => [permitGate(f), toolResult(f)],
  });
  assertLoop(result, ['model_request', 'workspace.read', 'workspace.list', 'model_request', 'artifact.write', 'model_request', 'loop_end'], 3);
  assert.deepEqual(result.trace.slice(2), [
    'model_request', 'model_response', 'workspace.read', 'tool_permit_gate', 'tool_result',
    'workspace.list', 'tool_permit_gate', 'tool_result', 'model_request', 'model_response',
    'artifact.write', 'tool_permit_gate', 'tool_result', 'model_request', 'model_response', 'loop_end',
  ]);
  const tools = result.received.filter((f) => f.type === 'tool_call');
  assert.deepEqual(tools.map((f) => f.body.args), [readArgs, listArgs, writeArgs]);
  const models = result.received.filter((f) => f.type === 'model_request');
  const secondTranscript = models[1].body.request.messages;
  assert.deepEqual(JSON.parse(secondTranscript.find((m) => m.role === 'assistant').content), [
    { type: 'text', text: 'inspect first' },
    { type: 'toolCall', id: 'tc-read', name: 'workspace.read', arguments: readArgs },
    { type: 'toolCall', id: 'tc-list', name: 'workspace.list', arguments: listArgs },
  ]);
  assert.deepEqual(secondTranscript.filter((m) => m.role === 'toolResult').map((m) => JSON.parse(m.content)), [
    [{ type: 'text', text: 'result:workspace.read' }], [{ type: 'text', text: 'result:workspace.list' }],
  ]);
  assert.deepEqual(JSON.parse(models[2].body.request.messages.at(-1).content), [{ type: 'text', text: 'result:artifact.write' }]);
  assert.deepEqual(finalMessages(result).at(-1).content, [{ type: 'text', text: 'done' }]);
});

test('Broker object-shaped tool content reaches the next model turn', pipeTest, async () => {
  const content = {
    content: [{ type: 'text', text: 'BROKER_READ_BODY_SENTINEL' }],
    content_hash: `sha256:${'b'.repeat(64)}`,
    byte_count: '25',
  };
  const result = await runOnce({
    model: (turn) => turn === 0 ? modelReply([], [readCall]) : modelReply('done'),
    tool: (f) => {
      const reply = toolResult(f);
      reply.body.content = content;
      reply.body.structured_content = content;
      return [reply];
    },
  });
  assertLoop(result, ['model_request', 'workspace.read', 'model_request', 'loop_end'], 2);
  const messages = result.received.filter((f) => f.type === 'model_request')[1].body.request.messages;
  const blocks = JSON.parse(messages.find((m) => m.role === 'toolResult').content);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.deepEqual(JSON.parse(blocks[0].text), content);
});

for (const [name, reply] of [
  ['pending approval', (f) => ({ type: 'tool_blocked', body: { tool_call_id: f.body.tool_call_id, reason: 'pending_approval', terminate: true, is_error: false } })],
  ['unknown', (f) => ({ type: 'tool_unknown', body: { tool_call_id: f.body.tool_call_id, reason: 'connection_lost' } })],
  ['terminating result', (f) => toolResult(f, true)],
  ['blocked permit gate', (f) => permitGate(f, 'blocked')],
]) {
  for (const stopIndex of [0, 1]) {
    test(`${name} at index ${stopIndex} stops remaining batch and next model`, pipeTest, async () => {
      const result = await runOnce({
        model: () => modelReply([], [readCall, listCall, writeCall]),
        tool: (f, index) => [index === stopIndex ? reply(f) : toolResult(f)],
      });
      assertLoop(result, ['model_request', ...['workspace.read', 'workspace.list'].slice(0, stopIndex + 1), 'loop_end'], 1);
      assert.equal(finalMessages(result).filter((m) => m.role === 'toolResult').length, stopIndex + 1);
    });
  }
}

for (const maxTurns of ['0', '1', '2']) {
  test(`max_turns=${maxTurns} bounds a model that keeps requesting tools`, pipeTest, async () => {
    const result = await runOnce({ bootstrap: { max_turns: maxTurns }, model: () => modelReply([], [readCall]) });
    assertLoop(result, [...Array.from({ length: Number(maxTurns) }, () => ['model_request', 'workspace.read']).flat(), 'loop_end'], Number(maxTurns));
  });
}

test('ordinary model requests carry the Broker-supplied output token bound', pipeTest, async () => {
  const result = await runOnce({ bootstrap: { max_tokens: '1234' } });
  assertLoop(result, ['model_request', 'loop_end'], 1);
  assert.deepEqual(result.received[0].body.request.parameters, { max_tokens: 1234 });
});

test('an oversized serialized model request fails before any model frame', pipeTest, async () => {
  const result = await runOnce({ bootstrap: { max_bytes: '1' } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.received.map((f) => f.type), ['loop_end']);
  assert.equal(finalMessages(result).at(-1).stopReason, 'error');
  assert.match(finalMessages(result).at(-1).errorMessage, /request_bytes_exceeded/);
});

for (const maxTokens of [null, 0, true, {}, [], '', '-1', '1.5', '1e2', ' 2', '2\n', '2x', '9007199254740992']) {
  test(`invalid max_tokens=${JSON.stringify(maxTokens)} fails closed before any model/tool`, pipeTest, async () => {
    const result = await runOnce({ bootstrap: { max_tokens: maxTokens } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /work-device-bundle: invalid_max_tokens/);
    assert.deepEqual(result.received, []);
  });
}

for (const maxBytes of [null, 0, true, {}, [], '', '-1', '1.5', '1e2', ' 2', '2\n', '2x', '262145']) {
  test(`invalid max_bytes=${JSON.stringify(maxBytes)} fails closed before any model/tool`, pipeTest, async () => {
    const result = await runOnce({ bootstrap: { max_bytes: maxBytes } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /work-device-bundle: invalid_max_bytes/);
    assert.deepEqual(result.received, []);
  });
}

for (const content of ['plain OpenAI text', [{ type: 'text', text: 'block text' }]]) {
  test(`no-tool response ends naturally and preserves ${typeof content} content`, pipeTest, async () => {
    const result = await runOnce({ bootstrap: { max_turns: '18446744073709551615' }, model: () => modelReply(content) });
    assertLoop(result, ['model_request', 'loop_end'], 1);
    assert.deepEqual(finalMessages(result).at(-1).content, typeof content === 'string' ? [{ type: 'text', text: content }] : content);
  });
}

for (const maxTurns of [null, 2, true, {}, [], '', '-1', '1.5', '1e2', 'Infinity', ' 2', '2\n', '2x', '18446744073709551616']) {
  test(`invalid max_turns=${JSON.stringify(maxTurns)} fails closed before any model/tool`, pipeTest, async () => {
    const result = await runOnce({ bootstrap: { max_turns: maxTurns } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /work-device-bundle: invalid_max_turns/);
    assert.deepEqual(result.received, []);
  });
}

test('model unknown ends without retry or tool execution', pipeTest, async () => {
  const result = await runOnce({ model: () => ({ type: 'model_unknown', body: { outcome: 'unknown', reason: 'connection_lost' } }) });
  assertLoop(result, ['model_request', 'loop_end'], 1);
  assert.equal(finalMessages(result).at(-1).stopReason, 'error');
});

// DD:250 closed-set tool_calls validation: a malformed call ends the turn in error with NO tool
// execution and NO silent {} projection — never an undefined-field call reaching the Broker.
for (const [name, toolCalls] of [
  ['missing id', [{ type: 'function', function: { name: 'artifact.write', arguments: JSON.stringify(writeArgs) } }]],
  ['empty id', [{ id: '', type: 'function', function: { name: 'artifact.write', arguments: JSON.stringify(writeArgs) } }]],
  ['missing name', [{ id: 'tc-1', type: 'function', function: { arguments: JSON.stringify(writeArgs) } }]],
  ['empty name', [{ id: 'tc-1', type: 'function', function: { name: '', arguments: JSON.stringify(writeArgs) } }]],
  ['invalid JSON arguments', [{ id: 'tc-1', type: 'function', function: { name: 'artifact.write', arguments: '{not json' } }]],
  ['array arguments', [{ id: 'tc-1', type: 'function', function: { name: 'artifact.write', arguments: '[1,2]' } }]],
  ['object-shaped tool_calls', { id: 'tc-1', type: 'function', function: { name: 'artifact.write', arguments: '{}' } }],
  ['non-object call', ['tc-1']],
]) {
  test(`malformed tool_calls (${name}) fails closed without execution`, pipeTest, async () => {
    const result = await runOnce({ model: () => modelReply([], toolCalls) });
    assertLoop(result, ['model_request', 'loop_end'], 1);
    const last = finalMessages(result).at(-1);
    assert.equal(last.stopReason, 'error');
    assert.match(last.errorMessage, /invalid_tool_calls/);
    assert.equal(result.received.filter((f) => f.type === 'tool_call').length, 0);
  });
}
