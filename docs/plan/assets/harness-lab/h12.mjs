import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createDriver } from "./lib/driver.mjs";
import { appendJsonl, ensureDir, newRunDir, readJsonl } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const COST = 6;

class Ledger {
  constructor() {
    this.ops = new Map();
    this.providerRequests = new Map();
    this.seenEvents = new Set();
    this.settlements = [];
    this.duplicateEvents = 0;
    this.duplicateReceipts = 0;
    this.suppressedDispatches = 0;
    this.effects = new Map();
    this.unknown = new Set();
  }

  onEvent(eventId) {
    if (this.seenEvents.has(eventId)) {
      this.duplicateEvents += 1;
      return false;
    }
    this.seenEvents.add(eventId);
    return true;
  }

  registerOp(key, kind) {
    if (!this.ops.has(key)) {
      this.ops.set(key, { key, kind, state: "prepared", attempts: 0 });
    }
    return this.ops.get(key);
  }

  beginDispatch(key) {
    const op = this.ops.get(key);
    assert.ok(op, `unknown operation ${key}`);
    if (op.state === "dispatching" || op.state === "executed" || op.state === "unknown") {
      this.suppressedDispatches += 1;
      return false;
    }
    op.state = "dispatching";
    op.attempts += 1;
    return true;
  }

  recordCharge(providerRequestId, key, cost) {
    const op = this.ops.get(key);
    if (this.providerRequests.has(providerRequestId)) {
      this.duplicateReceipts += 1;
      return "duplicate";
    }
    if (op.providerRequestId && op.providerRequestId !== providerRequestId) {
      throw new Error(`conflicting provider request for ${key}`);
    }
    this.providerRequests.set(providerRequestId, { key, cost });
    op.providerRequestId = providerRequestId;
    op.cost = cost;
    return "charged";
  }

  deliverReceipt({ key, responseId, cost, providerRequestId }) {
    const op = this.ops.get(key);
    assert.ok(op, `unknown operation ${key}`);
    if (op.state === "executed") {
      this.duplicateReceipts += 1;
      if (responseId && op.responseId && op.responseId !== responseId) {
        throw new Error(`conflicting receipt for ${key}: ${op.responseId} vs ${responseId}`);
      }
      return "duplicate";
    }
    assert.ok(
      op.state === "dispatching" || op.state === "unknown",
      `receipt for ${key} in state ${op.state}`,
    );
    op.state = "executed";
    op.responseId = responseId;
    op.settledCost = cost;
    this.unknown.delete(key);
    this.settlements.push({ key, cost, providerRequestId, via: "receipt" });
    return "settled";
  }

  markUnknown(key) {
    const op = this.ops.get(key);
    assert.ok(op?.state === "dispatching", `only dispatching ops become unknown (${key})`);
    op.state = "unknown";
    this.unknown.add(key);
  }

  settleFromQuery(key, { responseId, cost, providerRequestId }) {
    const op = this.ops.get(key);
    if (op.state === "executed") {
      this.duplicateReceipts += 1;
      return "duplicate";
    }
    assert.ok(op.state === "unknown" || op.state === "dispatching", `query settle from ${op.state}`);
    op.state = "executed";
    op.responseId = responseId;
    op.settledCost = cost;
    this.unknown.delete(key);
    this.settlements.push({ key, cost, providerRequestId, via: "provider_query" });
    return "settled";
  }

  recordEffect(key) {
    this.effects.set(key, (this.effects.get(key) ?? 0) + 1);
  }

