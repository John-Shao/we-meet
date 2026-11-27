import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createEgressServer, documentHash } from "./h02-egress.mjs";
import { documentHash as authoritativeDocumentHash } from "../work-r0a-orchestration-2026-10-25/runtime-recovery.model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("H02 refuses the production secret file without explicit authorization", () => {
  const productionSecret = path.resolve(here, "../../../../src/helm/env.d/aliyun-prod/values.secrets.yaml");
  for (const script of ["h02.mjs", "h02-supervisor.mjs"]) {
    for (const explicit of [false, true]) {
      const env = { ...process.env, H02_PROVIDER: "qwen" };
      delete env.H02_ALLOW_PRODUCTION_SECRET;
      if (explicit) env.H02_SECRET_FILE = productionSecret;
      else delete env.H02_SECRET_FILE;
      const result = spawnSync(process.execPath, [path.join(here, script)], {
        cwd: here, env, encoding: "utf8", timeout: 10_000,
      });
      assert.notEqual(result.status, 0, `${script} explicit=${explicit}`);
      assert.match(result.stderr, /H02_SECRET_FILE is required|production secret file requires explicit/, script);
    }
  }
});

test("H02 egress rejects an oversized capability request without calling upstream", { timeout: 10000 }, async (t) => {
  let upstreamCalls = 0;
  const gateway = createServer((req, res) => {
    upstreamCalls += 1;
    req.resume();
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const bundle = {
    executionId: "11111111-1111-4111-8111-111111111111",
    document: {
      kind: "model_request",
      schemaVersion: "work-model-request-v1",
      route: { model: "qwen-fixture" },
      parameters: { maxOutputTokens: 128 },
    },
    input: "PONG",
    template: "Reply exactly.",
  };
  const logFile = path.join(tmpdir(), `h02-egress-${process.pid}.jsonl`);
  t.after(() => rm(logFile, { force: true }));
  const egress = await createEgressServer({
    gatewayUrl: `http://127.0.0.1:${gateway.address().port}`,
    token: "scoped-token",
    bundle,
    logFile,
  });
  t.after(() => egress.close());
  const response = await new Promise((resolve, reject) => {
    const req = request(egress.baseUrl + "/runtime/v1/model/invoke", {
      method: "POST",
      headers: {
        authorization: "Bearer scoped-token",
        "content-type": "application/json",
        "content-length": 17 * 1024,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end("x".repeat(17 * 1024));
  });
  assert.equal(response.status, 413);
  assert.deepEqual(JSON.parse(response.body), { code: "request_too_large" });
  assert.equal(upstreamCalls, 0);

  const malformed = await new Promise((resolve, reject) => {
    const req = request(egress.baseUrl + "/runtime/v1/model/invoke", {
      method: "POST",
      headers: { authorization: "Bearer scoped-token", "content-type": "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end("null");
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(JSON.parse(malformed.body), { code: "invalid_request" });
  assert.equal(upstreamCalls, 0);
  assert.equal(documentHash(bundle.document), authoritativeDocumentHash(bundle.document));
});

test("H02 egress bounds a hung upstream call", { timeout: 10000 }, async (t) => {
  const gateway = createServer((req, res) => { req.resume(); });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const bundle = {
    executionId: "11111111-1111-4111-8111-111111111111",
    document: {
      kind: "model_request",
      schemaVersion: "work-model-request-v1",
      route: { model: "qwen-fixture" },
      parameters: { maxOutputTokens: 128 },
    },
    input: "PONG",
    template: "Reply exactly.",
  };
  const logFile = path.join(tmpdir(), `h02-egress-timeout-${process.pid}.jsonl`);
  t.after(() => rm(logFile, { force: true }));
  const egress = await createEgressServer({
    gatewayUrl: `http://127.0.0.1:${gateway.address().port}`,
    token: "scoped-token",
    bundle,
    logFile,
    upstreamTimeoutMs: 100,
  });
  t.after(() => egress.close());
  const hash = documentHash(bundle.document);
  const response = await new Promise((resolve, reject) => {
    const req = request(egress.baseUrl + "/runtime/v1/model/invoke", {
      method: "POST",
      headers: { authorization: "Bearer scoped-token", "content-type": "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({
      executionId: bundle.executionId,
      requestHash: hash,
      requestRef: { refId: "88888888-8888-4888-8888-888888888888", hash },
    }));
  });
  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(response.body), { code: "upstream_unavailable" });
});

test("H02 egress uses the Responses request shape for Doubao", { timeout: 10000 }, async (t) => {
  const upstreamRequests = [];
  const gateway = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamRequests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ response: { usage: { input_tokens: 7, output_tokens: 1 } } })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const bundle = {
    executionId: "11111111-1111-4111-8111-111111111111",
    document: {
      kind: "model_request",
      schemaVersion: "work-model-request-v1",
      route: { model: "doubao-fixture" },
      parameters: { maxOutputTokens: 8 },
    },
    input: "PONG",
    template: "Reply exactly.",
  };
  const logFile = path.join(tmpdir(), `h02-egress-doubao-${process.pid}.jsonl`);
  t.after(() => rm(logFile, { force: true }));
  const egress = await createEgressServer({
    gatewayUrl: `http://127.0.0.1:${gateway.address().port}`,
    token: "scoped-token",
    bundle,
    provider: "doubao",
    logFile,
  });
  t.after(() => egress.close());
  const hash = documentHash(bundle.document);
  const response = await new Promise((resolve, reject) => {
    const req = request(egress.baseUrl + "/runtime/v1/model/invoke", {
      method: "POST",
      headers: { authorization: "Bearer scoped-token", "content-type": "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({
      executionId: bundle.executionId,
      requestHash: hash,
      requestRef: { refId: "88888888-8888-4888-8888-888888888888", hash },
    }));
  });
  assert.equal(response.status, 200);
  assert.deepEqual(upstreamRequests, [{
    path: "/v1/responses",
    body: {
      model: "doubao-fixture",
      stream: true,
      input: [
        { role: "system", content: "Reply exactly." },
        { role: "user", content: [{ type: "input_text", text: "PONG" }] },
      ],
      max_output_tokens: 16,
      store: false,
    },
  }]);
});

test("H02 production supervisor chain completes against an isolated provider fixture", { timeout: 40000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "h02-supervisor-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const upstreamRequests = [];
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamRequests.push({
        path: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "fixture-1", choices: [{ delta: { content: "PONG" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "fixture-1", choices: [], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const secretFile = path.join(directory, "provider.secret.yaml");
  await writeFile(secretFile, 'agentAIAssistant:\n  envVars:\n    DASHSCOPE_API_KEY: "fixture-provider-key"\n');

  const child = spawn(process.execPath, [path.join(here, "h02-supervisor.mjs")], {
    cwd: here,
    env: {
      ...process.env,
      H02_PROVIDER: "qwen",
      H02_MODEL_ID: "qwen-fixture",
      H02_SECRET_FILE: secretFile,
      H02_UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}/compatible-mode/v1/chat/completions`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("H02 supervisor timed out")); }, 35000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
    child.on("error", reject);
  });
  assert.equal(exitCode, 0, `${stderr}\n${stdout}`);
  const summaryField = stdout.lastIndexOf('"experiment"');
  const summaryStart = stdout.lastIndexOf('{', summaryField);
  assert.notEqual(summaryStart, -1, stdout);
  const summary = JSON.parse(stdout.slice(summaryStart));
  assert.equal(summary.checks.every((check) => check.ok), true, JSON.stringify(summary));
  assert.equal(summary.result.status, "completed");
  assert.equal(summary.result.outcome.state, "CHECKPOINTED");
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].authorization, "Bearer fixture-provider-key");
  assert.equal(upstreamRequests[0].body.model, "qwen-fixture");
  assert.deepEqual(upstreamRequests[0].body.messages, [
    { role: "system", content: "You are a protocol test client. Follow instructions exactly." },
    { role: "user", content: "Reply with exactly one word: PONG" },
  ]);
  assert.deepEqual(upstreamRequests[0].body.stream_options, { include_usage: true });
  assert.match(summary.result.outcome.receipt.refId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(summary.result.outcome.receipt.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(stdout.includes("fixture-provider-key"), false);
  assert.equal(stderr.includes("fixture-provider-key"), false);
});
