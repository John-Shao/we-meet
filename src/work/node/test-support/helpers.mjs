import { spawn as nodeSpawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Every supervisor test drives the stub, never the real Pi child.
const STUB_CHILD = fileURLToPath(new URL('../src/child-stub.mjs', import.meta.url));

export function recordingSpawn({ behavior = 'ok', env = {}, childScript } = {}) {
  const records = [];

  function spawn(command, args, options) {
    const config = typeof behavior === 'function'
      ? { env: {}, ...(behavior(records.length) ?? {}) }
      : { behavior, env };
    const mergedEnv = { ...options.env, ...config.env };
    if (config.behavior !== undefined) mergedEnv.WORK_STUB_BEHAVIOR = config.behavior;

    const script = childScript === undefined ? STUB_CHILD : childScript;
    const child = nodeSpawn(command, [script], {
      ...options,
      env: mergedEnv,
    });
    const record = {
      child,
      args: [script],
      pid: child.pid,
      env: mergedEnv,
      exited: false,
      exitCode: undefined,
      signal: undefined,
    };
    record.exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        record.exited = true;
        record.exitCode = code;
        record.signal = signal;
        resolve({ code, signal });
      });
    });
    records.push(record);
    return child;
  }

  return { spawn, records };
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export async function waitFor(predicate, { timeout = 8000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await delay(interval);
  }
}

export function killQuietly(pid) {
  if (!isAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Best-effort cleanup for a failed assertion.
  }
}

/**
 * Deterministic clock for lease timing. `now`, `setTimeout` and `clearTimeout`
 * match the injection points of createLeaseSession; `advance(ms)` fires every
 * timer that became due, including timers scheduled by those callbacks.
 */
export function createManualClock(start = Date.now()) {
  let current = start;
  let nextId = 0;
  const pending = new Map();

  return {
    now: () => current,
    setTimeout(fn, ms) {
      nextId += 1;
      const id = nextId;
      pending.set(id, { at: current + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      current += Math.max(0, Number(ms) || 0);
      for (;;) {
        let dueId = null;
        let due = null;
        for (const [id, timer] of pending) {
          if (timer.at <= current && (due === null || timer.at < due.at)) {
            dueId = id;
            due = timer;
          }
        }
        if (due === null) return;
        pending.delete(dueId);
        due.fn();
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
}
