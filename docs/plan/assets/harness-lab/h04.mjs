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
  reconcileModelOps,
  toolResultFromState,
} from "./lib/driver.mjs";
import { appendJsonl, ensureDir, newRunDir, readJsonl, writeJsonAtomic } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const testCase = process.env.H04_CASE;
const step = process.env.H04_STEP;
const runDir = process.env.H04_RUN_DIR;

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

function initState(dir, label) {
  writeJsonAtomic(path.join(dir, "state.json"), {
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
    reservations: [],
  });
}

function toolAndCall(caseName) {
  return {
    toolName: caseName === "u2" ? "write_file_lost_receipt" : "write_file",
  };
}

function singleToolResponse(toolName) {
  return fauxAssistantMessage([fauxToolCall(toolName, { note: "x" }, { id: "call-x" })]);
}

function journalKeyFor(state) {
  const assistant = lastAssistant(state);
  assert.ok(assistant, "assistant message must be persisted");
  const [tc] = assistantToolCalls(assistant);
  assert.ok(tc, "assistant must request one tool");
  return { key: state.toolKeys[tc.id], toolCall: tc };
}

async function dispatchManually(state, journalPath, key, toolCall, tool) {
  appendJsonl(journalPath, { event: "tool_started", key, tool: toolCall.name, args: toolCall.arguments });
  const result = await tool.execute(toolCall.id, toolCall.arguments);
  appendJsonl(journalPath, {
    event: "tool_completed",
    key,
    tool: toolCall.name,
    content: result.content,
    details: result.details,
    isError: false,
  });
  state.toolOps[key].state = "executed";
  state.toolOps[key].receipt = { content: result.content, details: result.details, isError: false };
  state.status = "running";
  writeJsonAtomic(path.join(runDir, "state.json"), state);
}

if (testCase === "u1" && step === "run") {
  const execLog = path.join(runDir, "executions.jsonl");
  const { faux, models, model } = setupModels([
    fauxAssistantMessage([fauxText("partial output before disconnect")], {
      stopReason: "error",
      errorMessage: "ECONNRESET after provider accepted the request",
    }),
  ]);
  const driver = createDriver({
    runDir,
    models,
    model,
    systemPrompt: "H04 U1",
    tools: [makeTool("write_file", execLog)],
    label: "h04-u1",
  });
  driver.state.reservations = [{ opKey: "m:1", amount: 120, state: "held" }];
  driver.save();
  await driver.prompt("call the model");
  const summary = {
    case: "u1",
    fauxCalls: faux.state.callCount,
    status: driver.state.status,
    modelOps: driver.state.modelOps,
    reservations: driver.state.reservations,
    executions: readJsonl(execLog).length,
  };
  assert.equal(faux.state.callCount, 1, "must not retry a charged model call");
  assert.equal(driver.state.status, "waiting_reconcile");
  assert.equal(driver.state.modelOps["m:1"].state, "unknown");
  assert.equal(driver.state.reservations[0].state, "held", "unknown must keep its budget reservation");
  console.log(JSON.stringify(summary));
  process.exit(0);
}

if (testCase === "u2" && step === "crash") {
  const execLog = path.join(runDir, "executions.jsonl");
  const { models, model } = setupModels([
    singleToolResponse("write_file_lost_receipt"),
    fauxAssistantMessage("never reached"),
  ]);
  const driver = createDriver({
    runDir,
    models,
    model,
    systemPrompt: "H04 U2",
    tools: [makeTool("write_file_lost_receipt", execLog)],
    killAfterToolCompleted: true,
    label: "h04-u2",
  });
  await driver.prompt("write then lose receipt");
  console.log("unexpected survival");
  process.exit(0);
}

