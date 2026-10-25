import fs from "node:fs";
import { Type } from "typebox";

await import("./guard/h02-net-guard.mjs");

const { Agent } = await import("@earendil-works/pi-agent-core");
const provider = process.env.H02_PROVIDER ?? "qwen";
const { streamSimple } = await import(
  provider === "doubao" ? "@earendil-works/pi-ai/api/openai-responses" : "@earendil-works/pi-ai/api/openai-completions"
);

const port = process.env.H02_PORT;
const resultFile = process.env.H02_RESULT;
const modelId = process.env.H02_MODEL_ID ?? (provider === "doubao" ? "doubao-seed-2-1-lite-260915" : "qwen3.8-flash");
const model = {
  id: modelId,
  name: `${modelId} (via Work gateway)`,
  api: provider === "doubao" ? "openai-responses" : "openai-completions",
  provider: provider === "deepseek" ? "deepseek-gateway" : provider === "doubao" ? "doubao-gateway" : "qwen-gateway",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  input: ["text"],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 2048,
  compat:
    provider === "doubao"
      ? {
          supportsDeveloperRole: false,
          supportsStrictMode: false,
          supportsMaxOutputTokens: true,
          supportsMidConvoSystemMessages: false,
        }
      : {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
          thinkingFormat: "openai",
        },
};

function makeStreamFn(prefix) {
  let callSeq = 0;
  return (m, context, options) => {
    callSeq += 1;
    const operationId = `${prefix}:m:${callSeq}`;
    return streamSimple(m, context, {
      ...options,
      apiKey: "gateway-internal",
      timeoutMs: 90_000,
      headers: {
        "x-work-operation-id": operationId,
        "x-work-gateway-token": "local-dev",
      },
    });
  };
}

async function runCase({ name, prompt, tools = [], systemPrompt }) {
  const events = { textDeltas: 0, thinkingDeltas: 0, toolCalls: [], toolExecutions: [], modelCalls: 0 };
  const baseStreamFn = makeStreamFn(`h02-${provider}-${name}`);
  const agent = new Agent({
    initialState: { systemPrompt, model, tools, messages: [] },
    streamFn: (m, context, options) => {
      events.modelCalls += 1;
      return baseStreamFn(m, context, options);
    },
    toolExecution: "sequential",
  });
  agent.subscribe((event) => {
    if (event.type === "message_update") {
      const type = event.assistantMessageEvent?.type;
      if (type === "text_delta") events.textDeltas += 1;
      if (type === "thinking_delta") events.thinkingDeltas += 1;
      if (type === "toolcall_end") events.toolCalls.push(event.assistantMessageEvent.toolCall.name);
    }
    if (event.type === "tool_execution_start") events.toolExecutions.push(event.toolName);
  });

  await agent.prompt(prompt);
  await agent.waitForIdle();

  const messages = agent.state.messages;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const finalText = (lastAssistant?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const thinkingChars = (lastAssistant?.content ?? [])
    .filter((c) => c.type === "thinking")
    .reduce((sum, c) => sum + c.thinking.length, 0);
  return {
    name,
    finalText,
    thinkingChars,
    usage: lastAssistant?.usage,
    stopReason: lastAssistant?.stopReason,
    ...events,
  };
}

const results = { provider, modelId, cases: [], hasDashscopeKey: Boolean(process.env.DASHSCOPE_API_KEY), gatewayPort: port };

results.cases.push(
  await runCase({
    name: "text",
    systemPrompt: "You are a protocol test client. Follow instructions exactly.",
    prompt: "Reply with exactly one word: PONG",
  }),
);

results.cases.push(
  await runCase({
    name: "tool",
    systemPrompt: "You are a protocol test client. Use the provided tool when asked.",
    prompt: "Call the get_time tool with city=Beijing. Then reply with the exact timestamp it returned.",
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
  }),
);

fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
