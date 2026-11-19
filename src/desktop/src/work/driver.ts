/** The §2.1 pairing/certificate/ticket/renewal driver (M2 ruling 甲2). REST stays in this main
 * process; the Broker signs and reports over the pipe. The state machine is deliberately linear:
 *
 *   identity → (stored record ? re-deliver : dialog-confirm → pair → sign → confirm → deliver)
 *   → poll status → renewal window open ? renew : awaiting_ticket ? mint + deliver
 *
 * The certificate is persisted through DeviceStore (safeStorage) and re-delivered on every
 * Broker start, which is what closes the GW21 in-memory-store × 0058 renewal-window restart
 * deadlock. The device-name confirmation gesture is the SHELL's main-process dialog (M2 ruling),
 * not a Broker native dialog and not a renderer call — §1.1's deviation is registered in place.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkApi, WorkApiError, type WorkAuth } from "./api";
import { BrokerPipe, BrokerPipeError, type BrokerReply } from "./pipe";
import { BrokerSupervisor, type WorkDeviceDescriptor } from "./broker";
import { DeviceStore, type DeviceRecord } from "./store";

export interface WorkConfig {
  /** https://host:port of the device gateway's mTLS listener. */
  gatewayOrigin: string;
  /** Name verified against the gateway's server certificate. */
  serverName: string;
  /** Absolute path to the device CA root PEM the Broker anchors on. */
  caPemPath: string;
}
export interface BrokerConfigFile {
  pipe_name: string;
  shell_pid: number;
  endpoint: string;
  server_name: string;
  ca_pem_path: string;
  container: string;
  provider: string;
  boot_id: string;
  agent_instance_id: string;
  journal_dir: string;
  profile_id: string;
  tool_manifest_hash: string;
  runtime_digest: string;
  last_receipt_seq: number;
  connect_timeout_ms: number;
  reconnect_base_ms: number;
  reconnect_max_ms: number;
}
export interface BrokerHandle {
  pipe: Pick<BrokerPipe, "call" | "close">;
  stop(): Promise<unknown>;
}
export type BrokerFactory = (config: BrokerConfigFile, configPath: string) => Promise<BrokerHandle>;
export interface DriverDeps {
  auth: WorkAuth;
  api: WorkApi;
  work: WorkConfig;
  binding: { issuer: string; clientId: string; serviceOrigin: string };
  resourceRoot: string;
  descriptor?: WorkDeviceDescriptor | null;
  configDir: string;
  store: DeviceStore;
  /** The main-process device-name gesture. undefined = the user cancelled; no pairing happens. */
  askDeviceName(defaultName: string): Promise<string | undefined>;
  report(message: string): void;
  brokerFactory?: BrokerFactory;
  pollIntervalMs?: number;
}
export type DriverState = "idle" | "starting" | "running" | "stopped" | "failed";

const PROVIDER = "Microsoft Software Key Storage Provider";
// A2/A3 are not wired: no profile/tool/runtime facts exist yet. These are closed placeholders,
// registered as such — the gateway shape-checks them, nothing consumes them.
const PLACEHOLDER_DIGEST = createHash("sha256").update("work-device-m2-minimal").digest("hex");

/** boot_id derives from the OS boot identity (device-design §2.2): the boot instant computed
 * from the monotonic uptime, quantized to the minute so broker restarts within one OS boot
 * agree. The authoritative OS power/session watcher is a registered deferred item. */
export function bootId(nowMs: number = Date.now(), uptimeSeconds: number = os.uptime()): string {
  return `boot-${Math.floor((nowMs - uptimeSeconds * 1000) / 60000)}`;
}
export function containerFor(binding: { issuer: string; clientId: string; serviceOrigin: string }, subject: string): string {
  return "work-device-" + createHash("sha256")
    .update(`${binding.issuer}|${binding.clientId}|${binding.serviceOrigin}|${subject}`).digest("hex").slice(0, 40);
}

async function defaultBrokerFactory(resourceRoot: string, descriptor: WorkDeviceDescriptor | null | undefined): Promise<BrokerFactory> {
  return async (config, configPath) => {
    const supervisor = new BrokerSupervisor();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await supervisor.start(resourceRoot, configPath, config.pipe_name, descriptor);
    const pipe = await BrokerPipe.connect(config.pipe_name);
    return {
      pipe,
      stop: async () => { pipe.close(); await supervisor.stop(); },
    };
  };
}

export class WorkDeviceDriver {
  private state: DriverState = "idle";
  private broker?: BrokerHandle;
  private record?: DeviceRecord;
  private thumbprint = "";
  private orgId = "";
  private subject = "";
  private container = "";
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private epoch = -1;
  private factory?: BrokerFactory;
  private readonly pollIntervalMs: number;

  constructor(private readonly deps: DriverDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 10000;
  }
  get currentState(): DriverState { return this.state; }

