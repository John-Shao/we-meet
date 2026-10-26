import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  assistantToolCalls,
  createDriver,
  lastAssistant,
  loadRun,
  reconcile,
  toolResultFromState,
} from "./lib/driver.mjs";
import { appendJsonl, ensureDir, newRunDir, readJsonl, writeJsonAtomic } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const phase = process.env.H03_PHASE;

function setupModels(responses) {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { faux, models, model: faux.getModel() };
}

function makeTool(name, execLog, { exitInside = false } = {}) {
  return {
    name,
    label: name,
    description: `test tool ${name}`,
    parameters: Type.Object({ note: Type.String() }),
    execute: async (_toolCallId, params) => {
      appendJsonl(execLog, { tool: name, params, pid: process.pid });
      if (exitInside) process.exit(137);
      return { content: [{ type: "text", text: `${name} completed` }], details: { tool: name } };
    },
  };
}

function initState(runDir, label) {
  writeJsonAtomic(path.join(runDir, "state.json"), {
    runId: label,
    status: "running",
    messages: [],
    modelRequests: 0,
    modelOps: {},
    currentModelOp: null,
    toolSeq: 0,
    toolKeys: {},
    toolOps: {},
    approvals: {},
    executions: 0,
    stopReason: null,
  });
}

function summarize(runDir) {
  const { state } = loadRun(runDir);
  return {
    status: state.status,
    modelRequests: state.modelRequests,
    modelOps: state.modelOps,
    toolOps: state.toolOps,
    finalText: state.finalText,
  };
}

if (phase === "1") {
  const runDir = process.env.H03_RUN_DIR;
  const execLog = path.join(runDir, "executions.jsonl");
  const { faux, models, model } = setupModels([
    fauxAssistantMessage([
      fauxToolCall("echo_a", { note: "a" }, { id: "call-a" }),
      fauxToolCall("echo_b", { note: "b" }, { id: "call-b" }),
      fauxToolCall("echo_c", { note: "c" }, { id: "call-c" }),
    ]),
    fauxAssistantMessage("model continued unexpectedly"),
  ]);
  const driver = createDriver({
    runDir,
    models,
    model,
    systemPrompt: "H03 experiment",
    tools: [makeTool("echo_a", execLog), makeTool("echo_b", execLog), makeTool("echo_c", execLog)],
    toolsNeedingApproval: new Set(["echo_b"]),
    label: "h03-phase1",
  });
  await driver.prompt("run three tools");
  await driver.agent.waitForIdle();

  const executions = readJsonl(execLog);
  const summary = {
    phase: 1,
    fauxCalls: faux.state.callCount,
    executions: executions.map((e) => e.tool),
    status: driver.state.status,
    pending: Object.values(driver.state.toolOps).filter((o) => o.state === "waiting_approval"),
    blockedRemainder: Object.values(driver.state.toolOps).filter((o) => o.state === "prepared"),
    modelRequests: driver.state.modelRequests,
    persistedMessages: driver.state.messages.length,
  };
  assert.equal(faux.state.callCount, 1, "phase1 must not request a second model turn");
  assert.deepEqual(executions.map((e) => e.tool), ["echo_a"], "only approved tool runs");
  assert.equal(driver.state.status, "waiting_approval");
  assert.equal(
    summary.blockedRemainder.length,
    1,
    "tool after the approval gate must be blocked, not executed",
  );
  assert.equal(
    driver.state.messages.some((m) => JSON.stringify(m).includes("approval_required")),
    false,
    "blocked placeholder must not be persisted as transcript",
  );
  console.log(JSON.stringify(summary));
  process.exit(0);
}

