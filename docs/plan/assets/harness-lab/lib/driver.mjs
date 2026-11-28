import path from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { appendJsonl, nowIso, readJson, readJsonl, writeJsonAtomic } from "./store.mjs";

const MAX_MODEL_REQUESTS = 8;

export function createDriver(options) {
  const {
    runDir,
    models,
    model,
    tools,
    systemPrompt,
    toolsNeedingApproval = new Set(),
    finishTurnEnabled = true,
    killAfterToolCompleted = false,
    killBeforeToolExecute = false,
    killAfterModelMessage = false,
    providerLog = null,
    costPerModelCall = 0,
    onModelContext = null,
    label = "run",
  } = options;

  const statePath = path.join(runDir, "state.json");
  const journalPath = path.join(runDir, "journal.jsonl");
  const state = readJson(statePath, {
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

  const save = () => writeJsonAtomic(statePath, state);
  const journal = (record) => appendJsonl(journalPath, record);

  function toolKeyFor(toolCallId) {
    if (!state.toolKeys[toolCallId]) {
      state.toolKeys[toolCallId] = `t:${state.modelRequests}:${state.toolSeq++}`;
    }
    return state.toolKeys[toolCallId];
  }

  function streamFn(m, context, streamOptions) {
    state.modelRequests += 1;
    if (state.modelRequests > MAX_MODEL_REQUESTS) {
      throw new Error("model request budget exceeded");
    }
    const opKey = `m:${state.modelRequests}`;
    state.modelOps[opKey] = { opKey, state: "dispatching", at: nowIso() };
    state.currentModelOp = opKey;
    state.status = "running";
    if (onModelContext) onModelContext(context, { opKey, runDir });
    if (providerLog) {
      const providerRequestId = `pr-${state.runId}-${state.modelRequests}`;
      state.modelOps[opKey].providerRequestId = providerRequestId;
      state.modelOps[opKey].cost = costPerModelCall;
      appendJsonl(providerLog, {
        type: "model_request",
        providerRequestId,
        opKey,
        cost: costPerModelCall,
      });
    }
    save();
    journal({ event: "model_dispatch", opKey });
    return models.streamSimple(m, context, streamOptions);
  }

  async function beforeToolCall(context) {
    const tc = context.toolCall;
    const key = toolKeyFor(tc.id);
    if (!state.toolOps[key]) {
      state.toolOps[key] = { key, tool: tc.name, args: tc.arguments, state: "prepared" };
    }
    if (state.status === "waiting_approval" || state.status === "waiting_reconcile") {
      journal({ event: "tool_blocked_after_stop", key, tool: tc.name });
      return { block: true, reason: `run_stopped:${state.status}`, terminate: true };
    }
    if (state.toolOps[key].state === "executed") {
      journal({ event: "tool_blocked_already_executed", key, tool: tc.name });
      return { block: true, reason: "already_executed", terminate: true };
    }
    if (toolsNeedingApproval.has(tc.name) && state.approvals[key] !== "granted") {
      state.status = "waiting_approval";
      state.toolOps[key].state = "waiting_approval";
      save();
      journal({ event: "waiting_approval", key, tool: tc.name, args: tc.arguments });
      return { block: true, reason: "approval_required", terminate: true };
    }
    state.toolOps[key].state = "dispatch_intent";
    state.toolOps[key].dispatchedAt = nowIso();
    save();
    journal({ event: "tool_dispatch_intent", key, tool: tc.name, args: tc.arguments });
    if (killBeforeToolExecute) {
      journal({ event: "crash_before_tool_execute", key });
      process.exit(137);
    }
    return undefined;
  }

  async function afterToolCall(context) {
    const key = toolKeyFor(context.toolCall.id);
    state.toolOps[key].state = "executed";
    state.toolOps[key].receipt = {
      content: context.result.content,
      details: context.result.details,
      isError: context.isError,
    };
    state.executions += 1;
    if (providerLog) {
      appendJsonl(providerLog, {
        type: "tool_receipt",
        opKey: key,
        tool: context.toolCall.name,
        content: context.result.content,
        isError: context.isError,
      });
    }
    save();
    journal({ event: "tool_receipt_persisted", key, tool: context.toolCall.name });
  }

  async function finishTurn() {
    if (!finishTurnEnabled) return undefined;
    if (state.status === "waiting_approval" || state.status === "waiting_reconcile") {
      journal({ event: "turn_end_for_stop", status: state.status });
      return { action: "end" };
    }
    return undefined;
  }

  function wrappedTools() {
    return tools.map((tool) => ({
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const key = toolKeyFor(toolCallId);
        journal({ event: "tool_started", key, tool: tool.name, args: params });
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        journal({
          event: "tool_completed",
          key,
          tool: tool.name,
          content: result.content,
          details: result.details,
          isError: result.isError ?? false,
        });
        if (killAfterToolCompleted) {
          journal({ event: "crash_after_tool_completed", key });
          process.exit(137);
        }
        return result;
      },
    }));
  }

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: wrappedTools(),
      messages: options.restoredMessages ?? [],
    },
    streamFn,
    beforeToolCall,
    afterToolCall,
    finishTurn,
  });

  agent.subscribe(async (event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      if (killAfterModelMessage) {
        journal({ event: "crash_after_model_message_before_checkpoint", stopReason: message.stopReason });
        process.exit(137);
      }
      state.messages.push(message);
      const opKey = state.currentModelOp;
      if (opKey && state.modelOps[opKey]) {
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          state.modelOps[opKey].state = "unknown";
          state.modelOps[opKey].error = message.errorMessage ?? message.stopReason;
          state.status = "waiting_reconcile";
        } else {
          state.modelOps[opKey].state = "succeeded";
          state.modelOps[opKey].responseId = message.responseId;
          if (providerLog) {
            appendJsonl(providerLog, {
              type: "model_receipt",
              providerRequestId: state.modelOps[opKey].providerRequestId,
              opKey,
              responseId: message.responseId ?? `resp-${opKey}`,
              cost: state.modelOps[opKey].cost ?? costPerModelCall,
            });
          }
        }
      }
      save();
      journal({ event: "message_persisted", role: message.role, stopReason: message.stopReason });
    }
    if (event.type === "tool_execution_end") {
      journal({
        event: "tool_execution_end",
        tool: event.toolName,
        isError: event.isError,
        durationMs: event.durationMs,
      });
    }
    if (event.type === "agent_end") {
      journal({ event: "agent_end", status: state.status });
    }
  });

  function finalizeStatus() {
    const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
    const hasToolCalls = lastAssistant?.content?.some((c) => c.type === "toolCall") ?? false;
    if (state.status === "waiting_approval" || state.status === "waiting_reconcile") {
      // keep
    } else if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") {
      state.status = "waiting_reconcile";
      state.stopReason = lastAssistant.stopReason;
    } else if (lastAssistant && !hasToolCalls) {
      state.status = "finished";
      state.finalText = lastAssistant.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }
    save();
  }

  async function prompt(text) {
    state.messages.push({ role: "user", content: text, timestamp: Date.now() });
    save();
    await agent.prompt(text);
    await agent.waitForIdle();
    finalizeStatus();
  }

  async function continueRun() {
    await agent.continue();
    await agent.waitForIdle();
    finalizeStatus();
  }

  return {
    state,
    agent,
    save,
    journal,
    prompt,
    continueRun,
    finalizeStatus,
    toolKeyFor,
    statePath,
    journalPath,
  };
}