  async start(): Promise<void> {
    if (this.state === "starting" || this.state === "running") return;
    if (process.platform !== "win32" || process.arch !== "x64" || !this.deps.auth.signedIn) {
      this.state = "idle";
      return;
    }
    this.state = "starting";
    this.epoch = this.deps.auth.epoch;
    try {
      const identity = await this.deps.api.request<{ org_id: string; subject_id: string }>("identity");
      this.checkEpoch();
      this.orgId = identity.org_id;
      this.subject = identity.subject_id;
      if (this.deps.auth.subject && this.subject !== this.deps.auth.subject) {
        throw new WorkApiError("work_account_changed");
      }
      this.container = containerFor(this.deps.binding, this.subject);
      const stored = this.deps.store.load();
      this.record = stored && stored.container === this.container && stored.orgId === this.orgId ? stored : undefined;

      const config = this.buildConfig();
      const configPath = path.join(this.deps.configDir, "broker.json");
      this.factory ??= this.deps.brokerFactory ?? await defaultBrokerFactory(this.deps.resourceRoot, this.deps.descriptor);
      this.broker = await this.factory(config, configPath);
      this.checkEpoch();
      const facts = await this.call("getDeviceIdentity");
      this.thumbprint = String(facts.data?.public_key_thumbprint ?? "");
      if (!this.thumbprint) throw new BrokerPipeError("shape");

      if (this.record) {
        try {
          // A fresh Broker has no signing history, so the stored chain goes through the
          // re-delivery carrier with the record's org declared explicitly (M2b ruling 甲).
          await this.redeliver(this.record.deviceId, this.record.certificatePem, this.record.orgId, this.record.subject);
        } catch (error) {
          // An expired or foreign chain cannot be re-delivered; the renewal face is the
          // re-issuance path (0058 ruling ②). Anything else is fatal for this record.
          if (error instanceof BrokerPipeError && error.code === "certificate_invalid") {
            await this.renew();
          } else {
            this.deps.store.clear();
            this.record = undefined;
            throw error;
          }
        }
      } else {
        const paired = await this.pair();
        if (!paired) {
          // The user cancelled the name gesture: no pairing row exists, so there is nothing to
          // run. This is a choice, not a failure — no error is reported.
          await this.teardown();
          this.state = "idle";
          return;
        }
      }
      this.checkEpoch();
      this.state = "running";
      this.timer = setInterval(() => { void this.poll(); }, this.pollIntervalMs);
    } catch (error) {
      await this.teardown();
      this.state = "failed";
      this.deps.report(this.failureMessage(error));
    }
  }

  async stop(): Promise<void> {
    await this.teardown();
    this.state = "stopped";
  }

  private async teardown() {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    const broker = this.broker;
    this.broker = undefined;
    if (broker) {
      try { broker.pipe.close(); } catch { /* already gone */ }
      await broker.stop().catch(() => undefined);
    }
  }

  private buildConfig(): BrokerConfigFile {
    return {
      pipe_name: `\\\\.\\pipe\\work-device-${randomUUID()}`,
      shell_pid: process.pid,
      endpoint: this.deps.work.gatewayOrigin,
      server_name: this.deps.work.serverName,
      ca_pem_path: this.deps.work.caPemPath,
      container: this.container,
      provider: PROVIDER,
      boot_id: bootId(),
      agent_instance_id: randomUUID(),
      // The Broker owns the journal epoch (device_meta); the shell only provides a stable base
      // directory under its per-user config dir. The Broker forms <journal_dir>/<device_id>.db
      // once the certificate reveals the device id, so a restart recovers the same epoch.
      journal_dir: path.join(this.deps.configDir, "journal"),
      profile_id: "profile-m2-minimal",
      tool_manifest_hash: PLACEHOLDER_DIGEST,
      runtime_digest: PLACEHOLDER_DIGEST,
      last_receipt_seq: 0,
      connect_timeout_ms: 10000,
      reconnect_base_ms: 1000,
      reconnect_max_ms: 30000,
    };
  }

  private async pair(): Promise<boolean> {
    const defaultName = `${os.hostname().slice(0, 100)}`;
    // §2.1 step 2: the user explicitly confirms the device name BEFORE any pairing request.
    // A cancelled dialog leaves zero rows behind — the gesture is the authorization.
    const name = await this.deps.askDeviceName(defaultName);
    this.checkEpoch();
    if (!name || !name.trim()) return false;
    const identity = await this.call("getDeviceIdentity");
    const jwk = identity.data?.public_key_jwk;
    if (!jwk || typeof jwk !== "object") throw new BrokerPipeError("shape");
    const pairing = await this.deps.api.request<{ pairing_id: string; challenge: string; device_id: string }>(
      "pair", { body: { client_request_id: randomUUID(), device_name: name.trim().slice(0, 120), platform: "windows-x64", public_key_jwk: jwk } });
    this.checkEpoch();
    const signed = await this.call("signDevicePairing", {
      pairing_id: pairing.pairing_id, challenge: pairing.challenge, org_id: this.orgId, subject_id: this.subject,
    });
    const confirmed = await this.deps.api.request<{ device_id: string; certificate_pem: string; cert_serial: string; cert_not_after: string }>(
      "confirmPairing", { id: pairing.pairing_id, body: { client_request_id: randomUUID(), challenge: pairing.challenge, signature: String(signed.data?.signature ?? "") } });
    this.checkEpoch();
    await this.deliver(confirmed.device_id, confirmed.certificate_pem);
    this.record = {
      ...this.deps.binding, subject: this.subject, orgId: this.orgId,
      deviceId: confirmed.device_id, container: this.container,
      certificatePem: confirmed.certificate_pem, certSerial: confirmed.cert_serial,
      certNotAfter: confirmed.cert_not_after,
    };
    this.deps.store.save(this.record);
    return true;
  }