if (testCase === "u2" && step === "resume") {
  const execLog = path.join(runDir, "executions.jsonl");
  const { state, journal } = loadRun(runDir);
  reconcile(state, journal);
  const { key, toolCall } = journalKeyFor(state);
  const op = state.toolOps[key];
  assert.equal(op.state, "executed", "completed journal must recover the receipt");
  assert.equal(op.recoveredFrom, "journal_completed");
  const execBefore = readJsonl(execLog).length;
  assert.equal(execBefore, 1, "side effect happened once in phase 1");

  const toolResults = [toolResultFromState(state, toolCall)].filter(Boolean);
  assert.equal(toolResults.length, 1);
  const { faux, models, model } = setupModels([fauxAssistantMessage("resumed after lost receipt")]);
  const driver = createDriver({
    runDir,
    models,
    model,
    systemPrompt: "H04 U2",
    tools: [makeTool("write_file_lost_receipt", execLog)],
    restoredMessages: [...state.messages, ...toolResults],
    label: "h04-u2",
  });
  await driver.continueRun();
  const execAfter = readJsonl(execLog).length;
  assert.equal(execAfter, 1, "recovered receipt must not re-run the tool");
  assert.equal(driver.state.status, "finished");
  assert.equal(faux.state.callCount, 1);
  console.log(
    JSON.stringify({
      case: "u2",
      executions: execAfter,
      recoveredFrom: op.recoveredFrom,
      status: driver.state.status,
      finalText: driver.state.finalText,
      fauxCalls: faux.state.callCount,
    }),
  );
  process.exit(0);
}

if (testCase === "u3" && step === "crash") {
  const execLog = path.join(runDir, "executions.jsonl");
  const { models, model } = setupModels([singleToolResponse("write_file"), fauxAssistantMessage("never reached")]);
  const driver = createDriver({
    runDir,
    models,
    model,
    systemPrompt: "H04 U3",
    tools: [makeTool("write_file", execLog)],
    killBeforeToolExecute: true,
    label: "h04-u3",
  });
  await driver.prompt("crash before dispatch");
  console.log("unexpected survival");
  process.exit(0);
}

if (testCase === "u3" && step === "resume") {
  const execLog = path.join(runDir, "executions.jsonl");
  const { state, journal } = loadRun(runDir);
  reconcile(state, journal);
  const { key, toolCall } = journalKeyFor(state);
  assert.equal(state.toolOps[key].state, "dispatch_intent", "no journal means dispatch may proceed");
  assert.equal(readJsonl(execLog).length, 0);
  await dispatchManually(state, path.join(runDir, "journal.jsonl"), key, toolCall, makeTool("write_file", execLog));
  const toolResults = [toolResultFromState(state, toolCall)].filter(Boolean);
  const { faux, models, model } = setupModels([fauxAssistantMessage("resumed after pre-dispatch crash")]);
  const driver = createDriver({
    runDir,
    models,
    model,
    systemPrompt: "H04 U3",
    tools: [makeTool("write_file", execLog)],
    restoredMessages: [...state.messages, ...toolResults],
    label: "h04-u3",
  });
  await driver.continueRun();
  assert.equal(readJsonl(execLog).length, 1, "undispatched op executes exactly once");
  assert.equal(driver.state.status, "finished");
  console.log(
    JSON.stringify({
      case: "u3",
      executions: readJsonl(execLog).length,
      status: driver.state.status,
      finalText: driver.state.finalText,
      fauxCalls: faux.state.callCount,
    }),
  );
  process.exit(0);
}

if (testCase === "u4" && step === "crash") {
  const execLog = path.join(runDir, "executions.jsonl");
  const { models, model } = setupModels([fauxAssistantMessage("charged response never checkpointed")]);
  const driver = createDriver({
    runDir,
    models,
    model,
    systemPrompt: "H04 U4",
    tools: [makeTool("write_file", execLog)],
    killAfterModelMessage: true,
    label: "h04-u4",
  });
  await driver.prompt("charged then crash before checkpoint");
  console.log("unexpected survival");
  process.exit(0);
}

