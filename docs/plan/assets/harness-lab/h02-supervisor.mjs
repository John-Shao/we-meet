import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { Supervisor } from "../../../../src/work/node/src/supervisor.mjs";
import { createEgressServer, documentHash } from "./h02-egress.mjs";
import { ensureDir, newRunDir, readJsonl } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const provider = process.env.H02_PROVIDER ?? "qwen";
const modelId = process.env.H02_MODEL_ID ??
  (provider === "deepseek" ? "deepseek-chat" : provider === "doubao" ? "doubao-seed-2-1-lite-260915" : "qwen3.8-flash");
const defaultSecretFile = path.resolve(here, "../../../../src/helm/env.d/aliyun-prod/values.secrets.yaml");
const secretFile = process.env.H02_SECRET_FILE ?? defaultSecretFile;
function canonicalPath(file) {
  const resolved = path.resolve(file);
  let canonical = resolved;
  try { canonical = fs.realpathSync.native(resolved); } catch {}
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

if (provider === "qwen" && canonicalPath(secretFile) === canonicalPath(defaultSecretFile) &&
    process.env.H02_ALLOW_PRODUCTION_SECRET !== "1") {
  throw new Error(process.env.H02_SECRET_FILE
    ? "The production secret file requires explicit H02_ALLOW_PRODUCTION_SECRET=1 authorization"
    : "H02_SECRET_FILE is required; production secret access needs explicit H02_ALLOW_PRODUCTION_SECRET=1");
}

function readApiKey() {
  if (provider === "deepseek") return process.env.DEEPSEEK_API_KEY;
  if (provider === "doubao") return process.env.DOUBAO_API_KEY;
  const code = 'import sys,yaml;d=yaml.safe_load(open(sys.argv[1],encoding="utf-8"));print(d["agentAIAssistant"]["envVars"]["DASHSCOPE_API_KEY"])';
  return execFileSync("python", ["-c", code, secretFile], {
    encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf8" },
  }).trim();
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
      if (buffer.includes("GATEWAY_READY")) { clearTimeout(timer); resolve(); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`gateway exited early: ${code}`)); });
  });
}

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

const runDir = newRunDir(here, `h02-supervisor-${provider}`);
ensureDir(runDir);
const gatewayLog = path.join(runDir, "gateway.jsonl");
const egressLog = path.join(runDir, "egress.jsonl");
const resultFile = path.join(runDir, "runtime-result.json");
const port = await freePort();
const apiKey = readApiKey();
if (!apiKey) throw new Error(`missing API key for provider ${provider}`);

const gateway = spawn(process.execPath, [path.join(here, "h02-gateway.mjs")], {
  env: { ...process.env, H02_PROVIDER: provider, H02_UPSTREAM_KEY: apiKey, H02_PORT: String(port), H02_GATEWAY_LOG: gatewayLog },
  stdio: ["ignore", "pipe", "pipe"],
});
let egress;
let supervisor;
const summary = { experiment: "H02_SUPERVISOR", provider, modelId, runDir, checks: [] };
function check(name, ok, detail) {
  summary.checks.push({ name, ok, detail });
  if (!ok) process.exitCode = 1;
}

