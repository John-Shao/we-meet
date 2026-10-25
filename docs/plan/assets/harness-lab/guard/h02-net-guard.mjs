import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const logFile = process.env.H02_NET_LOG;
const origAppend = fs.appendFileSync.bind(fs);

function record(type, detail) {
  origAppend(logFile, `${JSON.stringify({ type, detail, at: new Date().toISOString() })}\n`);
}

record("start", {
  gatewayPort: process.env.H02_PORT,
  hasDashscopeKey: Boolean(process.env.DASHSCOPE_API_KEY),
  hasGatewayToken: Boolean(process.env.H02_INTERNAL_TOKEN),
});

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patched(...args) {
  const first = args[0];
  record("net", {
    api: "Socket.connect",
    host: typeof first === "object" ? first.host : undefined,
    port: typeof first === "object" ? first.port : first,
  });
  return originalConnect.apply(this, args);
};

for (const [mod, name] of [
  [http, "http"],
  [https, "https"],
]) {
  for (const method of ["request", "get"]) {
    const original = mod[method];
    mod[method] = function patched(...args) {
      const first = args[0];
      record("net", {
        api: `${name}.${method}`,
        host: typeof first === "string" ? first : first?.hostname ?? first?.host,
        port: typeof first === "object" ? first?.port : undefined,
      });
      return original.apply(this, args);
    };
  }
}

const originalLookup = dns.lookup;
dns.lookup = function patched(hostname, ...rest) {
  record("net", { api: "dns.lookup", host: hostname });
  return originalLookup.call(this, hostname, ...rest);
};

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function patched(url, init) {
    let target;
    try {
      target = new URL(typeof url === "string" ? url : url.url);
    } catch {
      target = undefined;
    }
    record("net", { api: "fetch", host: target?.hostname, port: target?.port, path: target?.pathname });
    return originalFetch.call(this, url, init);
  };
}

const originalTlsConnect = tls.connect;
tls.connect = function patched(...args) {
  const first = args[0];
  record("net", {
    api: "tls.connect",
    host: typeof first === "object" ? first.host : undefined,
    port: typeof first === "object" ? first.port : first,
  });
  return originalTlsConnect.apply(this, args);
};
