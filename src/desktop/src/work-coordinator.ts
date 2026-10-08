/** Main-process-only durable Work ledger bridge; never imports an agent SDK. */
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { LocalWorkClient } from "./local-work";

const CONTRACT = "work-device/v1";
type Json = Record<string, any>;
interface Binding {
  admission: Json;
  workspaceId: string;
  claim?: Json;
  taskId?: string;
  started: boolean;
  seq: number;
  pending?: Json;
  lastReport?: string;
  status?: string;
  error?: string;
  uploaded?: string[];
  deployment?: Json;
  remote?: boolean;
}
interface Dependencies {
  request: (endpoint: string, body?: Json) => Promise<Json>;
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
  remoteWorkspaces?: () => string[];
}

export class WorkCoordinator {
  private bindings: Record<string, Binding> = {};
  private deviceId: string;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private syncing = false;
  private operations = new Map<string, Promise<any>>();
  private file: string;
  private remotePending: Json[] = [];
  constructor(private client: LocalWorkClient, root: string, private dependencies: Dependencies) {
    mkdirSync(root, { recursive: true });
    this.file = path.join(root, "coordination.enc");
    const saved = existsSync(this.file) ? JSON.parse(dependencies.decrypt(readFileSync(this.file))) : null;
    this.deviceId = saved?.deviceId || randomUUID();
    this.bindings = saved?.bindings || {};
    this.save();
    this.timer = setInterval(() => { void this.tick(); }, 10000);
  }
  private save() {
    if (this.stopped) return;
    writeFileSync(this.file + ".tmp", this.dependencies.encrypt(JSON.stringify({ deviceId: this.deviceId, bindings: this.bindings })));
    renameSync(this.file + ".tmp", this.file);
  }
  private async call(endpoint: string, body?: Json) {
    if (this.stopped) throw new Error("local_account_changed");
    const value = await this.dependencies.request(endpoint, body);
    if (this.stopped) throw new Error("local_account_changed");
    if (value.contract !== CONTRACT) throw new Error("local_coordination_mismatch");
    return value;
  }
  has(id: string) { return !!this.bindings[id]; }
  async registerWorkspace(id: string, label: string, enabled: boolean) {
    const c = await this.client.request("capabilities");
    if (!c.ready || !c.features?.includes("command_approval")) throw new Error("local_adapter_upgrade_required");
    await this.call("local/devices/", { device_id: this.deviceId, name: "We-Meet Desktop" });
    return this.call("local/workspaces/", { device_id: this.deviceId, workspace_id: id, label: label.slice(0, 120), model: c.model, enabled });
  }
  async inbox() {
    const ids = this.dependencies.remoteWorkspaces?.() || [];
    if (!ids.length) { this.remotePending = []; return []; }
    const value = await this.call("local/inbox/", { device_id: this.deviceId, workspace_ids: ids });
    if (!Array.isArray(value.pending) || value.pending.length > 20) throw new Error("local_coordination_mismatch");
    this.remotePending = value.pending.filter((r: Json) => ids.includes(r.workspace_id) &&
      typeof r.goal === "string" && r.goal.length <= 2000 && typeof r.workspace_label === "string" &&
      /^[a-f0-9-]{36}$/.test(r.run_id) && /^[a-f0-9-]{36}$/.test(r.task_id));
    return this.remotePending;
  }
  async takeRemote(id: string, workspaceId: string) {
    if (!(this.dependencies.remoteWorkspaces?.() || []).includes(workspaceId)) throw new Error("workspace_permission_required");
    let binding = this.bindings[id];
    if (!binding) {
      const pending = (await this.inbox()).find(r => r.run_id === id && r.workspace_id === workspaceId);
      if (!pending) throw new Error("local_assignment_closed");
      binding = this.bindings[id] = { remote: true, admission: { run_id: id, device_id: this.deviceId, goal: pending.goal, workspace_label: pending.workspace_label, model: pending.model, sources: [] }, workspaceId, taskId: pending.task_id, started: false, seq: 0 };
      this.save();
    }
    if (!binding.remote || binding.workspaceId !== workspaceId) throw new Error("workspace_permission_required");
    return this.submit({ run_id: id, workspace_id: workspaceId, goal: binding.admission.goal }, binding.admission.workspace_label);
  }
  private pendingJob(id: string) {
    const binding = this.bindings[id];
    return { run_id: id, goal: binding.admission.goal, workspace: binding.admission.workspace_label, workspace_id: binding.workspaceId, state: "needs_confirmation", error_code: "local_tracking_pending", result: null };
  }
  async list() {
    const jobs = await this.client.request("list");
    return [...jobs.map((job: Json) => this.decorate(job)), ...Object.keys(this.bindings).filter(id => !jobs.some((job: Json) => job.run_id === id)).map(id => this.decorate(this.pendingJob(id)))];
  }
  async get(id: string) {
    try { return await this.reconcile(id); }
    catch (error) {
      if (this.bindings[id] && error instanceof Error && error.message === "not_found") return this.decorate(this.pendingJob(id));
      throw error;
    }
  }
  resume(id: string, workspaceId: string, label: string) {
    const binding = this.bindings[id];
    if (!binding || binding.workspaceId !== workspaceId) throw new Error("workspace_permission_required");
    return this.submit({ run_id: id, workspace_id: workspaceId, goal: binding.admission.goal, sources: binding.admission.sources }, label);
  }
  private serial(id: string, action: () => Promise<any>) {
    const previous = this.operations.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    this.operations.set(id, operation);
    void operation.finally(() => { if (this.operations.get(id) === operation) this.operations.delete(id); }).catch(() => {});
    return operation;
  }
  decorate(job: Json) {
    const binding = this.bindings[job.run_id];
    if (binding) job = { ...job, goal: job.goal || binding.admission.goal, workspace_id: job.workspace_id || binding.workspaceId, workspace: job.workspace || binding.admission.workspace_label };
    return binding ? { ...job, coordination: { task_id: binding.taskId, status: binding.status, synced: !binding.error && binding.status === (job.state === "cancelled" ? "canceled" : job.state), error: binding.error || "", uploaded_files: binding.uploaded || [] } } : job;
  }
  async submit(body: Json, workspaceLabel: string) {
    return this.serial(body.run_id, async () => {
      let binding = this.bindings[body.run_id];
      if (binding && binding.workspaceId !== body.workspace_id) throw new Error("workspace_permission_required");
      const capabilities = await this.client.request("capabilities");
      if (!capabilities.features?.includes("command_approval") || !capabilities.features?.includes("cloud_context") || !capabilities.features?.includes("run_limits")) throw new Error("local_adapter_upgrade_required");
      const admission = { run_id: body.run_id, device_id: this.deviceId, goal: body.goal, workspace_label: workspaceLabel.slice(0, 120), model: capabilities.model, sources: body.sources || [] };
      if (binding && JSON.stringify(binding.admission) !== JSON.stringify(admission)) throw new Error("idempotency_conflict");
      if (!binding) {
        binding = this.bindings[body.run_id] = { admission, workspaceId: body.workspace_id, started: false, seq: 0 };
        this.save(); // Before admission: uncertain responses reuse this exact UUID.
      }
      binding.deployment ||= Object.fromEntries(["contract", "engine", "model", "runtime_version", "adapter_version"].map(key => [key, capabilities[key]]));
      await this.call("local/devices/", { device_id: this.deviceId, name: "We-Meet Desktop" });
      if (binding.remote && !(this.dependencies.remoteWorkspaces?.() || []).includes(binding.workspaceId)) throw new Error("workspace_permission_required");
      const admitted = binding.remote ? { run: { id: body.run_id, execution_target: "local", status: binding.status }, task: { id: binding.taskId } } : await this.call("local/tasks/", binding.admission);
      if (admitted.run?.id !== body.run_id || admitted.run?.execution_target !== "local") throw new Error("local_coordination_mismatch");
      binding.taskId = admitted.task.id;
      this.save();
      if (!binding.claim) {
        binding.claim = await this.call(`local/runs/${body.run_id}/claim/`, { device_id: this.deviceId });
        if (binding.claim.run_id !== body.run_id || binding.claim.model !== admission.model || !/^[a-f0-9]{64}$/.test(binding.claim.ticket)) throw new Error("local_coordination_mismatch");
        binding.seq = binding.claim.report_seq;
        this.save();
      }
      if (binding.remote && (binding.claim.workspace_id !== binding.workspaceId || binding.claim.goal !== binding.admission.goal)) throw new Error("local_coordination_mismatch");
      if (admitted.run.status === "canceled" || binding.claim.cancel) {
        const canceled = await this.client.request("cancel", { run_id: body.run_id });
        binding.status = "canceled"; this.save(); return this.decorate(canceled);
      }
      if (!capabilities.features?.includes("cloud_context") || !capabilities.features?.includes("run_limits")) throw new Error("local_adapter_upgrade_required");
      binding.started = true;
      this.save(); // Commit intent before runtime admission; never change payload.
      const job = await this.client.request("submit", { run_id: body.run_id, workspace_id: body.workspace_id, goal: binding.claim.goal, files: binding.claim.files, limits: binding.claim.limits });
      // Metadata reporting failure cannot turn an admitted execution into a retry.
      try { await this.report(body.run_id, job); }
      catch { binding.error = "local_cloud_pending"; this.save(); }
      return this.decorate(job);
    });
  }
  private async report(id: string, job: Json) {
    const binding = this.bindings[id];
    if (!binding?.claim || this.stopped) return;
    if (!binding.pending) {
      const deployment = Object.fromEntries(["contract", "engine", "model", "runtime_version", "adapter_version"].map(key => [key, job.deployment?.[key] || binding.deployment?.[key]]));
      const metering = { calls: job.metering.calls, complete: job.metering.complete, usage: job.metering.usage };
      const report = { device_id: this.deviceId, ticket: binding.claim.ticket, seq: binding.seq + 1, state: job.state, deployment, metering, error_code: job.error_code, artifacts: (job.result?.artifacts || []).map((f: Json) => ({ name: f.name, sha256: f.sha256, bytes: Buffer.byteLength(f.text, "utf8") })) };
      const stable = createHash("sha256").update(JSON.stringify({ ...report, seq: 0 })).digest("hex");
      // Active reports are also heartbeats; final metadata is reported only on change.
      if (!["queued", "running"].includes(job.state) && binding.lastReport === stable) return;
      binding.pending = report;
      this.save();
    }
    const response = await this.call(`local/runs/${id}/report/`, binding.pending);
    if (response.run_id !== id || response.report_seq !== binding.pending.seq) throw new Error("local_coordination_mismatch");
    binding.lastReport = createHash("sha256").update(JSON.stringify({ ...binding.pending, seq: 0 })).digest("hex");
    binding.seq = response.report_seq;
    binding.status = response.status;
    binding.uploaded = response.uploaded_files;
    binding.pending = undefined;
    binding.error = "";
    this.save();
    if (response.cancel) await this.client.request("cancel", { run_id: id });
  }
  async reconcile(id: string) {
    return this.serial(id, async () => {
      const job = await this.client.request("get", { run_id: id });
      if (this.bindings[id]?.started) {
        try { await this.report(id, job); }
        catch (error) {
          this.bindings[id].error = "local_cloud_pending"; this.save();
          if (error instanceof Error && /local_assignment_invalid|access_revoked|local_http_403|local_http_404/.test(error.message)) await this.client.request("cancel", { run_id: id });
        }
      }
      return this.decorate(await this.client.request("get", { run_id: id }));
    });
  }
  async cancel(id: string) {
    // Native cancel first even when cloud is unavailable; the durable report retries.
    await this.client.request("cancel", { run_id: id });
    const binding = this.bindings[id];
    if (binding) {
      try {
        const value = await this.dependencies.request(`runs/${id}/cancel/`, {});
        binding.status = value.status; binding.error = ""; this.save();
      } catch { binding.error = "local_cloud_pending"; this.save(); }
    }
    return this.reconcile(id);
  }
  async syncFiles(id: string, names: string[]) {
    return this.serial(id, async () => {
      const binding = this.bindings[id];
      if (!binding?.claim || !binding.started) throw new Error("local_task_not_registered");
      const job = await this.client.request("get", { run_id: id });
      await this.report(id, job);
      // Flush a previous uncertain report before uploading current final metadata.
      await this.report(id, job);
      if (job.state !== "succeeded" || binding.status !== "succeeded") throw new Error("artifact_not_ready");
      const files = names.map(name => job.result.artifacts.find((f: Json) => f.name === name));
      if (files.some(f => !f)) throw new Error("invalid_local_request");
      const response = await this.call(`local/runs/${id}/sync/`, { device_id: this.deviceId, ticket: binding.claim.ticket, files });
      binding.uploaded = response.uploaded_files;
      binding.error = ""; this.save();
      return this.decorate(job);
    });
  }
  private async tick() {
    if (this.syncing || this.stopped) return;
    this.syncing = true;
    try {
      for (const [id, binding] of Object.entries(this.bindings)) {
        if (!binding.started || this.stopped) continue;
        await this.reconcile(id).catch(() => {});
      }
      if ((this.dependencies.remoteWorkspaces?.() || []).length) await this.inbox().catch(() => {});
    } finally { this.syncing = false; }
  }
  async close() {
    clearInterval(this.timer);
    // Prevent new network work immediately; native close persists cancellation.
    this.stopped = true;
    await Promise.allSettled([...this.operations.values()]);
  }
}
