import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { ensureDir, newRunDir, readJson, writeJsonAtomic } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = newRunDir(here, "h10");
ensureDir(base);

const versions = {
  "1.4.0": {
    version: "1.4.0",
    agent: await import("@earendil-works/pi-agent-core"),
    ai: await import("@earendil-works/pi-ai"),
  },
  "1.3.0": {
    version: "1.3.0",
    agent: await import("./h10/v13/node_modules/@earendil-works/pi-agent-core/dist/index.js"),
    ai: await import("./h10/v13/node_modules/@earendil-works/pi-ai/dist/index.js"),
  },
};

function setupModels(modules, responses) {
  const faux = modules.ai.fauxProvider({ tokensPerSecond: 0 });
  const models = modules.ai.createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { faux, models, model: faux.getModel() };
}

function toolsFor(version, effectsFile) {
  const makeTool = (name) => ({
    name,
    label: name,
    description: `write ${name}`,
    parameters: Type.Object({ note: Type.String() }),
    execute: async () => {
      const current = readJson(effectsFile, {});
      current[name] = (current[name] ?? 0) + 1;
      writeJsonAtomic(effectsFile, current);
      return { content: [{ type: "text", text: `${name} committed` }], details: { tool: name } };
    },
  });
  return [makeTool("write_a"), makeTool("write_b")];
}

function emptyState(runId, runtimeVersion) {
  return {
    runId,
    runtimeVersion,
    schemaVersion: 1,
    status: "running",
    messages: [],
    modelRequests: 0,
    toolKeys: {},
    toolOps: {},
    approvals: {},
    approvalHashes: {},
  };
}

async function phase1({ version, runDir, responses }) {
  const modules = versions[version];
  const effectsFile = path.join(runDir, "effects.json");
  const stateFile = path.join(runDir, "state.json");
  const state = emptyState(path.basename(runDir), version);
  const { faux, models, model } = setupModels(modules, responses);
  let toolIndex = 0;
  const agent = new modules.agent.Agent({
    initialState: { systemPrompt: `H10 ${version}`, model, tools: toolsFor(version, effectsFile), messages: [] },
    toolExecution: "sequential",
    streamFn: (m, context, options) => {
      state.modelRequests += 1;
      state.currentModelOp = `m:${state.modelRequests}`;
      state.status = "running";
      writeJsonAtomic(stateFile, state);
      return models.streamSimple(m, context, options);
    },
    beforeToolCall: async (context) => {
      const key = `t:${state.modelRequests}:${toolIndex++}`;
      state.toolKeys[context.toolCall.id] = key;
      state.toolOps[key] = { key, tool: context.toolCall.name, args: context.toolCall.arguments, state: "prepared" };
      if (context.toolCall.name === "write_b" && state.approvals[key] !== "granted") {
        state.status = "waiting_approval";
        state.toolOps[key].state = "waiting_approval";
        state.approvalHashes[key] = JSON.stringify(context.toolCall.arguments);
        writeJsonAtomic(stateFile, state);
        return { block: true, reason: "approval_required", terminate: true };
      }
      state.toolOps[key].state = "dispatch_intent";
      writeJsonAtomic(stateFile, state);
      return undefined;
    },
    afterToolCall: async (context) => {
      const key = state.toolKeys[context.toolCall.id];
      if (context.isError && state.toolOps[key].state === "waiting_approval") return;
      state.toolOps[key].state = "executed";
      state.toolOps[key].receipt = {
        content: context.result.content,
        details: context.result.details,
        isError: context.isError,
      };
      writeJsonAtomic(stateFile, state);
    },
    finishTurn: async () => {
      if (state.status === "waiting_approval") return { action: "end" };
      return undefined;
    },
  });
  agent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      state.messages.push(event.message);
      writeJsonAtomic(stateFile, state);
    }
  });
  await agent.prompt("do two writes");
  await agent.waitForIdle();
  return { state, fauxCalls: faux.state.callCount, effects: readJson(effectsFile, {}) };
}

