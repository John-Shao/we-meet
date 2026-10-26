import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { ensureDir, newRunDir, writeJsonAtomic } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runDir = newRunDir(here, "h07");
ensureDir(runDir);
const results = { cases: [] };

function setupModels(responses, tokensPerSecond = 0) {
  const faux = fauxProvider({ tokensPerSecond });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { faux, models, model: faux.getModel() };
}

function controls() {
  return {
    epoch: 0,
    revoked: false,
    leaseExpires: Number.POSITIVE_INFINITY,
    budget: 100,
    effects: {},
    commits: 0,
    events: [],
    revoke() {
      this.epoch += 1;
      this.revoked = true;
      this.events.push({ type: "revoked", epoch: this.epoch });
    },
  };
}

function makeTool(name, cost, ctl, options = {}) {
  return {
    name,
    label: name,
    description: `write ${name}`,
    parameters: Type.Object({ note: Type.String() }),
    execute: async () => {
      ctl.events.push({ type: "preflight_passed", tool: name, epoch: ctl.epoch });
      if (options.revokeBeforeCommit) ctl.revoke();
      if (ctl.revoked || Date.now() > ctl.leaseExpires || ctl.budget < cost) {
        ctl.events.push({ type: "commit_denied", tool: name, epoch: ctl.epoch });
        throw new Error(`commit denied for ${name}`);
      }
      ctl.budget -= cost;
      ctl.effects[name] = (ctl.effects[name] ?? 0) + 1;
      ctl.commits += 1;
      ctl.events.push({ type: "committed", tool: name, epoch: ctl.epoch });
      if (options.revokeAfterCommit) ctl.revoke();
      return { content: [{ type: "text", text: `${name} committed` }], details: { tool: name } };
    },
  };
}

async function runCase({ name, responses, tools, prompt, ctl, tokensPerSecond = 0, onEvent }) {
  const { faux, models, model } = setupModels(responses, tokensPerSecond);
  const state = { status: "running", stoppedReason: null, toolReceipts: {}, modelOps: {}, modelRequests: 0 };
  const agent = new Agent({
    initialState: { systemPrompt: "H07", model, tools, messages: [] },
    toolExecution: "sequential",
    streamFn: (m, context, options) => {
      state.modelRequests += 1;
      const opKey = `m:${state.modelRequests}`;
      state.modelOps[opKey] = { state: "dispatching" };
      state.currentModelOp = opKey;
      return models.streamSimple(m, context, options);
    },
    beforeToolCall: async (context) => {
      ctl.events.push({ type: "before_hook", tool: context.toolCall.name, budget: ctl.budget });
      if (ctl.revoked) {
        state.status = "revoked";
        state.stoppedReason = "access_revoked";
        return { block: true, reason: "access_revoked", terminate: true };
      }
      if (Date.now() > ctl.leaseExpires) {
        state.status = "waiting_device";
        state.stoppedReason = "lease_expired";
        return { block: true, reason: "lease_expired", terminate: true };
      }
      const cost = context.toolCall.name === "write_a" ? 3 : 3;
      if (ctl.budget < cost) {
        state.status = "waiting_budget";
        state.stoppedReason = "budget_exhausted";
        return { block: true, reason: "budget_exhausted", terminate: true };
      }
      return undefined;
    },
    afterToolCall: async (context) => {
      const key = context.toolCall.id;
      state.toolReceipts[key] = {
        tool: context.toolCall.name,
        isError: context.isError,
        executed: !context.isError,
      };
    },
    finishTurn: async () => {
      if (ctl.revoked) {
        state.status = "revoked";
        state.stoppedReason = "access_revoked";
        return { action: "end" };
      }
      if (Date.now() > ctl.leaseExpires) {
        state.status = "waiting_device";
        state.stoppedReason = "lease_expired";
        return { action: "end" };
      }
      if (state.status !== "running") return { action: "end" };
      return undefined;
    },
  });
  agent.subscribe(async (event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const op = state.modelOps[state.currentModelOp];
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        op.state = "unknown";
        state.status = "waiting_reconcile";
        state.stoppedReason = event.message.stopReason;
      } else {
        op.state = "succeeded";
      }
    }
    if (onEvent) await onEvent(event, { agent, state, ctl });
  });
  await agent.prompt(prompt);
  await agent.waitForIdle();
  return { faux, state, ctl, agent };
}

