// Minimal local wiring for the supervisor. Production calls arrive over the
// authenticated Go control-plane RPC; this entrypoint runs one Run from the
// environment, forwards SIGINT/SIGTERM to shutdown(), and never invokes a shell.

import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Supervisor } from '../src/supervisor.mjs';

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function envPayload() {
  const raw = process.env.WORK_PAYLOAD_JSON;
  if (raw === undefined || raw === '') return {};
  return JSON.parse(raw);
}

export function installSignalHandlers(supervisor, { exit = process.exit, log = console.error } = {}) {
  let stopping = false;

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`work-runtime: ${signal} received, shutting down`);
    supervisor.shutdown().then(
      () => exit(0),
      (error) => {
        log(`work-runtime: shutdown failed: ${error?.code ?? 'error'}`);
        exit(1);
      },
    );
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
}

const STUB_CHILD = fileURLToPath(new URL('../src/child-stub.mjs', import.meta.url));

export async function main() {
  const childScript = process.env.WORK_CHILD_SCRIPT;
  const stubEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('WORK_STUB_')),
  );
  const needsSpawnWrapper = childScript !== undefined || Object.keys(stubEnv).length > 0;
  // Stub-only wiring must never fall back to the real Pi child.
  const script = childScript === undefined ? STUB_CHILD : childScript;
  const spawn = needsSpawnWrapper
    ? (command, args, options) => nodeSpawn(command, [script], {
      ...options,
      env: { ...options.env, ...stubEnv },
    })
    : undefined;

  const supervisor = new Supervisor({
    maxConcurrent: envNumber('WORK_MAX_CONCURRENT', 2),
    runtimeVersion: process.env.WORK_RUNTIME_VERSION ?? 'dev',
    startTimeoutMs: envNumber('WORK_START_TIMEOUT_MS', 5000),
    runTimeoutMs: envNumber('WORK_RUN_TIMEOUT_MS', 30000),
    killGraceMs: envNumber('WORK_KILL_GRACE_MS', 2000),
    ...(spawn === undefined ? {} : { spawn }),
  });

  const request = {
    runId: process.env.WORK_RUN_ID ?? `local-${process.pid}`,
    fence: process.env.WORK_RUN_FENCE ?? 'local',
    holderId: process.env.WORK_HOLDER_ID ?? 'local',
    payload: envPayload(),
  };

  const uninstall = installSignalHandlers(supervisor);
  let result;

  try {
    const admission = supervisor.admit({
      runFence: request.fence,
      runtimeVersion: supervisor.runtimeVersion,
    });
    result = admission.ok
      ? await supervisor.start(request)
      : { status: 'rejected', exitCode: null, diagnostics: { reason: admission.reason } };
  } finally {
    await supervisor.shutdown();
    uninstall();
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'completed' ? 0 : 1;
  return result;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`work-runtime: ${error?.code ?? 'error'}`);
    process.exitCode = 1;
  });
}
