import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { ensureDir, newRunDir, readJsonl } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const secretFile = path.resolve(here, "../../../we-meet/src/helm/env.d/aliyun-prod/values.secrets.yaml");
const provider = process.env.H02_PROVIDER ?? "qwen";
const modelId =
  process.env.H02_MODEL_ID ??
  (provider === "deepseek"
    ? "deepseek-chat"
    : provider === "doubao"
      ? "doubao-seed-2-1-lite-260915"
      : "qwen3.8-flash");
const expectReasoning = provider !== "deepseek";

function readApiKey() {
  const code =
    'import sys,yaml;d=yaml.safe_load(open(sys.argv[1],encoding="utf-8"));print(d["agentAIAssistant"]["envVars"]["DASHSCOPE_API_KEY"])';
  const value = execFileSync("python", ["-c", code, secretFile], {
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  }).trim();
  if (!value) throw new Error("DASHSCOPE_API_KEY not found in secret file");
  return value;
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("gateway did not become ready")), timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("GATEWAY_READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gateway exited early: ${code}`));
    });
  });
}

const runDir = newRunDir(here, `h02-${provider}`);
ensureDir(runDir);
const gatewayLog = path.join(runDir, "gateway.jsonl");
const netLog = path.join(runDir, "runtime-net.jsonl");
const resultFile = path.join(runDir, "runtime-result.json");
const port = await freePort();
const apiKey =
  provider === "deepseek"
    ? process.env.DEEPSEEK_API_KEY
    : provider === "doubao"
      ? process.env.DOUBAO_API_KEY
      : readApiKey();
if (!apiKey) throw new Error(`missing API key for provider ${provider}`);

const gateway = spawn(process.execPath, [path.join(here, "h02-gateway.mjs")], {
  env: {
    ...process.env,
    H02_PROVIDER: provider,
    H02_UPSTREAM_KEY: apiKey,
    H02_PORT: String(port),
    H02_GATEWAY_LOG: gatewayLog,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gatewayStderr = "";
gateway.stderr.on("data", (chunk) => {
  gatewayStderr += chunk.toString("utf8");
  if (gatewayStderr.length > 4000) gatewayStderr = gatewayStderr.slice(-4000);
});

const summary = { experiment: "H02", provider, modelId, runDir, port, checks: [] };
function check(name, ok, detail) {
  summary.checks.push({ name, ok, detail });
  if (!ok) process.exitCode = 1;
}

try {
  await waitForReady(gateway, 15_000);

  const runtimeEnv = {
    ...process.env,
    H02_PORT: String(port),
    H02_PROVIDER: provider,
    H02_MODEL_ID: modelId,
    H02_RESULT: resultFile,
    H02_NET_LOG: netLog,
    H02_INTERNAL_TOKEN: "local-dev",
  };
  delete runtimeEnv.DASHSCOPE_API_KEY;
  delete runtimeEnv.DEEPSEEK_API_KEY;
  delete runtimeEnv.DOUBAO_API_KEY;
  const runtime = spawn(process.execPath, [path.join(here, "h02-runtime.mjs")], {
    env: runtimeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let runtimeStdout = "";
  let runtimeStderr = "";
  runtime.stdout.on("data", (chunk) => (runtimeStdout += chunk.toString("utf8")));
  runtime.stderr.on("data", (chunk) => (runtimeStderr += chunk.toString("utf8")));
  const exitCode = await Promise.race([
    once(runtime, "exit").then(([code]) => code),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 150_000)),
  ]);
  if (exitCode === "timeout") runtime.kill();

  check("runtime-exit", exitCode === 0, { exitCode, stderr: runtimeStderr.slice(-1500) });

  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : null;
  check("runtime-has-no-api-key", result?.hasDashscopeKey === false, result?.hasDashscopeKey);

  const textCase = result?.cases?.find((c) => c.name === "text");
  const toolCase = result?.cases?.find((c) => c.name === "tool");
  check("text-streamed", Boolean(textCase && textCase.textDeltas > 0), {
    textDeltas: textCase?.textDeltas,
    thinkingChars: textCase?.thinkingChars,
    finalText: textCase?.finalText,
  });
  check("text-content", /PONG/i.test(textCase?.finalText ?? ""), textCase?.finalText);
  check(
    "reasoning-separated",
    !expectReasoning ||
      ((textCase?.thinkingChars ?? 0) > 0 && !/We need|respond to user|Ensure final/i.test(textCase?.finalText ?? "")),
    { thinkingChars: textCase?.thinkingChars, finalText: textCase?.finalText },
  );
  check("tool-called", (toolCase?.toolExecutions ?? []).includes("get_time"), toolCase?.toolExecutions);
  check("tool-final-answer", /2026/.test(toolCase?.finalText ?? ""), toolCase?.finalText);
  check("tool-turn-count", toolCase?.modelCalls === 2, toolCase?.modelCalls);

  const entries = readJsonl(gatewayLog);
  const opIds = entries.map((entry) => entry.operationId);
  check("gateway-request-count", entries.length === 3, entries.map((e) => ({ opId: e.operationId, status: e.status })));
  check("gateway-all-200", entries.every((entry) => entry.status === 200), entries.map((e) => e.status));
  check(
    "gateway-operation-ids",
    opIds.join(",") ===
      `h02-${provider}-text:m:1,h02-${provider}-tool:m:1,h02-${provider}-tool:m:2`,
    opIds,
  );
  check(
    "gateway-provider-model",
    entries.every((entry) => entry.provider === provider && entry.model === modelId),
    entries.map((e) => ({ provider: e.provider, model: e.model })),
  );
  check("gateway-usage-present", entries.every((entry) => Boolean(entry.usage)), entries.map((e) => e.usage ?? null));
  const reasoningTokens = (usage) =>
    usage?.completion_tokens_details?.reasoning_tokens ??
    usage?.output_tokens_details?.reasoning_tokens ??
    0;
  check(
    "reasoning-usage-reported",
    !expectReasoning || entries.some((entry) => reasoningTokens(entry.usage) > 0),
    entries.map((e) => e.usage?.completion_tokens_details ?? e.usage?.output_tokens_details ?? null),
  );
  const gatewayText = fs.readFileSync(gatewayLog, "utf8");
  check("gateway-log-has-no-key", !gatewayText.includes(apiKey) && !/authorization/i.test(gatewayText), true);

  const netEntries = readJsonl(netLog).filter((entry) => entry.type === "net");
  const nonLocal = netEntries.filter((entry) => {
    const host = entry.detail?.host;
    return host !== undefined && host !== "127.0.0.1" && host !== "localhost";
  });
  check("runtime-no-direct-provider-egress", nonLocal.length === 0, nonLocal);
  check("runtime-used-gateway", netEntries.some((entry) => String(entry.detail?.port) === String(port) || entry.detail?.host === "127.0.0.1"), netEntries.length);

  summary.result = {
    text: { finalText: textCase?.finalText, textDeltas: textCase?.textDeltas, thinkingChars: textCase?.thinkingChars, usage: textCase?.usage },
    tool: { finalText: toolCase?.finalText, toolExecutions: toolCase?.toolExecutions, modelCalls: toolCase?.modelCalls, usage: toolCase?.usage },
    gateway: entries,
    runtimeNetTargets: netEntries.map((e) => e.detail),
  };
} finally {
  gateway.kill();
}

fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
