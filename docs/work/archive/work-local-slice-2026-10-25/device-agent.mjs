import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_URL = process.env.API_URL || 'http://127.0.0.1:8878';
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'device-slice-token';
const DEVICE_ID =
  process.env.DEVICE_ID || '11111111-1111-4111-8111-111111111111';
const PERMIT_SECRET = process.env.PERMIT_SECRET || 'local-slice-permit-secret';
const ROOT_DIR = path.resolve(process.env.ROOT_DIR || path.join(__dirname, 'content', 'device-root'));
const STATE_FILE = path.resolve(process.env.STATE_FILE || path.join(__dirname, 'content', 'agent-state.json'));
const JOURNAL_FILE = path.resolve(process.env.JOURNAL_FILE || path.join(__dirname, 'content', 'journal.json'));
const DROP_RECEIPT_ONCE = process.env.DROP_RECEIPT_ONCE === '1';
const POLL_MS = Number(process.env.POLL_MS || 150);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 500);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonDurable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  fs.writeFileSync(fd, JSON.stringify(value, null, 2));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function api(pathname, body) {
  const response = await fetch(`${API_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-device-token': DEVICE_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${pathname}:${response.status}:${JSON.stringify(data)}`);
  }
  return data;
}

function verifyPermit(command) {
  const parts = String(command.signed_permit || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('permit_format');
  const expected = crypto
    .createHmac('sha256', PERMIT_SECRET)
    .update(`v1.${parts[1]}`)
    .digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('permit_signature');
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (
    payload.operation_id !== command.operation_id ||
    payload.run_id !== command.run_id ||
    Number(payload.fence) !== Number(command.fence) ||
    payload.request_hash !== command.request_hash
  ) {
    throw new Error('permit_binding');
  }
  if (new Date(payload.expires_at).getTime() <= Date.now()) throw new Error('permit_expired');
  return payload;
}

function assertPathInsideRoot(relativePath) {
  const root = path.resolve(ROOT_DIR);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('path_escape');
  }
  return target;
}

function executeCommand(command, journal) {
  const target = assertPathInsideRoot(command.relative_path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, 'w');
  fs.writeFileSync(fd, command.content, 'utf8');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return {
    content_hash: sha256(command.content),
    bytes: Buffer.byteLength(command.content),
    relative_path: command.relative_path,
    payload_ref: `local://${DEVICE_ID}/${sha256(command.content)}`,
  };
}

function nextSeq(journal) {
  return journal.entries.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
}

function findEntry(journal, operationId) {
  return journal.entries.find((entry) => entry.operation_id === operationId);
}

function markReleased(journal, throughSeq) {
  journal.entries = journal.entries.filter((entry) => entry.seq > throughSeq);
  writeJsonDurable(JOURNAL_FILE, journal);
}

async function sendReceipt(entry, state, sessionKey, journal) {
  const response = await api('/internal/device/receipts', {
    device_id: DEVICE_ID,
    session_key: sessionKey,
    operation_id: entry.operation_id,
    seq: entry.seq,
    fence: entry.fence,
    request_hash: entry.request_hash,
    state,
    content_hash: entry.content_hash,
    bytes: entry.bytes,
    payload_ref: entry.payload_ref,
  });
  if (response.journal_release) {
    markReleased(journal, Number(response.journal_release.through_seq));
    console.log(`JOURNAL_RELEASE ${response.journal_release.through_seq}`);
  }
  return response;
}

async function main() {
  fs.mkdirSync(ROOT_DIR, { recursive: true });
  const state = readJson(STATE_FILE, {});
  const journal = readJson(JOURNAL_FILE, { entries: [] });
  state.boot_id ||= crypto.randomUUID();
  const hello = await api('/internal/device/hello', {
    device_id: DEVICE_ID,
    boot_id: state.boot_id,
    session_key: state.session_key,
    protocol_version: '1.0',
  });
  state.session_key = hello.session_key;
  state.boot_id = hello.boot_id;
  writeJsonDurable(STATE_FILE, state);
  console.log(`HELLO ${hello.session_id} reconnected=${hello.reconnected}`);

  // 已完成但尚未确认释放的 journal，先重放回执；不重新执行。
  for (const entry of [...journal.entries]) {
    if (entry.state === 'completed') {
      try {
        await sendReceipt(entry, 'completed', state.session_key, journal);
        console.log(`REPLAY_RECEIPT ${entry.operation_id}`);
      } catch (error) {
        console.error(`REPLAY_FAILED ${entry.operation_id} ${error.message}`);
      }
    }
  }

  const heartbeat = setInterval(() => {
    api('/internal/device/heartbeat', {
      session_key: state.session_key,
      boot_id: state.boot_id,
    }).catch((error) => console.error(`HEARTBEAT_FAILED ${error.message}`));
  }, HEARTBEAT_MS);

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await api('/internal/device/commands', {
        session_key: state.session_key,
      });
      const command = result.command;
      if (!command) return;
      verifyPermit(command);
      const existing = findEntry(journal, command.operation_id);
      if (existing?.state === 'completed') {
        await sendReceipt(existing, 'completed', state.session_key, journal);
        return;
      }
      if (existing?.state === 'started') {
        // 已开始但没有完成回执：不能盲目重放副作用，交给控制面核对。
        await sendReceipt(existing, 'unknown', state.session_key, journal);
        console.log(`UNKNOWN_NO_COMPLETION ${command.operation_id}`);
        return;
      }
      const seq = nextSeq(journal);
      const started = {
        operation_id: command.operation_id,
        run_id: command.run_id,
        task_id: command.task_id,
        fence: command.fence,
        request_hash: command.request_hash,
        seq,
        state: 'started',
      };
      journal.entries.push(started);
      writeJsonDurable(JOURNAL_FILE, journal);
      const resultData = executeCommand(command, journal);
      Object.assign(started, {
        state: 'completed',
        content_hash: resultData.content_hash,
        bytes: resultData.bytes,
        relative_path: resultData.relative_path,
        payload_ref: resultData.payload_ref,
      });
      writeJsonDurable(JOURNAL_FILE, journal);
      console.log(`EXECUTED ${command.operation_id} ${resultData.relative_path}`);
      if (DROP_RECEIPT_ONCE) {
        console.log(`DROP_RECEIPT ${command.operation_id}`);
        clearInterval(heartbeat);
        clearInterval(timer);
        setTimeout(() => process.exit(0), 20);
        return;
      }
      await sendReceipt(started, 'completed', state.session_key, journal);
      console.log(`RECEIPT_SENT ${command.operation_id}`);
    } catch (error) {
      console.error(`POLL_FAILED ${error.message}`);
    } finally {
      running = false;
    }
  }, POLL_MS);

  const stop = () => {
    clearInterval(heartbeat);
    clearInterval(timer);
    writeJsonDurable(JOURNAL_FILE, journal);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
