import fs from "node:fs";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";

const logFile = process.env.H05_LOG;
if (!logFile) throw new Error("H05_LOG is required");

const origAppend = fs.appendFileSync.bind(fs);

function record(type, detail) {
  origAppend(
    logFile,
    `${JSON.stringify({ type, detail, pid: process.pid, at: new Date().toISOString() })}\n`,
  );
}

record("start", { cwd: process.cwd(), home: process.env.HOME ?? process.env.USERPROFILE });

for (const name of [
  "readFileSync",
  "readFile",
  "openSync",
  "open",
  "readdirSync",
  "readdir",
  "statSync",
  "stat",
  "lstatSync",
  "lstat",
  "accessSync",
  "access",
  "realpathSync",
  "realpath",
  "createReadStream",
]) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function patched(...args) {
    record("fs", { api: name, path: String(args[0]) });
    return original.apply(this, args);
  };
}

for (const name of ["readFile", "open", "readdir", "stat", "lstat", "access", "realpath"]) {
  const original = fs.promises[name];
  if (typeof original !== "function") continue;
  fs.promises[name] = async function patched(...args) {
    record("fs", { api: `promises.${name}`, path: String(args[0]) });
    return original.apply(this, args);
  };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  record("net", { api: "Socket.connect", target: describe(args) });
  return originalConnect.apply(this, args);
};

const originalTlsConnect = tls.connect;
tls.connect = function patchedTlsConnect(...args) {
  record("net", { api: "tls.connect", target: describe(args) });
  return originalTlsConnect.apply(this, args);
};

for (const [mod, label] of [
  [http, "http"],
  [https, "https"],
]) {
  for (const name of ["request", "get"]) {
    const original = mod[name];
    mod[name] = function patched(...args) {
      record("net", { api: `${label}.${name}`, target: describe(args) });
      return original.apply(this, args);
    };
  }
}

for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) {
  const original = dns[name];
  dns[name] = function patched(...args) {
    record("net", { api: `dns.${name}`, target: describe(args) });
    return original.apply(this, args);
  };
}

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function patchedFetch(...args) {
    record("net", { api: "fetch", target: describe(args) });
    return originalFetch.apply(this, args);
  };
}

if (typeof globalThis.WebSocket === "function") {
  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class PatchedWebSocket extends OriginalWebSocket {
    constructor(...args) {
      record("net", { api: "WebSocket", target: describe(args) });
      super(...args);
    }
  };
}

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name];
  if (typeof original !== "function") continue;
  childProcess[name] = function patched(...args) {
    record("child_process", { api: name, target: describe(args) });
    return original.apply(this, args);
  };
}

function describe(args) {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    return {
      host: first.host ?? first.hostname,
      port: first.port,
      path: first.path,
      href: first.href,
    };
  }
  return String(first);
}
