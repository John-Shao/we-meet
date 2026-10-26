import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createDriver, loadRun } from "./lib/driver.mjs";
import { ensureDir, newRunDir, readJsonl, writeJsonAtomic } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = newRunDir(here, "h08");
ensureDir(base);
const results = { scenarios: [] };

function setupModels(responses) {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { faux, models, model: faux.getModel() };
}

function snapshotHash({ toolNames, approvals, prompt, modelId }) {
  const payload = JSON.stringify({ toolNames, approvals, prompt, modelId });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function makeTool(name, fixtureDir, effects) {
  return {
    name,
    label: name,
    description: `tool ${name}`,
    parameters: Type.Object({ note: Type.String() }),
    execute: async () => {
      effects[name] = (effects[name] ?? 0) + 1;
      if (name === "read_local") {
        const lines = fs.readFileSync(path.join(fixtureDir, "source.txt"), "utf8").split("\n");
        return { content: [{ type: "text", text: lines[1] ?? "" }], details: { source: "fixture" } };
      }
      return { content: [{ type: "text", text: `${name} executed` }], details: { tool: name } };
    },
  };
}

async function runProfile({ profile, scenario, fixtureDir, runRoot }) {
  const toolNames = ["read_local", "danger"];
  const approvals = ["danger"];
  const prompt = scenario === "tool" ? "read the local excerpt" : "call danger";
  const modelId = "faux-h08";
  const effects = {};
  const contexts = [];
  const responses =
    scenario === "tool"
      ? [
          fauxAssistantMessage([fauxToolCall("read_local", { note: "x" }, { id: "call-read" })]),
          fauxAssistantMessage("done after read"),
        ]
      : [fauxAssistantMessage([fauxToolCall("danger", { note: "x" }, { id: "call-danger" })])];
  const { models, model } = setupModels(responses);
  const driver = createDriver({
    runDir: runRoot,
    models,
    model,
    systemPrompt: `H08 ${profile}`,
    tools: [makeTool("read_local", fixtureDir, effects), makeTool("danger", fixtureDir, effects)],
    toolsNeedingApproval: new Set(approvals),
    label: `h08-${profile}-${scenario}`,
    onModelContext: (context) => {
      contexts.push(JSON.stringify(context.messages));
    },
  });
  driver.state.snapshotHash = snapshotHash({ toolNames, approvals, prompt, modelId });
  driver.state.profile = profile;
  if (profile === "local") driver.state.localOnlyCheckpoint = "LOCAL_CHECKPOINT_SECRET";
  driver.save();
  await driver.prompt(prompt);

  const { journal, state } = loadRun(runRoot);
  const normalized = journal
    .filter((entry) =>
      ["waiting_approval", "tool_dispatch_intent", "tool_started", "tool_completed", "tool_receipt_persisted", "turn_end_for_stop", "agent_end"].includes(entry.event),
    )
    .map((entry) => ({ event: entry.event, tool: entry.tool ?? null, key: entry.key ?? null, status: entry.status ?? null }));
  return {
    profile,
    scenario,
    status: state.status,
    snapshotHash: state.snapshotHash,
    effects,
    normalized,
    contexts,
    stateText: fs.readFileSync(path.join(runRoot, "state.json"), "utf8"),
  };
}

for (const scenario of ["tool", "denied"]) {
  const localRoot = path.join(base, `local-${scenario}`);
  const cloudRoot = path.join(base, `cloud-${scenario}`);
  const localFixture = path.join(base, `fixture-local-${scenario}`);
  const cloudFixture = path.join(base, `fixture-cloud-${scenario}`);
  ensureDir(localRoot);
  ensureDir(cloudRoot);
  ensureDir(localFixture);
  ensureDir(cloudFixture);
  fs.writeFileSync(path.join(localFixture, "source.txt"), "LOCAL_FILE_SECRET\nEXCERPT_OK\n");
  fs.writeFileSync(path.join(cloudFixture, "source.txt"), "EXCERPT_OK\n");

  const local = await runProfile({ profile: "local", scenario, fixtureDir: localFixture, runRoot: localRoot });
  const cloud = await runProfile({ profile: "cloud", scenario, fixtureDir: cloudFixture, runRoot: cloudRoot });

  assert.equal(local.snapshotHash, cloud.snapshotHash, "same snapshot hash");
  assert.deepEqual(local.normalized, cloud.normalized, "same normalized event semantics");
  assert.equal(local.status, cloud.status, "same final status");
  assert.deepEqual(local.effects, cloud.effects, "same tool effects");

  const allContexts = local.contexts.concat(cloud.contexts).join("\n");
  assert.equal(allContexts.includes("LOCAL_FILE_SECRET"), false, "local file secret never enters model context");
  assert.equal(allContexts.includes("LOCAL_CHECKPOINT_SECRET"), false, "local checkpoint never enters model context");
  assert.equal(cloud.stateText.includes("LOCAL_CHECKPOINT_SECRET"), false, "cloud state has no local checkpoint");
  assert.equal(cloud.stateText.includes("LOCAL_FILE_SECRET"), false, "cloud state has no local file secret");
  assert.equal(local.stateText.includes("LOCAL_CHECKPOINT_SECRET"), true, "local checkpoint stays local");

  if (scenario === "tool") {
    assert.equal(allContexts.includes("EXCERPT_OK"), true, "allowed excerpt is shared");
    assert.equal(local.status, "finished");
    assert.equal(cloud.status, "finished");
    assert.equal(local.effects.read_local, 1);
  } else {
    assert.equal(local.status, "waiting_approval");
    assert.equal(cloud.status, "waiting_approval");
    assert.equal(local.effects.danger ?? 0, 0);
    assert.equal(cloud.effects.danger ?? 0, 0);
  }

  results.scenarios.push({
    scenario,
    local: { status: local.status, effects: local.effects, events: local.normalized.length },
    cloud: { status: cloud.status, effects: cloud.effects, events: cloud.normalized.length },
    snapshotHash: local.snapshotHash,
    localCheckpointOnlyLocal: true,
  });
}

writeJsonAtomic(path.join(base, "summary.json"), { experiment: "H08", base, results });
console.log(JSON.stringify({ experiment: "H08", base, results }, null, 2));
