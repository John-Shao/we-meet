import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

await import("./guard.mjs");

const { Agent } = await import("@earendil-works/pi-agent-core");
const { Type } = await import("typebox");
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(
  "@earendil-works/pi-ai"
);

const appDir = path.dirname(fileURLToPath(import.meta.url));
const installRoot = path.dirname(appDir);
const dataDir = process.env.H01_DATA_DIR;
if (!dataDir) {
  console.error("H01_DATA_DIR is required");
  process.exit(2);
}

function setupModels(responses) {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { faux, models, model: faux.getModel() };
}

async function runCase({ prompt, tools = [], responses }) {
  const { faux, models, model } = setupModels(responses);
  const events = { toolCalls: [], toolExecutions: [], textDeltas: 0 };
  const agent = new Agent({
    initialState: { systemPrompt: "H01 sidecar", model, tools, messages: [] },
    streamFn: (m, context, options) => models.streamSimple(m, context, options),
    toolExecution: "sequential",
  });
  agent.subscribe((event) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent?.type === "text_delta") events.textDeltas += 1;
      if (event.assistantMessageEvent?.type === "toolcall_end") {
        events.toolCalls.push(event.assistantMessageEvent.toolCall.name);
      }
    }
    if (event.type === "tool_execution_start") events.toolExecutions.push(event.toolName);
  });
  await agent.prompt(prompt);
  await agent.waitForIdle();
  const lastAssistant = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
  const finalText = (lastAssistant?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { finalText, fauxCalls: faux.state.callCount, ...events };
}

function trySpawn(command) {
  try {
    const result = spawnSync(command, ["--version"], { timeout: 3000, encoding: "utf8" });
    return {
      ok: result.status === 0,
      status: result.status,
      error: result.error?.code ?? null,
    };
  } catch (error) {
    return { ok: false, status: null, error: error.code ?? error.message };
  }
}

const textCase = await runCase({
  prompt: "Reply with exactly one word: PONG",
  responses: [fauxAssistantMessage("PONG")],
});

const toolCase = await runCase({
  prompt: "Call get_time for Beijing, then answer with the returned timestamp.",
  tools: [
    {
      name: "get_time",
      label: "get_time",
      description: "Return the current time for a city",
      parameters: Type.Object({ city: Type.String() }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: `2026-10-25T10:00:00Z (${params.city})` }],
        details: { city: params.city },
      }),
    },
  ],
  responses: [
    fauxAssistantMessage([fauxToolCall("get_time", { city: "Beijing" }, { id: "call-time" })]),
    fauxAssistantMessage("2026-10-25T10:00:00Z (Beijing)"),
  ],
});

const result = {
  execPath: process.execPath,
  appDir,
  installRoot,
  cwd: process.cwd(),
  home: process.env.HOME ?? process.env.USERPROFILE,
  path: process.env.PATH,
  envLeaks: {
    PYTHONPATH: process.env.PYTHONPATH ?? null,
    PYTHONHOME: process.env.PYTHONHOME ?? null,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
    NODE_PATH: process.env.NODE_PATH ?? null,
  },
  spawn: {
    python: trySpawn("python"),
    npm: trySpawn("npm"),
    git: trySpawn("git"),
    wsl: trySpawn("wsl"),
  },
  text: textCase,
  tool: toolCase,
};

fs.writeFileSync(path.join(dataDir, "result.json"), JSON.stringify(result, null, 2));

const checks = {
  execPathBundled: path.resolve(process.execPath) === path.resolve(path.join(installRoot, "node.exe")),
  textPong: /PONG/i.test(textCase.finalText),
  toolCalled: toolCase.toolExecutions.includes("get_time"),
  toolAnswer: /2026-10-25/.test(toolCase.finalText),
  numSpawnBlocked: Object.values(result.spawn).every((s) => !s.ok),
};
result.checks = checks;
fs.writeFileSync(path.join(dataDir, "result.json"), JSON.stringify(result, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ pass, checks, result }));
process.exit(pass ? 0 : 1);
