import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { MAX_FRAME_BYTES, decodeFrame } from '../src/protocol.mjs';
import { killQuietly } from '../test-support/helpers.mjs';

const CHILD_ENTRY = fileURLToPath(new URL('../src/child-stub.mjs', import.meta.url));

test('the child stub enforces the inbound frame limit', { timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, [CHILD_ENTRY], {
    env: {
      ...process.env,
      WORK_RUN_ID: 'run-1',
      WORK_RUN_NONCE: 'a'.repeat(48),
      WORK_PROTOCOL_VERSION: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    killQuietly(child.pid);
    child.stdin.destroy();
    child.stdio[3]?.destroy();
  });

  const lines = createInterface({ input: child.stdout });
  const [helloLine] = await once(lines, 'line');
  assert.equal(decodeFrame(helloLine).type, 'hello');

  child.stdio[3].end(Buffer.alloc(0));
  child.stdin.write(`${'x'.repeat(MAX_FRAME_BYTES + 1)}\n`);
  const [code] = await once(child, 'exit');
  assert.equal(code, 4);
  lines.close();
});
