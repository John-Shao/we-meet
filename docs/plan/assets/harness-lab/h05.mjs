import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, newRunDir, readJsonl } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const poisonTokens = {
  piSettings: "POISON_PI_SETTINGS_7c1f",
  piSkill: "POISON_PI_SKILL_2a9d",
  mcpConfig: "POISON_MCP_CONFIG_5e3b",
  agentsMd: "POISON_AGENTS_MD_8d4a",
  npmToken: "POISON_NPM_TOKEN_6b2e",
  awsKey: "POISON_AWS_KEY_1f7c",
  sshKey: "POISON_SSH_KEY_9c0a",
  envKey: "POISON_ENV_KEY_4d8b",
  openaiKey: "POISON_OPENAI_KEY_3a6f",
  anthropicKey: "POISON_ANTHROPIC_KEY_e215",
};

function writePoisonTree(base) {
  const home = path.join(base, "home");
  const cwd = path.join(base, "cwd");
  const files = [
    [path.join(home, ".pi", "settings.json"), JSON.stringify({ theme: poisonTokens.piSettings })],
    [path.join(home, ".pi", "skills", "evil.md"), `# skill\n${poisonTokens.piSkill}\n`],
    [path.join(home, ".config", "pi", "config.json"), JSON.stringify({ token: poisonTokens.piSettings })],
    [path.join(home, ".mcp.json"), JSON.stringify({ mcpServers: { evil: poisonTokens.mcpConfig } })],
    [path.join(home, "AGENTS.md"), `# agents\n${poisonTokens.agentsMd}\n`],
    [path.join(home, ".npmrc"), `//registry.npmjs.org/:_authToken=${poisonTokens.npmToken}\n`],
    [path.join(home, ".aws", "credentials"), `aws_secret_access_key=${poisonTokens.awsKey}\n`],
    [path.join(home, ".ssh", "id_rsa"), `-----BEGIN KEY-----\n${poisonTokens.sshKey}\n-----END KEY-----\n`],
    [path.join(cwd, "AGENTS.md"), `# cwd agents\n${poisonTokens.agentsMd}\n`],
    [path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { local: poisonTokens.mcpConfig } })],
    [path.join(cwd, "settings.json"), JSON.stringify({ key: poisonTokens.piSettings })],
    [path.join(cwd, "skills", "local.md"), `# local skill\n${poisonTokens.piSkill}\n`],
    [path.join(cwd, ".env"), `OPENAI_API_KEY=${poisonTokens.envKey}\n`],
    [path.join(cwd, "credentials.json"), JSON.stringify({ token: poisonTokens.npmToken })],
  ];
  for (const [file, content] of files) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, content);
  }
  return { home, cwd };
}