  audit() {
    const ops = [...this.ops.values()];
    const opsWithoutProvider = ops
      .filter((op) => op.kind === "model" && (!op.providerRequestId || !this.providerRequests.has(op.providerRequestId)))
      .map((op) => op.key);
    const providerWithoutOp = [...this.providerRequests]
      .filter(([, value]) => !this.ops.has(value.key))
      .map(([id]) => id);
    const chargesByOp = new Map();
    for (const [, value] of this.providerRequests) {
      chargesByOp.set(value.key, (chargesByOp.get(value.key) ?? 0) + 1);
    }
    const doubleCharges = [...chargesByOp].filter(([, count]) => count > 1).map(([key]) => key);
    return {
      ops: ops.length,
      charges: this.providerRequests.size,
      settlements: this.settlements.length,
      totalCharged: [...this.providerRequests.values()].reduce((sum, v) => sum + v.cost, 0),
      totalSettled: this.settlements.reduce((sum, s) => sum + (s.cost ?? 0), 0),
      opsWithoutProvider,
      providerWithoutOp,
      doubleCharges,
      duplicateEvents: this.duplicateEvents,
      duplicateReceipts: this.duplicateReceipts,
      suppressedDispatches: this.suppressedDispatches,
      unknownOpen: this.unknown.size,
      effects: Object.fromEntries(this.effects),
    };
  }
}

function setupModels(responses) {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { faux, models, model: faux.getModel() };
}

function makeEffectTool(effectsFile) {
  return {
    name: "write_note",
    label: "write_note",
    description: "idempotent write keyed by tool call id",
    parameters: Type.Object({ note: Type.String() }),
    execute: async (toolCallId) => {
      const existing = readJsonl(effectsFile).filter((line) => line.key === toolCallId);
      if (existing.length === 0) appendJsonl(effectsFile, { key: toolCallId });
      return { content: [{ type: "text", text: "note written" }], details: { key: toolCallId } };
    },
  };
}

const results = { experiment: "H12", scenarios: [] };

// S1: normal run with at-least-once receipt and command delivery.
{
  const runDir = newRunDir(here, "h12-normal");
  ensureDir(runDir);
  const providerLog = path.join(runDir, "provider.jsonl");
  const effectsFile = path.join(runDir, "effects.jsonl");
  const { models, model } = setupModels([
    fauxAssistantMessage([fauxToolCall("write_note", { note: "x" }, { id: "call-note" })]),
    fauxAssistantMessage("done after note"),
  ]);
  const driver = createDriver({
    runDir,
    models,
    model,
    systemPrompt: "H12 coverage",
    tools: [makeEffectTool(effectsFile)],
    providerLog,
    costPerModelCall: COST,
    label: "h12-normal",
  });
  await driver.prompt("write a note");

  const entries = readJsonl(providerLog);
  const requests = entries.filter((e) => e.type === "model_request");
  const modelReceipts = entries.filter((e) => e.type === "model_receipt");
  const toolReceipts = entries.filter((e) => e.type === "tool_receipt");
  assert.equal(requests.length, 2);
  assert.equal(modelReceipts.length, 2);
  assert.equal(toolReceipts.length, 1);

  const ledger = new Ledger();
  ledger.onEvent("task.submitted:run1");
  ledger.onEvent("task.submitted:run1");
  for (const request of requests) ledger.registerOp(request.opKey, "model");
  for (const receipt of toolReceipts) ledger.registerOp(receipt.opKey, "tool");
  for (const request of requests) {
    assert.equal(ledger.beginDispatch(request.opKey), true);
    ledger.recordCharge(request.providerRequestId, request.opKey, request.cost);
  }
  for (const receipt of toolReceipts) {
    assert.equal(ledger.beginDispatch(receipt.opKey), true);
  }
  for (const receipt of modelReceipts) {
    for (let i = 0; i < 3; i += 1) {
      ledger.deliverReceipt({
        key: receipt.opKey,
        responseId: receipt.responseId,
        cost: receipt.cost,
        providerRequestId: receipt.providerRequestId,
      });
    }
  }
  for (const receipt of toolReceipts) {
    for (let i = 0; i < 3; i += 1) ledger.deliverReceipt({ key: receipt.opKey, cost: 0 });
  }
  // At-least-once command redelivery must be suppressed, not re-executed.
  assert.equal(ledger.beginDispatch("m:1"), false);
  assert.equal(ledger.beginDispatch(toolReceipts[0].opKey), false);
  for (const line of readJsonl(effectsFile)) ledger.recordEffect(line.key);

  const audit = ledger.audit();
  assert.deepEqual(audit.opsWithoutProvider, []);
  assert.deepEqual(audit.providerWithoutOp, []);
  assert.deepEqual(audit.doubleCharges, []);
  assert.equal(audit.charges, 2);
  assert.equal(audit.settlements, 3);
  assert.equal(audit.totalCharged, COST * 2);
  assert.equal(audit.totalSettled, COST * 2);
  assert.equal(audit.duplicateEvents, 1);
  assert.equal(audit.duplicateReceipts, 6);
  assert.equal(audit.suppressedDispatches, 2);
  assert.equal(Object.keys(audit.effects).length, 1);
  assert.deepEqual(Object.values(audit.effects), [1]);
  assert.equal(driver.state.status, "finished");
  results.scenarios.push({ name: "normal-coverage", audit, finalText: driver.state.finalText });
}