try {
  await waitForReady(gateway, 15_000);
  const executionId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const taskId = "33333333-3333-4333-8333-333333333333";
  const snapshotId = "44444444-4444-4444-8444-444444444444";
  const operationId = "55555555-5555-4555-8555-555555555555";
  const attemptId = "66666666-6666-4666-8666-666666666666";
  const checkpointId = "77777777-7777-4777-8777-777777777777";
  const requestId = "88888888-8888-4888-8888-888888888888";
  const inputId = "99999999-9999-4999-8999-999999999999";
  const templateId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const input = "Reply with exactly one word: PONG";
  const template = "You are a protocol test client. Follow instructions exactly.";
  const document = {
    kind: "model_request",
    schemaVersion: "work-model-request-v1",
    binding: { orgId: "org_h02", taskId, runId, snapshotId, runtimeVersion: "h02-supervisor-v1" },
    logicalKey: "model:1",
    input: { refId: inputId, hash: sha256(input) },
    template: { refId: templateId, hash: sha256(template) },
    priorReceipts: [],
    route: { provider, model: modelId, configRevision: "1", compatProfileVersion: "v1" },
    parameters: { maxOutputTokens: 128, temperatureMilli: 0, outputFormat: "text" },
  };
  const requestHash = documentHash(document);
  const bundle = { executionId, document, input, template };
  const bundleFile = path.join(runDir, "request-bundle.json");
  fs.writeFileSync(bundleFile, JSON.stringify(bundle));
  egress = await createEgressServer({
    gatewayUrl: `http://127.0.0.1:${port}`,
    token: "h02-egress-token",
    bundle,
    provider,
    logFile: egressLog,
  });
  supervisor = new Supervisor({
    maxConcurrent: 1,
    runtimeVersion: "h02-supervisor-v1",
    startTimeoutMs: 10_000,
    runTimeoutMs: 120_000,
    killGraceMs: 1000,
  });
  const result = await supervisor.start({
    runId,
    fence: "1",
    holderId: "h02-supervisor",
    capabilities: {
      egress: {
        baseUrl: egress.baseUrl,
        token: "h02-egress-token",
        generation: 1,
        expiresAt: Date.now() + 60_000,
      },
    },
    payload: {
      kind: "advance_request",
      contractVersion: "work-runtime-fragment-v1",
      executionId, runId, taskId,
      orgId: "org_h02",
      snapshotId,
      runtimeVersion: "h02-supervisor-v1",
      fence: "1",
      deadlineUnixMs: Date.now() + 90_000,
      mode: "execute",
      checkpoint: { refId: checkpointId, hash: sha256("checkpoint") },
      intent: { request: { refId: requestId, hash: requestHash }, requestHash, logicalKey: "model:1" },
      permit: { operationId, dispatchAttemptId: attemptId, requestHash },
    },
  });
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  check("runtime-completed", result.status === "completed" && result.exitCode === 0, result);
  check("runtime-checkpointed", result.outcome?.state === "CHECKPOINTED", result.outcome);
  const receipt = result.outcome?.receipt;
  check("checkpoint-receipt",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(receipt?.refId ?? "") &&
    /^sha256:[0-9a-f]{64}$/.test(receipt?.hash ?? ""), receipt);
  check("one-egress-call", egress.requests.length === 1, egress.requests);
  check("egress-200", egress.requests[0]?.status === 200, egress.requests[0]?.status);
  const entries = readJsonl(gatewayLog);
  check("one-provider-call", entries.length === 1, entries);
  check("provider-200", entries[0]?.status === 200, entries[0]?.status);
  check("provider-model", entries.every((entry) => entry.provider === provider && entry.model === modelId),
    entries.map((entry) => ({ provider: entry.provider, model: entry.model })));
  check("usage-present", Boolean(entries[0]?.usage), entries[0]?.usage);
  const egressEntries = readJsonl(egressLog);
  check("egress-usage-normalized",
    egressEntries[0]?.usage?.source === "provider" &&
    Number.isSafeInteger(egressEntries[0]?.usage?.inputTokens) &&
    Number.isSafeInteger(egressEntries[0]?.usage?.outputTokens), egressEntries[0]?.usage);
  check("no-key-in-artifacts", fs.readdirSync(runDir).every((name) =>
    !fs.readFileSync(path.join(runDir, name), "utf8").includes(apiKey)), true);
  summary.result = result;
  summary.gateway = entries;
  summary.egress = egress.requests;
} finally {
  await supervisor?.shutdown({ force: true });
  await egress?.close();
  gateway.kill();
}

fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (process.exitCode) process.exit(process.exitCode);