if (process.env.H05_PHASE === "run") {
  await import("./guard/h05-guard.mjs");

  const { Agent } = await import("@earendil-works/pi-agent-core");
  const { Type } = await import("typebox");
  const {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
  } = await import("@earendil-works/pi-ai");

  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("report_context", {}, { id: "call-context" })]),
    fauxAssistantMessage("H05 complete"),
  ]);

  const messages = [];
  const tool = {
    name: "report_context",
    label: "report_context",
    description: "report effective home and cwd",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            home: os.homedir(),
            cwd: process.cwd(),
            envPresent: {
              OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
              ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY),
            },
          }),
        },
      ],
      details: {},
    }),
  };

  const agent = new Agent({
    initialState: { systemPrompt: "H05 experiment", model, tools: [tool], messages: [] },
    streamFn: (m, context, options) => models.streamSimple(m, context, options),
  });
  agent.subscribe((event) => {
    if (event.type === "message_end") messages.push(event.message);
  });

  await agent.prompt("report the environment");
  await agent.waitForIdle();

  fs.writeFileSync(
    process.env.H05_TRANSCRIPT,
    JSON.stringify(
      {
        messages,
        fauxCalls: faux.state.callCount,
        home: os.homedir(),
        cwd: process.cwd(),
        commit: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// Orchestrator
const results = { experiment: "H05", checks: [] };
const base = newRunDir(here, "h05");
const poison = writePoisonTree(base);
const logFile = path.join(base, "guard-log.jsonl");
const transcriptFile = path.join(base, "transcript.json");
const runDir = path.join(base, "run");
ensureDir(runDir);

const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
  cwd: poison.cwd,
  env: {
    ...process.env,
    HOME: poison.home,
    USERPROFILE: poison.home,
    APPDATA: path.join(poison.home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(poison.home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(poison.home, ".config"),
    OPENAI_API_KEY: poisonTokens.openaiKey,
    ANTHROPIC_API_KEY: poisonTokens.anthropicKey,
    H05_PHASE: "run",
    H05_LOG: logFile,
    H05_TRANSCRIPT: transcriptFile,
  },
  encoding: "utf8",
  timeout: 60_000,
});

function check(name, ok, detail) {
  results.checks.push({ name, ok, detail });
  if (!ok) process.exitCode = 1;
}

check("child-exit", child.status === 0, { status: child.status, stderr: child.stderr.trim() });

const transcriptText = fs.existsSync(transcriptFile) ? fs.readFileSync(transcriptFile, "utf8") : "";
const transcript = transcriptText ? JSON.parse(transcriptText) : null;
const guardLog = readJsonl(logFile);

if (transcript) {
  check("effective-home", path.resolve(transcript.home) === path.resolve(poison.home), transcript.home);
  check("effective-cwd", path.resolve(transcript.cwd) === path.resolve(poison.cwd), transcript.cwd);
  check("expected-model-requests", transcript.fauxCalls === 2, {
    actual: transcript.fauxCalls,
    expected: "2 (one tool turn + one final turn, no background calls)",
  });

  const leaks = Object.entries(poisonTokens).filter(([, token]) => transcriptText.includes(token));
  check("no-poison-in-transcript", leaks.length === 0, leaks.map(([k]) => k));
}

function isInside(candidate, root) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const local = candidate.startsWith("file://") ? fileURLToPath(candidate) : candidate;
  const resolved = path.isAbsolute(local) ? path.normalize(local) : path.resolve(poison.cwd, local);
  const rel = path.relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const poisonReads = guardLog.filter(
  (entry) =>
    entry.type === "fs" &&
    (isInside(entry.detail.path, poison.home) || isInside(entry.detail.path, poison.cwd)),
);
check("no-poison-file-read", poisonReads.length === 0, poisonReads.map((e) => e.detail.path));

const network = guardLog.filter((entry) => entry.type === "net");
check("no-network", network.length === 0, network);

const childProcesses = guardLog.filter((entry) => entry.type === "child_process");
check("no-child-process", childProcesses.length === 0, childProcesses);

const allReads = guardLog.filter((entry) => entry.type === "fs");
results.stats = {
  base,
  guardEntries: guardLog.length,
  readsLogged: allReads.length,
  readSample: allReads.slice(0, 5).map((e) => e.detail),
  networkAttempts: network.length,
  poisonReads: poisonReads.length,
};

// Static check: no config/skill/MCP loading or telemetry client in the agent loop package.
const agentCoreDist = path.resolve(here, "../node_modules/@earendil-works/pi-agent-core/dist");
const terms = ["AGENTS.md", ".mcp.json", "telemetry", "posthog", "sentry", "google-analytics"];
const staticHits = [];
for (const file of fs.readdirSync(agentCoreDist)) {
  if (!file.endsWith(".js")) continue;
  const text = fs.readFileSync(path.join(agentCoreDist, file), "utf8");
  for (const term of terms) {
    if (text.includes(term)) staticHits.push({ file, term });
  }
}
check("no-config-or-telemetry-code", staticHits.length === 0, staticHits);

fs.writeFileSync(path.join(base, "summary.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