function isValidRuntime(from, to) {
  const fromMajor = from.split(".")[0];
  const toMajor = to.split(".")[0];
  return fromMajor === toMajor;
}

async function phase2({ version, runDir, responses }) {
  const modules = versions[version];
  const stateFile = path.join(runDir, "state.json");
  const effectsFile = path.join(runDir, "effects.json");
  const state = readJson(stateFile, null);
  assert.ok(state, "checkpoint must exist");
  if (state.schemaVersion !== 1 || !isValidRuntime(state.runtimeVersion, version)) {
    writeJsonAtomic(path.join(runDir, "resume.json"), {
      refused: true,
      error: "checkpoint_incompatible",
      from: state.runtimeVersion,
      to: version,
      schemaVersion: state.schemaVersion,
    });
    return { refused: true, state, effects: readJson(effectsFile, {}) };
  }

  const pending = Object.entries(state.toolOps).find(([, op]) => op.state === "waiting_approval");
  assert.ok(pending, "pending approval must exist");
  const [pendingKey, pendingOp] = pending;
  const expectedHash = state.approvalHashes[pendingKey];
  assert.equal(expectedHash, JSON.stringify(pendingOp.args), "approval hash must not change across versions");
  state.approvals[pendingKey] = "granted";
  state.status = "running";

  const effects = readJson(effectsFile, {});
  const tool = toolsFor(version, effectsFile).find((item) => item.name === pendingOp.tool);
  const toolCallId = Object.keys(state.toolKeys).find((id) => state.toolKeys[id] === pendingKey);
  const result = await tool.execute(toolCallId, pendingOp.args);
  pendingOp.state = "executed";
  pendingOp.receipt = { content: result.content, details: result.details, isError: false };
  writeJsonAtomic(stateFile, state);

  const assistantMessage = [...state.messages].reverse().find((m) => m.role === "assistant");
  const toolCalls = assistantMessage.content.filter((block) => block.type === "toolCall");
  const toolResults = toolCalls.map((call) => {
    const op = state.toolOps[state.toolKeys[call.id]];
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: op.receipt.content,
      details: op.receipt.details ?? {},
      isError: Boolean(op.receipt.isError),
      timestamp: Date.now(),
    };
  });
  assert.equal(toolResults.length, 2);

  const { faux, models, model } = setupModels(modules, responses);
  const agent = new modules.agent.Agent({
    initialState: {
      systemPrompt: `H10 ${version}`,
      model,
      tools: toolsFor(version, effectsFile),
      messages: [...state.messages, ...toolResults],
    },
    toolExecution: "sequential",
    streamFn: (m, context, options) => {
      state.modelRequests += 1;
      state.currentModelOp = `m:${state.modelRequests}`;
      writeJsonAtomic(stateFile, state);
      return models.streamSimple(m, context, options);
    },
  });
  await agent.continue();
  await agent.waitForIdle();
  const last = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
  state.status = "finished";
  writeJsonAtomic(stateFile, state);
  return {
    refused: false,
    fauxCalls: faux.state.callCount,
    finalText: (last.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"),
    effects: readJson(effectsFile, {}),
    approvalHash: expectedHash,
    modelRequests: state.modelRequests,
    from: state.runtimeVersion,
    to: version,
  };
}

const scenarios = [];

// Upgrade 1.3.0 -> 1.4.0
{
  const dir = path.join(base, "upgrade");
  ensureDir(dir);
  const first = await phase1({
    version: "1.3.0",
    runDir: dir,
    responses: [
      versions["1.3.0"].ai.fauxAssistantMessage([
        versions["1.3.0"].ai.fauxToolCall("write_a", { note: "a" }, { id: "call-a" }),
        versions["1.3.0"].ai.fauxToolCall("write_b", { note: "b" }, { id: "call-b" }),
      ]),
    ],
  });
  assert.equal(first.state.status, "waiting_approval");
  assert.deepEqual(first.effects, { write_a: 1 });
  const second = await phase2({
    version: "1.4.0",
    runDir: dir,
    responses: [versions["1.4.0"].ai.fauxAssistantMessage("upgrade resume done")],
  });
  assert.equal(second.refused, false);
  assert.deepEqual(second.effects, { write_a: 1, write_b: 1 });
  assert.equal(second.fauxCalls, 1, "resume issues exactly one model request");
  assert.equal(second.modelRequests, 2);
  assert.match(second.finalText, /upgrade resume done/);
  scenarios.push({ name: "upgrade-1.3-to-1.4", first: { status: first.state.status, effects: first.effects }, second });
}

