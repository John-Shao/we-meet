import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { appendJsonl } from "./lib/store.mjs";
import { documentHash as hashModelRequest } from "../work-r0a-orchestration-2026-10-25/runtime-recovery.model.mjs";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function documentHash(document) {
  return hashModelRequest(document);
}

function extractUsage(tail, streaming) {
  if (!streaming) {
    try { return JSON.parse(tail).usage; } catch { return undefined; }
  }
  const lines = tail.split("\n").filter((line) => line.startsWith("data:"));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const data = lines[index].slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.usage) return parsed.usage;
      if (parsed.response?.usage) return parsed.response.usage;
    } catch {}
  }
  return undefined;
}

function normalizeUsage(usage) {
  const nonNegativeInteger = (...values) => {
    for (const value of values) {
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
    return null;
  };
  const input = nonNegativeInteger(usage?.prompt_tokens, usage?.input_tokens, usage?.inputTokens);
  const output = nonNegativeInteger(usage?.completion_tokens, usage?.output_tokens, usage?.outputTokens);
  if (input === null || output === null) {
    return { source: "unavailable", inputTokens: null, outputTokens: null, cachedInputTokens: null };
  }
  return {
    source: "provider",
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: nonNegativeInteger(
      usage?.prompt_tokens_details?.cached_tokens,
      usage?.input_tokens_details?.cached_tokens,
      usage?.cachedInputTokens,
    ) ?? 0,
  };
}

async function readBounded(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) {
      await response.body.cancel().catch(() => {});
      throw new Error("upstream_response_too_large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function loadRequestBundle(file) {
  const bundle = JSON.parse(await readFile(file, "utf8"));
  if (!bundle || typeof bundle !== "object" || !bundle.document ||
      typeof bundle.executionId !== "string" ||
      typeof bundle.input !== "string" || typeof bundle.template !== "string") {
    throw new Error("H02 request bundle must contain executionId, document, input and template");
  }
  const document = bundle.document;
  if (document.kind !== "model_request" || document.schemaVersion !== "work-model-request-v1" ||
      !document.route || typeof document.route.model !== "string" ||
      !document.input || !document.template ||
      document.input.hash !== hashBytes(Buffer.from(bundle.input)) ||
      document.template.hash !== hashBytes(Buffer.from(bundle.template))) {
    throw new Error("H02 request bundle is invalid");
  }
  return bundle;
}

export async function createEgressServer({
  gatewayUrl,
  token,
  bundle,
  provider = "qwen",
  logFile,
}) {
  const upstreamPath = provider === "doubao" ? "/v1/responses" : "/v1/chat/completions";
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/runtime/v1/model/invoke") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "not_found" }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "capability_invalid" }));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          res.writeHead(413, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ code: "request_too_large" }));
        }
        req.resume();
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on("end", async () => {
      if (tooLarge) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "invalid_request" }));
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          typeof body.executionId !== "string" || typeof body.requestHash !== "string" ||
          !body.requestRef || typeof body.requestRef !== "object" || Array.isArray(body.requestRef) ||
          typeof body.requestRef.refId !== "string" || typeof body.requestRef.hash !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "invalid_request" }));
        return;
      }
      const hash = documentHash(bundle.document);
      if (body.executionId !== bundle.executionId ||
          body.requestHash !== hash || body.requestRef?.hash !== hash) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "request_mismatch" }));
        return;
      }
      const upstreamBody = {
        model: bundle.document.route.model,
        stream: true,
        messages: [
          { role: "system", content: bundle.template },
          { role: "user", content: bundle.input },
        ],
        max_tokens: bundle.document.parameters?.maxOutputTokens ?? 2048,
      };
      const started = Date.now();
      try {
        const upstream = await fetch(`${gatewayUrl}${upstreamPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-work-gateway-token": "local-dev",
            "x-work-operation-id": `h02-supervisor:${body.executionId}`,
          },
          body: JSON.stringify(upstreamBody),
        });
        const raw = await readBounded(upstream, MAX_UPSTREAM_BYTES);
        requests.push({ executionId: body.executionId, status: upstream.status, bytes: raw.length });
        if (upstream.status < 200 || upstream.status >= 300) {
          appendJsonl(logFile, { executionId: body.executionId, status: upstream.status, latencyMs: Date.now() - started });
          res.writeHead(upstream.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "upstream_rejected" }));
          return;
        }
        const receipt = { refId: randomUUID(), hash: hashBytes(raw) };
        const usage = normalizeUsage(extractUsage(raw.toString("utf8"), true));
        appendJsonl(logFile, {
          executionId: body.executionId,
          status: upstream.status,
          latencyMs: Date.now() - started,
          bytes: raw.length,
          usage,
          providerRequestId: upstream.headers.get("x-request-id"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          outcome: "succeeded",
          sent: true,
          requestHash: hash,
          receipt,
          usage,
          providerRequestId: upstream.headers.get("x-request-id"),
        }));
      } catch (error) {
        appendJsonl(logFile, { executionId: body.executionId, status: "network_error", error: String(error).slice(0, 200) });
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "upstream_unavailable" }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

if (process.argv[1]?.endsWith("h02-egress.mjs")) {
  const bundle = await loadRequestBundle(process.env.H02_REQUEST_BUNDLE);
  const egress = await createEgressServer({
    gatewayUrl: `http://127.0.0.1:${process.env.H02_PORT}`,
    token: process.env.H02_EGRESS_TOKEN ?? "local-dev",
    bundle,
    provider: process.env.H02_PROVIDER ?? "qwen",
    logFile: process.env.H02_EGRESS_LOG,
  });
  console.log(`EGRESS_READY ${egress.baseUrl}`);
}