if (testCase === "u4" && step === "resume") {
  const execLog = path.join(runDir, "executions.jsonl");
  const { state } = loadRun(runDir);
  reconcileModelOps(state);
  writeJsonAtomic(path.join(runDir, "state.json"), state);
  const summary = {
    case: "u4",
    status: state.status,
    modelOps: state.modelOps,
    messages: state.messages.length,
    executions: readJsonl(execLog).length,
  };
  assert.equal(state.modelOps["m:1"].state, "unknown");
  assert.equal(state.modelOps["m:1"].recoveredFrom, "no_response_receipt");
  assert.equal(state.status, "waiting_reconcile");
  assert.equal(state.messages.filter((m) => m.role === "assistant").length, 0);
  assert.equal(readJsonl(execLog).length, 0);
  console.log(JSON.stringify(summary));
  process.exit(0);
}

if (testCase === "u5" && step === "crash") {
  const execLog = path.join(runDir, "executions.jsonl");
  const { models, model } = setupModels([singleToolResponse("write_file"), fauxAssistantMessage("never reached")]);
  const driver = createDriver({
    runDir,
    models,
    model,
    systemPrompt: "H04 U5",
    tools: [makeTool("write_file", execLog, { exitInside: true })],
    label: "h04-u5",
  });
  await driver.prompt("crash inside tool");
  console.log("unexpected survival");
  process.exit(0);
}

if (testCase === "u5" && step === "resume") {
  const execLog = path.join(runDir, "executions.jsonl");
  const { state, journal } = loadRun(runDir);
  reconcile(state, journal);
  writeJsonAtomic(path.join(runDir, "state.json"), state);
  const { key } = journalKeyFor(state);
  const op = state.toolOps[key];
  const summary = {
    case: "u5",
    status: state.status,
    opState: op.state,
    recoveredFrom: op.recoveredFrom,
    hasReceipt: Boolean(op.receipt),
    executions: readJsonl(execLog).length,
  };
  assert.equal(op.state, "unknown", "started-only journal cannot be treated as completed");
  assert.equal(op.receipt, undefined, "no synthetic success receipt");
  assert.equal(readJsonl(execLog).length, 1, "external side effect may have happened once");
  assert.equal(state.status, "waiting_reconcile");
  console.log(JSON.stringify(summary));
  process.exit(0);
}

// Orchestrator
function runChild(name, env, expectedExit = 0) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  const record = {
    name,
    exit: child.status,
    signal: child.signal,
    stdout: child.stdout.trim(),
    stderr: child.stderr.trim(),
  };
  const ok = child.status === expectedExit;
  if (!ok) {
    console.error(`FAIL ${name} expected exit ${expectedExit}, got ${child.status}\n${child.stdout}\n${child.stderr}`);
    process.exitCode = 1;
  }
  return record;
}

const summary = { experiment: "H04", cases: [] };
function runCase(caseName, crashStep, resumeStep) {
  const dir = newRunDir(here, `h04-${caseName}`);
  initState(dir, `h04-${caseName}`);
  const records = [];
  if (crashStep === "run") {
    records.push(runChild(`${caseName}-run`, { H04_CASE: caseName, H04_STEP: "run", H04_RUN_DIR: dir }, 0));
  } else {
    records.push(runChild(`${caseName}-${crashStep}`, { H04_CASE: caseName, H04_STEP: crashStep, H04_RUN_DIR: dir }, 137));
    records.push(runChild(`${caseName}-${resumeStep}`, { H04_CASE: caseName, H04_STEP: resumeStep, H04_RUN_DIR: dir }, 0));
  }
  summary.cases.push({ case: caseName, dir, records });
}

ensureDir(path.join(here, "runs"));
runCase("u1", "run", null);
runCase("u2", "crash", "resume");
runCase("u3", "crash", "resume");
runCase("u4", "crash", "resume");
runCase("u5", "crash", "resume");

fs.writeFileSync(path.join(here, "runs", "h04-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
