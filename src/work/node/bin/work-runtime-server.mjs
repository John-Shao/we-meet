// Entry point for the Work runtime internal advanceRuntime listener.
//
// Required environment:
//   WORK_RUNTIME_TLS_CERT   server certificate (PEM)
//   WORK_RUNTIME_TLS_KEY    server private key (PEM)
//   WORK_RUNTIME_CLIENT_CA  CA used to verify Go control-plane client certs
// Optional:
//   WORK_RUNTIME_LISTEN_ADDR  default 127.0.0.1:8446
//   WORK_HOLDER_ID            registered parent holder identity, default local
//   WORK_MAX_CONCURRENT       default 2
//   WORK_RUNTIME_VERSION      default dev
//   WORK_START_TIMEOUT_MS / WORK_RUN_TIMEOUT_MS / WORK_KILL_GRACE_MS
//   WORK_CHILD_SCRIPT, WORK_STUB_*  local test wiring only
//   WORK_AUTHZ_URL            internal issue_capability endpoint (https)
//   WORK_AUTHZ_CA / WORK_AUTHZ_CERT / WORK_AUTHZ_KEY  parent mTLS identity
//                             (default: the listener CA/cert/key files)
//   WORK_AUTHZ_SERVER_NAME    TLS server name override for the authz service
//   WORK_AUTHZ_TIMEOUT_MS     default 5000
//   WORK_CONTENT_PROXY_URL    default http://127.0.0.1:8444
//   WORK_EGRESS_URL           default http://127.0.0.1:8445

import { spawn as nodeSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createAdvanceServer } from '../src/server.mjs';
import { Supervisor } from '../src/supervisor.mjs';

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function requiredEnv(names) {
  const value = firstEnv(names);
  if (value === undefined) throw new Error(`${names[0]} is required`);
  return value;
}

function parseListenAddress(value) {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf(':');
  if (separator < 0) throw new Error('WORK_RUNTIME_LISTEN_ADDR must be host:port');
  const rawHost = trimmed.slice(0, separator);
  const host = (rawHost === '' ? '127.0.0.1' : rawHost).replace(/^\[|\]$/g, '');
  const port = Number(trimmed.slice(separator + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('WORK_RUNTIME_LISTEN_ADDR has an invalid port');
  }
  return { host, port };
}

const STUB_CHILD = fileURLToPath(new URL('../src/child-stub.mjs', import.meta.url));

function childSpawnWrapper() {
  const childScript = process.env.WORK_CHILD_SCRIPT;
  const stubEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('WORK_STUB_')),
  );
  const hasStubWiring = Object.keys(stubEnv).length > 0;
  if (childScript === undefined && !hasStubWiring) return undefined;
  // A stub-only test wiring must never fall back to the real Pi child.
  const script = childScript === undefined ? STUB_CHILD : childScript;
  return (command, args, options) => nodeSpawn(
    command,
    [script],
    { ...options, env: { ...options.env, ...stubEnv } },
  );
}

export async function main() {
  const certPath = requiredEnv(['WORK_RUNTIME_TLS_CERT', 'WORK_RUNTIME_CERT']);
  const keyPath = requiredEnv(['WORK_RUNTIME_TLS_KEY', 'WORK_RUNTIME_KEY']);
  const caPath = requiredEnv(['WORK_RUNTIME_CLIENT_CA', 'WORK_RUNTIME_CA']);
  const [cert, key, ca] = await Promise.all([
    readFile(certPath),
    readFile(keyPath),
    readFile(caPath),
  ]);
  const [authzCert, authzKey, authzCA] = await Promise.all([
    readFile(firstEnv(['WORK_AUTHZ_CERT']) ?? certPath),
    readFile(firstEnv(['WORK_AUTHZ_KEY']) ?? keyPath),
    readFile(firstEnv(['WORK_AUTHZ_CA']) ?? caPath),
  ]);
  const authz = {
    url: requiredEnv(['WORK_AUTHZ_URL']),
    ca: authzCA,
    cert: authzCert,
    key: authzKey,
    ...(firstEnv(['WORK_AUTHZ_SERVER_NAME']) === undefined
      ? {}
      : { serverName: firstEnv(['WORK_AUTHZ_SERVER_NAME']) }),
    timeoutMs: envNumber('WORK_AUTHZ_TIMEOUT_MS', 5000),
  };
  const spawn = childSpawnWrapper();
  const supervisor = new Supervisor({
    maxConcurrent: envNumber('WORK_MAX_CONCURRENT', 2),
    runtimeVersion: process.env.WORK_RUNTIME_VERSION ?? 'dev',
    startTimeoutMs: envNumber('WORK_START_TIMEOUT_MS', 5000),
    runTimeoutMs: envNumber('WORK_RUN_TIMEOUT_MS', 30000),
    killGraceMs: envNumber('WORK_KILL_GRACE_MS', 2000),
    ...(spawn === undefined ? {} : { spawn }),
  });

  const server = createAdvanceServer({
    supervisor,
    holderId: firstEnv(['WORK_HOLDER_ID', 'WORK_RUNTIME_HOLDER_ID']) ?? 'local',
    cert,
    key,
    ca,
    authz,
    contentBaseUrl: firstEnv(['WORK_CONTENT_PROXY_URL']) ?? 'http://127.0.0.1:8444',
    egressBaseUrl: firstEnv(['WORK_EGRESS_URL']) ?? 'http://127.0.0.1:8445',
  });
  const address = parseListenAddress(
    firstEnv(['WORK_RUNTIME_LISTEN_ADDR', 'WORK_LISTEN_ADDR']) ?? '127.0.0.1:8446',
  );

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address.port, address.host);
  });

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.error(`work-runtime-server: ${signal} received, shutting down`);
    Promise.all([
      supervisor.shutdown(),
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
        setTimeout(resolve, 5000).unref?.();
      }),
    ]).then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.error(`work-runtime-server: listening addr=${address.host}:${address.port}`);
  process.exitCode = 0;
  return { server, supervisor, address };
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`work-runtime-server: ${error?.code ?? 'error'}`);
    process.exitCode = 1;
  });
}