if (phase === "2") {
  const runDir = process.env.H03_RUN_DIR;
  const execLog = path.join(runDir, "executions.jsonl");
  const { state, journal } = loadRun(runDir);
  reconcile(state, journal);
  const pending = Object.entries(state.toolOps).find(([, op]) => op.state === "waiting_approval");
  assert.ok(pending, "phase1 must leave exactly one pending approval");
  const [pendingKey] = pending;
  state.approvals[pendingKey] = "granted";
  state.status = "running";
  writeJsonAtomic(path.join(runDir, "state.json"), state);

  const assistantMessage = lastAssistant(state);
  const toolsByName = {
    echo_a: makeTool("echo_a", execLog),
    echo_b: makeTool("echo_b", execLog),
    echo_c: makeTool("echo_c", execLog),
  };
  const toolResults = [];
  for (const toolCall of assistantToolCalls(assistantMessage)) {
    const key = state.toolKeys[toolCall.id];
    const op = state.toolOps[key];
    if (op.state === "executed") {
      toolResults.push(toolResultFromState(state, toolCall));
      continue;
    }
    assert.ok(
      op.state === "waiting_approval" || op.state === "prepared",
      `unexpected tool state ${op.state} for ${toolCall.name}`,
    );
    if (op.state === "waiting_approval") {
      assert.equal(state.approvals[key], "granted", "approval must be granted before resume dispatch");
    }
    const journalPath = path.join(runDir, "journal.jsonl");
    appendJsonl(journalPath, {
      event: "tool_started",
      key,
      tool: toolCall.name,
      args: toolCall.arguments,
    });
    const result = await toolsByName[toolCall.name].execute(toolCall.id, toolCall.arguments);
    appendJsonl(journalPath, {
      event: "tool_completed",
      key,
      tool: toolCall.name,
      content: result.content,
      details: result.details,
      isError: false,
    });
    op.state = "executed";
    op.receipt = { content: result.content, details: result.details, isError: false };
    state.status = "running";
    writeJsonAtomic(path.join(runDir, "state.json"), state);
    toolResults.push(toolResultFromState(state, toolCall));
  }
  assert.equal(toolResults.length, 3, "all three tool results must be reconstructable in source order");

  const { faux, models, model } = setupModels([fauxAssistantMessage("final answer after resume")]);
  const driver = createDriver({
    runDir,
    models,
    model,
    systemPrompt: "H03 experiment",
    tools: [makeTool("echo_a", execLog), makeTool("echo_b", execLog), makeTool("echo_c", execLog)],
    toolsNeedingApproval: new Set(["echo_b"]),
    restoredMessages: [...state.messages, ...toolResults],
    label: "h03-phase2",
  });
  await driver.continueRun();

  const executions = readJsonl(execLog);
  const summary = {
    phase: 2,
    fauxCalls: faux.state.callCount,
    executions: executions.map((e) => e.tool),
    status: driver.state.status,
    finalText: driver.state.finalText,
    modelOps: driver.state.modelOps,
  };
  assert.equal(faux.state.callCount, 1, "resume issues exactly one model request");
  assert.deepEqual(
    executions.map((e) => e.tool),
    ["echo_a", "echo_b", "echo_c"],
    "executed tool not re-run; approved gate and remaining batch each execute once",
  );
  assert.equal(driver.state.status, "finished");
  assert.match(driver.state.finalText, /final answer after resume/);
  assert.equal(driver.state.modelOps["m:2"].state, "succeeded");
  console.log(JSON.stringify(summary));
  process.exit(0);
}

if (phase === "terminate-probe") {
  const runDir = process.env.H03_RUN_DIR;
  const execLog = path.join(runDir, "executions.jsonl");
  const { faux, models, model } = setupModels([
    fauxAssistantMessage([
      fauxToolCall("echo_a", { note: "a" }, { id: "call-a" }),
      fauxToolCall("echo_b", { note: "b" }, { id: "call-b" }),
    ]),
    fauxAssistantMessage("model continued despite terminate"),
  ]);
  const driver = createDriver({
    runDir,
    models,
    model,
    systemPrompt: "H03 terminate probe",
    tools: [makeTool("echo_a", execLog), makeTool("echo_b", execLog)],
    toolsNeedingApproval: new Set(["echo_b"]),
    finishTurnEnabled: false,
    label: "h03-terminate",
  });
  await driver.prompt("run two tools");
  await driver.agent.waitForIdle();
  console.log(
    JSON.stringify({
      phase: "terminate-probe",
      fauxCalls: faux.state.callCount,
      executions: readJsonl(execLog).map((e) => e.tool),
      status: driver.state.status,
      finalText: driver.state.finalText,
    }),
  );
  process.exit(0);
}

// Orchestrator
const root = path.resolve(here);
const results = [];

function runPhase(name, env) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  results.push({ name, status: child.status, signal: child.signal, stdout: child.stdout.trim(), stderr: child.stderr.trim() });
  if (child.error || child.status !== 0) {
    console.error(`FAIL ${name}\n${child.stdout}\n${child.stderr}`);
    process.exitCode = 1;
  }
}

const runDir = newRunDir(root, "h03");
ensureDir(runDir);
initState(runDir, "h03");
runPhase("phase1-pause", { H03_PHASE: "1", H03_RUN_DIR: runDir });
runPhase("phase2-resume", { H03_PHASE: "2", H03_RUN_DIR: runDir });

const probeDir = newRunDir(root, "h03-terminate");
initState(probeDir, "h03-terminate");
runPhase("terminate-probe", { H03_PHASE: "terminate-probe", H03_RUN_DIR: probeDir });

fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ experiment: "H03", runDir, results }, null, 2));