export function loadRun(runDir) {
  const state = readJson(path.join(runDir, "state.json"), null);
  const journal = readJsonl(path.join(runDir, "journal.jsonl"));
  return { state, journal };
}

/** Reconcile dispatch_intent / waiting_approval tool ops against the local journal. */
export function reconcile(state, journal) {
  const byKey = new Map();
  for (const entry of journal) {
    if (!entry.key) continue;
    if (!byKey.has(entry.key)) byKey.set(entry.key, []);
    byKey.get(entry.key).push(entry);
  }
  for (const [key, op] of Object.entries(state.toolOps)) {
    if (op.state === "executed" || op.state === "unknown") continue;
    const entries = byKey.get(key) ?? [];
    const completed = entries.find((e) => e.event === "tool_completed");
    const started = entries.find((e) => e.event === "tool_started");
    if (completed) {
      op.state = "executed";
      op.receipt = {
        content: completed.content,
        details: completed.details,
        isError: completed.isError ?? false,
      };
      op.recoveredFrom = "journal_completed";
    } else if (started) {
      op.state = "unknown";
      op.recoveredFrom = "journal_started_only";
      state.status = "waiting_reconcile";
    }
  }
  return state;
}

/** A model operation left in dispatching without a stored response must become unknown, never retried automatically. */
export function reconcileModelOps(state) {
  for (const op of Object.values(state.modelOps)) {
    if (op.state === "dispatching") {
      op.state = "unknown";
      op.recoveredFrom = "no_response_receipt";
      state.status = "waiting_reconcile";
    }
  }
  return state;
}

export function assistantToolCalls(message) {
  return (message.content ?? []).filter((c) => c.type === "toolCall");
}

export function toolResultFromState(state, toolCall) {
  const key = state.toolKeys[toolCall.id];
  const op = state.toolOps[key];
  if (!op || op.state !== "executed" || !op.receipt) return null;
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: op.receipt.content,
    details: op.receipt.details ?? {},
    isError: Boolean(op.receipt.isError),
    timestamp: Date.now(),
  };
}

export function lastAssistant(state) {
  return [...state.messages].reverse().find((m) => m.role === "assistant");
}
