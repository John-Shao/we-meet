import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSignalHandlers } from '../bin/work-runtime.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { isAlive, killQuietly, recordingSpawn, waitFor } from '../test-support/helpers.mjs';

const BIN_ENTRY = fileURLToPath(new URL('../bin/work-runtime.mjs', import.meta.url));

async function exerciseSignal(signal, t) {
  const controller = recordingSpawn({ behavior: 'hang' });
  const supervisor = new Supervisor({
    maxConcurrent: 1,
    runtimeVersion: 'runtime-v1',
    startTimeoutMs: 4000,
    runTimeoutMs: 5000,
    killGraceMs: 150,
    spawn: controller.spawn,
  });
  const running = supervisor.start({ runId: 'run-1', fence: 1, holderId: 'h', payload: {} });
  await waitFor(() => controller.records.length === 1 && controller.records[0].pid !== undefined);

  const pid = controller.records[0].pid;
  const exitCodes = [];
  const uninstall = installSignalHandlers(supervisor, {
    exit: (code) => exitCodes.push(code),
    log: () => {},
  });
  t.after(() => {
    uninstall();
    killQuietly(pid);
  });

  assert.equal(process.listenerCount('SIGINT'), 1);
  assert.equal(process.listenerCount('SIGTERM'), 1);

  process.emit(signal);
  await waitFor(() => exitCodes.length === 1, { timeout: 5000 });
  assert.equal(exitCodes[0], 0);

  await supervisor.shutdown();
  const result = await running;
  assert.equal(result.status, 'failed');
  assert.equal(controller.records[0].exited, true);
  assert.equal(isAlive(pid), false);
}

test('bin SIGTERM handler shuts the supervisor down and reaps the child', { timeout: 10000 }, async (t) => {
  await exerciseSignal('SIGTERM', t);
});

test('bin SIGINT handler shuts the supervisor down and reaps the child', { timeout: 10000 }, async (t) => {
  await exerciseSignal('SIGINT', t);
});

test('the bin entrypoint leaves no orphan when its parent process is terminated', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-runtime-bin-'));
  const pidFile = join(dir, 'child.pid');
  let stubPid;

  const bin = spawn(process.execPath, [BIN_ENTRY], {
    env: {
      ...process.env,
      WORK_STUB_BEHAVIOR: 'hang',
      WORK_STUB_PID_FILE: pidFile,
      // The bin refuses stub wiring unless a harness opts in (DR2 finding 12, ruled S5=A).
      WORK_RUNTIME_ALLOW_STUB: '1',
      WORK_RUN_ID: 'bin-run',
      WORK_RUNTIME_VERSION: 'runtime-v1',
      WORK_START_TIMEOUT_MS: '5000',
      WORK_RUN_TIMEOUT_MS: '30000',
      WORK_KILL_GRACE_MS: '200',
      WORK_PAYLOAD_JSON: '{}',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bin.stdout.resume();
  bin.stderr.resume();

  t.after(async () => {
    bin.kill('SIGKILL');
    if (stubPid !== undefined) killQuietly(stubPid);
    await rm(dir, { recursive: true, force: true });
  });

  await waitFor(async () => {
    try {
      return (await readFile(pidFile, 'utf8')).trim().length > 0;
    } catch {
      return false;
    }
  });
  stubPid = Number((await readFile(pidFile, 'utf8')).trim());
  assert.ok(Number.isInteger(stubPid) && stubPid > 0);
  assert.equal(isAlive(stubPid), true);

  const binExit = once(bin, 'exit');
  bin.kill('SIGTERM');
  await binExit;

  await waitFor(() => !isAlive(stubPid), { timeout: 10000 });
  assert.equal(isAlive(stubPid), false);
});

test('the bin refuses stub wiring unless a harness opts in', { timeout: 20000 }, async (t) => {
  // DR2 finding 12 (ruled S5=A on 2026-11-04). Before this guard, one stray WORK_STUB_* in the deployed
  // environment swapped the real Pi child for the test stub while the pool kept reporting healthy runs.
  const dir = await mkdtemp(join(tmpdir(), 'work-runtime-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'child.pid');

  const bin = spawn(process.execPath, [BIN_ENTRY], {
    env: {
      ...process.env,
      WORK_STUB_BEHAVIOR: 'hang',
      WORK_STUB_PID_FILE: pidFile,
      WORK_RUN_ID: 'guard-run',
      WORK_RUNTIME_VERSION: 'runtime-v1',
      WORK_PAYLOAD_JSON: '{}',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  bin.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  bin.stdout.resume();
  // A bounded wait, so a missing guard fails on the assertion below rather than on the test timeout:
  // the refusal must be immediate, and a killed-by-deadline run (code null) is itself the wrong answer.
  const deadline = setTimeout(() => bin.kill('SIGKILL'), 5000);
  const [code] = await once(bin, 'exit');
  clearTimeout(deadline);

  assert.equal(code, 1, `expected an immediate refusal with exit 1, got ${code}; stderr=${stderr.slice(0, 160)}`);
  assert.match(stderr, /stub_wiring_not_allowed/);
  assert.equal(existsSync(pidFile), false, 'the stub must never have been spawned');
});