// Case 1: revocation arrives after the first tool commits, before the rest of the batch.
{
  const ctl = controls();
  const tools = [
    makeTool("write_a", 3, ctl, { revokeAfterCommit: true }),
    makeTool("write_b", 3, ctl),
    makeTool("write_c", 3, ctl),
  ];
  const { faux, state } = await runCase({
    name: "revoke-mid-batch",
    ctl,
    tools,
    prompt: "run three writes",
    responses: [
      fauxAssistantMessage([
        fauxToolCall("write_a", { note: "a" }, { id: "a" }),
        fauxToolCall("write_b", { note: "b" }, { id: "b" }),
        fauxToolCall("write_c", { note: "c" }, { id: "c" }),
      ]),
      fauxAssistantMessage("should not be requested"),
    ],
  });
  assert.equal(faux.state.callCount, 1, "no next model request after revoke");
  assert.equal(ctl.effects.write_a, 1);
  assert.equal(ctl.effects.write_b ?? 0, 0);
  assert.equal(state.status, "revoked");
  assert.equal(state.toolReceipts.a.executed, true, "committed side effect keeps its receipt");
  assert.equal(state.toolReceipts.b?.executed ?? false, false, "later tools in the batch never execute");
  assert.equal(state.toolReceipts.c?.executed ?? false, false, "later tools in the batch never execute");
  assert.equal(ctl.events.filter((e) => e.type === "committed").length, 1);
  assert.equal(ctl.events.some((e) => e.type === "canceled"), false, "stop must not be reported as undo");
  results.cases.push({ name: "revoke-mid-batch", fauxCalls: faux.state.callCount, effects: ctl.effects, status: state.status, receipts: state.toolReceipts });
}

// Case 2: revocation wins before dispatch commit; no side effect is created.
{
  const ctl = controls();
  const tools = [makeTool("write_a", 3, ctl, { revokeBeforeCommit: true })];
  const { faux, state } = await runCase({
    name: "revoke-before-commit",
    ctl,
    tools,
    prompt: "write a",
    responses: [fauxAssistantMessage([fauxToolCall("write_a", { note: "a" }, { id: "a" })])],
  });
  assert.equal(ctl.effects.write_a ?? 0, 0, "revocation before commit prevents the side effect");
  assert.equal(ctl.commits, 0);
  assert.equal(ctl.events.some((e) => e.type === "commit_denied"), true);
  assert.equal(faux.state.callCount, 1);
  results.cases.push({ name: "revoke-before-commit", effects: ctl.effects ?? {}, commits: ctl.commits, events: ctl.events });
}

// Case 3: budget exhaustion between tools in the same batch.
{
  const ctl = controls();
  ctl.budget = 4;
  const tools = [makeTool("write_a", 3, ctl), makeTool("write_b", 3, ctl)];
  const { faux, state } = await runCase({
    name: "budget-exhausted",
    ctl,
    tools,
    prompt: "write twice",
    responses: [
      fauxAssistantMessage([
        fauxToolCall("write_a", { note: "a" }, { id: "a" }),
        fauxToolCall("write_b", { note: "b" }, { id: "b" }),
      ]),
    ],
  });
  assert.equal(ctl.effects.write_a, 1);
  assert.equal(ctl.effects.write_b ?? 0, 0);
  assert.equal(state.status, "waiting_budget");
  assert.equal(faux.state.callCount, 1);
  results.cases.push({ name: "budget-exhausted", effects: ctl.effects, status: state.status, budget: ctl.budget });
}

// Case 4: lease expires between tools.
{
  const ctl = controls();
  ctl.leaseExpires = Date.now() + 1000;
  const tools = [
    makeTool("write_a", 3, ctl),
    makeTool("write_b", 3, ctl),
  ];
  const { faux, state } = await runCase({
    name: "lease-expired",
    ctl,
    tools,
    prompt: "write twice",
    responses: [
      fauxAssistantMessage([
        fauxToolCall("write_a", { note: "a" }, { id: "a" }),
        fauxToolCall("write_b", { note: "b" }, { id: "b" }),
      ]),
    ],
    onEvent: async (event) => {
      if (event.type === "tool_execution_end") ctl.leaseExpires = Date.now() - 1;
    },
  });
  assert.equal(faux.state.callCount, 1);
  assert.equal(state.status, "waiting_device");
  assert.equal(ctl.effects.write_a, 1);
  assert.equal(ctl.effects.write_b ?? 0, 0);
  results.cases.push({ name: "lease-expired", effects: ctl.effects, status: state.status });
}

// Case 5: abort a streaming model response; stream stop is not an external rollback.
{
  const ctl = controls();
  const tools = [makeTool("write_a", 3, ctl)];
  const { faux, state } = await runCase({
    name: "abort-stream",
    ctl,
    tools,
    prompt: "stream then abort",
    tokensPerSecond: 20,
    responses: [fauxAssistantMessage([fauxText("a long streamed answer that will be aborted")])],
    onEvent: async (event, ctx) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        ctl.revoke();
        ctx.agent.abort();
      }
    },
  });
  assert.ok(["revoked", "waiting_reconcile"].includes(state.status), `unexpected status ${state.status}`);
  assert.equal(state.modelOps["m:1"].state, "unknown", "charged aborted stream stays unknown");
  assert.equal(state.modelRequests, 1, "no automatic retry after abort");
  assert.equal(ctl.commits, 0);
  results.cases.push({ name: "abort-stream", status: state.status, modelOps: state.modelOps, modelRequests: state.modelRequests });
}

writeJsonAtomic(path.join(runDir, "summary.json"), { experiment: "H07", runDir, results });
console.log(JSON.stringify({ experiment: "H07", runDir, results }, null, 2));
