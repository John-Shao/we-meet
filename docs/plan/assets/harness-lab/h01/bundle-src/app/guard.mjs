import fs from "node:fs";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const logFile = process.env.H01_GUARD_LOG;
const append = fs.appendFileSync.bind(fs);

function record(type, detail) {
  if (!logFile) return;
  try {
    append(logFile, `${JSON.stringify({ type, detail, at: new Date().toISOString() })}\n`);
  } catch {}
}

record("start", {
  execPath: process.execPath,
  cwd: process.cwd(),
  home: process.env.HOME ?? process.env.USERPROFILE,
  path: process.env.PATH,
});

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
net.Socket.prototype.connect = function patched(...args) {
  record("net", { api: "Socket.connect", target: args[0] });
  return originalConnect.apply(this, args);
};

for (const [mod, label] of [
  [http, "http"],
  [https, "https"],
]) {
  for (const name of ["request", "get"]) {
    const original = mod[name];
    mod[name] = function patched(...args) {
      record("net", { api: `${label}.${name}` });
      return original.apply(this, args);
    };
  }
}

for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) {
  const original = dns[name];
  dns[name] = function patched(...args) {
    record("net", { api: `dns.${name}`, target: args[0] });
    return original.apply(this, args);
  };
}

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function patched(url, init) {
    record("net", { api: "fetch", target: String(url) });
    return originalFetch.call(this, url, init);
  };
}