// Rollback 1.4.0 -> 1.3.0
{
  const dir = path.join(base, "rollback");
  ensureDir(dir);
  const first = await phase1({
    version: "1.4.0",
    runDir: dir,
    responses: [
      versions["1.4.0"].ai.fauxAssistantMessage([
        versions["1.4.0"].ai.fauxToolCall("write_a", { note: "a" }, { id: "call-a" }),
        versions["1.4.0"].ai.fauxToolCall("write_b", { note: "b" }, { id: "call-b" }),
      ]),
    ],
  });
  assert.deepEqual(first.effects, { write_a: 1 });
  const second = await phase2({
    version: "1.3.0",
    runDir: dir,
    responses: [versions["1.3.0"].ai.fauxAssistantMessage("rollback resume done")],
  });
  assert.equal(second.refused, false);
  assert.deepEqual(second.effects, { write_a: 1, write_b: 1 });
  assert.equal(second.fauxCalls, 1);
  assert.match(second.finalText, /rollback resume done/);
  scenarios.push({ name: "rollback-1.4-to-1.3", first: { status: first.state.status, effects: first.effects }, second });
}

// Incompatible schema
{
  const dir = path.join(base, "incompatible-schema");
  ensureDir(dir);
  await phase1({
    version: "1.4.0",
    runDir: dir,
    responses: [
      versions["1.4.0"].ai.fauxAssistantMessage([
        versions["1.4.0"].ai.fauxToolCall("write_a", { note: "a" }, { id: "call-a" }),
        versions["1.4.0"].ai.fauxToolCall("write_b", { note: "b" }, { id: "call-b" }),
      ]),
    ],
  });
  const state = readJson(path.join(dir, "state.json"), null);
  state.schemaVersion = 99;
  writeJsonAtomic(path.join(dir, "state.json"), state);
  const second = await phase2({ version: "1.4.0", runDir: dir, responses: [] });
  assert.equal(second.refused, true);
  assert.deepEqual(second.effects, { write_a: 1 });
  const resume = readJson(path.join(dir, "resume.json"), null);
  assert.equal(resume.error, "checkpoint_incompatible");
  scenarios.push({ name: "incompatible-schema", refused: true, effects: second.effects, error: resume.error });
}

// Incompatible major version
{
  const dir = path.join(base, "incompatible-version");
  ensureDir(dir);
  await phase1({
    version: "1.4.0",
    runDir: dir,
    responses: [
      versions["1.4.0"].ai.fauxAssistantMessage([
        versions["1.4.0"].ai.fauxToolCall("write_a", { note: "a" }, { id: "call-a" }),
        versions["1.4.0"].ai.fauxToolCall("write_b", { note: "b" }, { id: "call-b" }),
      ]),
    ],
  });
  const state = readJson(path.join(dir, "state.json"), null);
  state.runtimeVersion = "0.99.0";
  writeJsonAtomic(path.join(dir, "state.json"), state);
  const second = await phase2({ version: "1.4.0", runDir: dir, responses: [] });
  assert.equal(second.refused, true);
  assert.deepEqual(second.effects, { write_a: 1 });
  scenarios.push({ name: "incompatible-version", refused: true, effects: second.effects });
}

writeJsonAtomic(path.join(base, "summary.json"), { experiment: "H10", base, scenarios });
console.log(JSON.stringify({ experiment: "H10", base, scenarios }, null, 2));