// S2: unknown operations reconcile through provider/device query without a second effect.
{
  const ledger = new Ledger();
  ledger.registerOp("m:1", "model");
  ledger.registerOp("t:1", "tool");
  assert.equal(ledger.beginDispatch("m:1"), true);
  ledger.recordCharge("pr-x-1", "m:1", 9);
  assert.equal(ledger.beginDispatch("t:1"), true);
  ledger.recordEffect("t:1");
  ledger.markUnknown("m:1");
  ledger.markUnknown("t:1");
  assert.equal(ledger.beginDispatch("m:1"), false);
  assert.equal(ledger.beginDispatch("t:1"), false);
  assert.equal(ledger.settleFromQuery("m:1", { providerRequestId: "pr-x-1", responseId: "resp-x-1", cost: 9 }), "settled");
  assert.equal(ledger.settleFromQuery("t:1", { responseId: "tool-receipt-x" }), "settled");
  assert.equal(ledger.settleFromQuery("t:1", { responseId: "tool-receipt-x" }), "duplicate");
  const audit = ledger.audit();
  assert.equal(audit.unknownOpen, 0);
  assert.equal(audit.charges, 1);
  assert.equal(audit.settlements, 2);
  assert.equal(audit.suppressedDispatches, 2);
  assert.equal(audit.effects["t:1"], 1);
  assert.deepEqual(audit.opsWithoutProvider, []);
  results.scenarios.push({ name: "unknown-reconcile", audit, attempts: [...ledger.ops.values()].map((o) => o.attempts) });
}

// S3: duplicate outbox event and two consumers racing on the same command.
{
  const ledger = new Ledger();
  assert.equal(ledger.onEvent("outbox:1"), true);
  assert.equal(ledger.onEvent("outbox:1"), false);
  ledger.registerOp("t:race", "tool");
  ledger.registerOp("t:race", "tool");
  assert.equal(ledger.ops.size, 1);
  assert.equal(ledger.beginDispatch("t:race"), true);
  assert.equal(ledger.beginDispatch("t:race"), false);
  ledger.recordEffect("t:race");
  for (let i = 0; i < 3; i += 1) ledger.deliverReceipt({ key: "t:race", responseId: "receipt-race" });
  let conflictDetected = false;
  try {
    ledger.deliverReceipt({ key: "t:race", responseId: "receipt-conflict" });
  } catch {
    conflictDetected = true;
  }
  const audit = ledger.audit();
  assert.equal(conflictDetected, true, "a conflicting receipt for an executed op must be rejected");
  assert.equal(audit.ops, 1);
  assert.equal(audit.settlements, 1);
  assert.equal(audit.duplicateEvents, 1);
  assert.equal(audit.duplicateReceipts, 3);
  assert.equal(audit.suppressedDispatches, 1);
  assert.equal(audit.effects["t:race"], 1);
  results.scenarios.push({ name: "duplicate-outbox-and-race", audit, conflictDetected });
}

// S4: audit must detect orphans instead of silently accepting them.
{
  const ledger = new Ledger();
  ledger.registerOp("m:orphan-op", "model");
  ledger.providerRequests.set("pr-orphan-charge", { key: "m:missing-op", cost: 4 });
  const audit = ledger.audit();
  assert.deepEqual(audit.opsWithoutProvider, ["m:orphan-op"]);
  assert.deepEqual(audit.providerWithoutOp, ["pr-orphan-charge"]);
  results.scenarios.push({ name: "orphan-audit", audit });
}

fs.writeFileSync(path.join(here, "runs", "h12-summary.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