  private async renew(): Promise<void> {
    if (!this.record) throw new BrokerPipeError("no_pairing");
    const challenge = await this.deps.api.request<{ pairing_id: string; challenge: string }>(
      "requestRenewal", { id: this.record.deviceId, body: { client_request_id: randomUUID() } });
    this.checkEpoch();
    const signed = await this.call("signDeviceCertificateRenewal", {
      pairing_id: challenge.pairing_id, challenge: challenge.challenge, org_id: this.orgId, subject_id: this.subject,
    });
    const confirmed = await this.deps.api.request<{ device_id: string; certificate_pem: string; cert_serial: string; cert_not_after: string }>(
      "confirmRenewal", { id: challenge.pairing_id, body: { client_request_id: randomUUID(), challenge: challenge.challenge, signature: String(signed.data?.signature ?? "") } });
    this.checkEpoch();
    await this.deliver(confirmed.device_id, confirmed.certificate_pem);
    this.record = { ...this.record, certificatePem: confirmed.certificate_pem, certSerial: confirmed.cert_serial, certNotAfter: confirmed.cert_not_after };
    this.deps.store.save(this.record);
  }

  private async mintAndDeliver(): Promise<void> {
    if (!this.record) return;
    const minted = await this.deps.api.request<{ ticket: string; session_ticket_id: string }>(
      "mintTicket", { id: this.record.deviceId, body: { client_request_id: randomUUID(), public_key_thumbprint: this.thumbprint } });
    this.checkEpoch();
    await this.call("deliverDeviceSessionTicket", {
      ticket: minted.ticket, device_id: this.record.deviceId, session_ticket_id: minted.session_ticket_id,
    });
  }

  private async poll(): Promise<void> {
    if (this.polling || this.state !== "running" || !this.broker) return;
    this.polling = true;
    try {
      const status = await this.call("getDeviceCertificateStatus");
      this.checkEpoch();
      const data = status.data ?? {};
      if (data.renewal_window_open === true) await this.renew();
      else if (data.awaiting_ticket === true) await this.mintAndDeliver();
    } catch (error) {
      if (this.state !== "running") return;
      if (error instanceof WorkApiError && (error.code === "unauthorized" || error.code === "work_account_changed")) {
        await this.stop();
        return;
      }
      if (error instanceof WorkApiError && error.code === "device_revoked") {
        this.deps.store.clear();
        this.record = undefined;
        await this.stop();
        this.deps.report("本机设备已被撤销，请重新配对。");
        return;
      }
      if (error instanceof BrokerPipeError && ["pipe_closed", "pipe_io", "pipe_unavailable"].includes(error.code)) {
        // The Broker process is gone; polling a dead pipe forever would hide it.
        await this.stop();
        this.deps.report("本机设备进程已停止，请重启客户端后重试。");
        return;
      }
      // Transient transport/window races wait for the next poll; no retry loop bypasses a refusal.
    } finally {
      this.polling = false;
    }
  }

  private async deliver(deviceId: string, certificatePem: string): Promise<void> {
    await this.call("deliverDeviceCertificate", { device_id: deviceId, certificate_pem: certificatePem });
  }

  private async redeliver(deviceId: string, certificatePem: string, orgId: string, subjectId: string): Promise<void> {
    await this.call("redeliverDeviceCertificate", { device_id: deviceId, certificate_pem: certificatePem, org_id: orgId, subject_id: subjectId });
  }

  private async call(method: Parameters<BrokerPipe["call"]>[0], fields: Record<string, string> = {}): Promise<BrokerReply> {
    if (!this.broker) throw new BrokerPipeError("pipe_closed");
    return this.broker.pipe.call(method, fields);
  }

  private checkEpoch() {
    if (!this.deps.auth.signedIn || this.deps.auth.epoch !== this.epoch) throw new WorkApiError("work_account_changed");
  }

  private failureMessage(error: unknown): string {
    if (error instanceof WorkApiError) {
      switch (error.code) {
        case "local_policy_not_configured":
        case "local_policy_incomplete":
          return "组织尚未配置本机执行策略，无法配对设备。";
        case "device_revoked":
          return "本机设备已被撤销，请重新配对。";
        case "work_auth_unavailable":
        case "unauthorized":
          return "登录已失效，请重新登录后再试。";
        case "work_account_changed":
          return "账号已切换，设备驱动已停止。";
      }
    }
    return "本机设备驱动启动失败，请重启客户端后重试。";
  }
}