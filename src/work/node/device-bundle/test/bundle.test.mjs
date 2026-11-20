// Integration proof for the device Node bundle (execution-face §6.2/§6.3). A mock Broker stands up a
// real Windows named pipe, handshakes (client_kind=node), sends run_bootstrap, then drives ONE
// model→artifact.write→model(stop) loop and asserts the bundle emits loop_end. This exercises the
// four injected seams against pi-agent-core 1.4.0 with NO provider, NO path, NO network: the model and
// tool replies come only from the Broker pipe. On non-Windows the named-pipe path is unavailable, so
// the test skips (the device sidecar is Windows-only).

import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

import { FrameReader, encodeFrame, validateBody } from '../protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainJs = path.join(here, '..', 'main.js');

// A valid artifact.write argument set (the sealed tool-schemas.json contract pi-ai validates before
// execute); the mock model issues exactly these so the tool_call reaches the Broker.
const writeArgs = {
  grant_id: 'g1',
  artifact_id: 'a',
  version_id: 'v1',
  format: 'md',
  body_ref: 'buf-1',
  content_hash: `sha256:${'a'.repeat(64)}`,
  byte_count: '10',
};

function bootstrapBody() {
  return {
    run_id: 'run-1',
    binding_revision: '1',
    start_nonce: 'nonce-1',
    profile_id: 'profile-dev-fixture-v1',
    compat_profile_version: '1',
    tool_manifest_hash: 'tmh',
    runtime_digest: 'rd',
    model_route: { provider: 'device-local', model: 'fixture-model', config_revision: '1' },
    sealed_input_refs: [],
    max_turns: '8',
    max_tokens: '4096',
    max_bytes: '1048576',
    deadline: '2026-11-19T01:00:00Z',
  };
}

// Run the mock Broker on a connected socket: handshake, bootstrap, then answer the loop. Resolves with
// the collected Node→Broker frames once loop_end arrives (or the socket closes).
function runBroker(socket) {
  return new Promise((resolve, reject) => {
    const reader = new FrameReader();
    const received = [];
    let stage = 'hello';
    let modelTurn = 0;
    const send = (value) => socket.write(encodeFrame(value));
    const timer = setTimeout(() => reject(new Error('broker timeout')), 20000);
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = reader.push(chunk);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      for (const f of frames) {
        if (stage === 'hello') {
          // The first frame from Node is the bare client hello.
          assert.equal(f.client_kind, 'node');
          assert.equal(f.protocol_major, 1);
          send({ type: 'run_bootstrap', body: bootstrapBody() });
          stage = 'loop';
          continue;
        }
        received.push(f);
        if (f.type === 'model_request') {
          validateBody('model_request', f.body);
          modelTurn += 1;
          if (modelTurn === 1) {
            // First turn: the model asks to write an artifact.
            send({
              type: 'model_response',
              body: {
                outcome: 'success',
                assistant_message: {
                  content: [],
                  tool_calls: [{ id: 'tc-1', name: 'artifact.write', arguments: writeArgs }],
                },
                answer_hash: 'sha256:aa',
                answer_bytes: '10',
                usage: { input: 1, output: 1 },
                provider_request_id: 'req-1',
              },
            });
          } else {
            // Second turn: the model stops (no tool calls) -> finishTurn end -> loop_end.
            send({
              type: 'model_response',
              body: {
                outcome: 'success',
                assistant_message: { content: [{ type: 'text', text: 'done' }], tool_calls: [] },
                answer_hash: 'sha256:bb',
                answer_bytes: '4',
                usage: { input: 1, output: 1 },
                provider_request_id: 'req-2',
              },
            });
          }
        } else if (f.type === 'tool_call') {
          validateBody('tool_call', f.body);
          assert.equal(f.body.tool_name, 'artifact.write');
          // The permit gate proceeds, then the handle-relative result.
          send({
            type: 'tool_permit_gate',
            body: { tool_call_id: f.body.tool_call_id, decision: 'proceed', reason: null, terminate: false },
          });
          send({
            type: 'tool_result',
            body: {
              tool_call_id: f.body.tool_call_id,
              content: [{ type: 'text', text: 'written' }],
              structured_content: { written: true },
              details: {},
              is_error: false,
              terminate: false,
            },
          });
        } else if (f.type === 'loop_end') {
          validateBody('loop_end', f.body);
          clearTimeout(timer);
          socket.end();
          resolve(received);
        }
      }
    });
    // The Broker writes server_hello first.
    send({ nonce: 'n-1', protocol_major: 1 });
  });
}

async function runOnce() {
  const pipeName = `\\\\.\\pipe\\work-device-bundle-test-${process.pid}-${Date.now()}`;
  const server = net.createServer();
  const brokerDone = new Promise((resolve, reject) => {
    server.on('connection', (socket) => runBroker(socket).then(resolve, reject));
    server.on('error', reject);
  });
  await new Promise((resolve) => server.listen(pipeName, resolve));

  const child = spawn(process.execPath, [mainJs, pipeName], {
    cwd: path.join(here, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const childExit = new Promise((resolve) => child.on('exit', resolve));

  const received = await brokerDone;
  await childExit;
  server.close();

  const types = received.map((f) => f.type);
  assert.ok(types.includes('model_request'), 'a model turn happened');
  assert.ok(types.includes('tool_call'), 'a tool call happened');
  assert.equal(types[types.length - 1], 'loop_end', 'loop_end is the final frame');
  const toolFrame = received.find((f) => f.type === 'tool_call');
  assert.equal(toolFrame.body.tool_name, 'artifact.write');
  assert.deepEqual(toolFrame.body.args, writeArgs);
  assert.equal(stderr, '', `bundle stderr: ${stderr}`);
}

const isWindows = process.platform === 'win32';

// The device sidecar is Windows-only (named pipe + AppContainer); elsewhere the proof skips.
test('the bundle drives a model->artifact.write loop through the Broker pipe', { skip: !isWindows }, async () => {
  await runOnce();
});