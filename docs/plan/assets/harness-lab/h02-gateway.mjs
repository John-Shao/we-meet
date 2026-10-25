import http from "node:http";
import https from "node:https";
import { appendJsonl } from "./lib/store.mjs";

const apiKey = process.env.H02_UPSTREAM_KEY;
const provider = process.env.H02_PROVIDER ?? "qwen";
const port = Number(process.env.H02_PORT);
const logFile = process.env.H02_GATEWAY_LOG;
const upstreamUrl =
  provider === "deepseek"
    ? "https://api.deepseek.com/chat/completions"
    : provider === "doubao"
      ? "https://ark.cn-beijing.volces.com/api/v3/responses"
      : "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const expectedPath = provider === "doubao" ? "/v1/responses" : "/v1/chat/completions";

if (!apiKey || !port || !logFile) {
  console.error("H02 gateway requires H02_UPSTREAM_KEY, H02_PORT and H02_GATEWAY_LOG");
  process.exit(2);
}

function extractUsage(tail, stream) {
  if (!stream) {
    try {
      return JSON.parse(tail).usage;
    } catch {
      return undefined;
    }
  }
  const lines = tail.split("\n").filter((line) => line.startsWith("data:"));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const data = lines[index].slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.usage) return parsed.usage;
      if (parsed.response?.usage) return parsed.response.usage;
    } catch {
      // ignore partial tail lines
    }
  }
  return undefined;
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== expectedPath) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (req.headers["x-work-gateway-token"] !== "local-dev") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "gateway token required" }));
    return;
  }

  const operationId = String(req.headers["x-work-operation-id"] ?? "missing");
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    const streaming = Boolean(body.stream);
    if (streaming && provider !== "doubao") {
      body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    }
    const payload = JSON.stringify(body);
    const meta = {
      provider,
      operationId,
      model: body.model,
      stream: streaming,
      messages: Array.isArray(body.messages)
        ? body.messages.length
        : Array.isArray(body.input)
          ? body.input.length
          : 0,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      toolChoice: body.tool_choice ?? null,
    };
    const started = Date.now();

    const upstream = https.request(
      upstreamUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: streaming ? "text/event-stream" : "application/json",
          "accept-encoding": "identity",
          authorization: `Bearer ${apiKey}`,
          "content-length": Buffer.byteLength(payload),
        },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, {
          "content-type": upstreamRes.headers["content-type"] ?? "application/json",
        });
        let bytes = 0;
        let tail = "";
        upstreamRes.on("data", (chunk) => {
          bytes += chunk.length;
          tail = `${tail}${chunk.toString("utf8")}`.slice(-65536);
          res.write(chunk);
        });
        upstreamRes.on("end", () => {
          appendJsonl(logFile, {
            ...meta,
            status: upstreamRes.statusCode,
            latencyMs: Date.now() - started,
            bytes,
            usage: extractUsage(tail, streaming),
          });
          res.end();
        });
      },
    );

    upstream.on("error", (error) => {
      appendJsonl(logFile, {
        ...meta,
        status: "network_error",
        latencyMs: Date.now() - started,
        error: String(error).slice(0, 200),
      });
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream unavailable" }));
    });

    upstream.end(payload);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`GATEWAY_READY ${port}`);
});
