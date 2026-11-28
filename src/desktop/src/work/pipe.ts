/** The shell's named-pipe client to the Work device Broker (device-design §1, §3).
 * Net-new: the desktop had no pipe client before M2. Framing is the Broker's own contract
 * (ipc/frame.rs): 4-byte BIG-endian length + payload, single frame ≤ 64KiB. The one-time
 * handshake (ipc/handshake.rs) is server-hello {nonce, protocol_major} → client-hello
 * {nonce, protocol_major, client_kind:"shell"}; a refusal closes the connection.
 * Requests are sequential: the Broker answers one message at a time on one instance. */
import { randomUUID } from "node:crypto";
import net from "node:net";

export const PROTOCOL_MAJOR = 2;
export const MAX_FRAME_BYTES = 64 * 1024;
const LENGTH_PREFIX = 4;
/** The shell→Broker methods M2 drives plus the 批2 confirmation face (ipc/schema.rs CORE_METHODS).
 * The remaining six closed members are legal but unlanded; this client never calls them. */
export type BrokerMethod =
  | "getDeviceIdentity"
  | "signDevicePairing"
  | "signDeviceCertificateRenewal"
  | "deliverDeviceCertificate"
  | "redeliverDeviceCertificate"
  | "getDeviceCertificateStatus"
  | "deliverDeviceSessionTicket"
  | "chooseWorkspace"
  | "confirmWorkspaceRoot"
  | "probeLocalModel"
  | "confirmLocalModel"
  | "stageLocalInput"
  | "confirmLocalSubmission"
  | "openLocalContent"
  | "exportArtifactVersion"
  | "prepareLocalApprovalDecision"
  | "prepareLocalAcceptance"
  | "listLocalArtifactDrafts"
  | "prepareLocalArtifactEdit"
  | "decideLocalArtifactEdit"
  | "completeLocalArtifactEdit"
  | "rebindRunWorkspace"
  | "listWorkspaceGrants"
  | "getModelProbeReceipts"
  | "confirmModelProbeReceiptDelivery";
const METHODS: ReadonlySet<string> = new Set<BrokerMethod>([
  "getDeviceIdentity",
  "signDevicePairing",
  "signDeviceCertificateRenewal",
  "deliverDeviceCertificate",
  "redeliverDeviceCertificate",
  "getDeviceCertificateStatus",
  "deliverDeviceSessionTicket",
  "chooseWorkspace",
  "confirmWorkspaceRoot",
  "probeLocalModel",
  "confirmLocalModel",
  "stageLocalInput",
  "confirmLocalSubmission",
  "openLocalContent",
  "exportArtifactVersion",
  "prepareLocalApprovalDecision",
  "prepareLocalAcceptance",
  "listLocalArtifactDrafts",
  "prepareLocalArtifactEdit",
  "decideLocalArtifactEdit",
  "completeLocalArtifactEdit",
  "rebindRunWorkspace",
  "listWorkspaceGrants",
  "getModelProbeReceipts",
  "confirmModelProbeReceiptDelivery",
]);
/** The closed refusal codes (ipc/dispatch.rs CODES). */
const CODES = new Set([
  "unknown_method",
  "method_not_implemented",
  "schema",
  "shape",
  "foreign_device",
  "already_consumed",
  "handshake",
  "no_pairing",
  "certificate_invalid",
]);
export class BrokerPipeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "BrokerPipeError";
  }
}
export interface BrokerReply {
  data?: Record<string, unknown>;
}

export function encodeFrame(payload: Uint8Array): Buffer {
  if (payload.length > MAX_FRAME_BYTES)
    throw new BrokerPipeError("frame_oversize");
  const frame = Buffer.alloc(LENGTH_PREFIX + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  frame.set(payload, LENGTH_PREFIX);
  return frame;
}

export class BrokerPipe {
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private frames: Buffer[] = [];
  private waiters: ((frame: Buffer | null) => void)[] = [];
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private failure?: Error;

  /** Attach within a budget. A single-instance pipe reports ERROR_PIPE_BUSY between one
   * client's close and the server's next ConnectNamedPipe, so the attach retries. */
  static async connect(name: string, budgetMs = 5000): Promise<BrokerPipe> {
    const pipe = new BrokerPipe();
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (pipe.closed) throw new BrokerPipeError("pipe_closed");
      try {
        await pipe.attach(name);
        break;
      } catch (error) {
        if (Date.now() >= deadline)
          throw error instanceof BrokerPipeError
            ? error
            : new BrokerPipeError("pipe_unavailable");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      const hello = await pipe.readFrame(5000);
      const value = JSON.parse(hello.toString("utf8")) as {
        nonce?: unknown;
        protocol_major?: unknown;
      };
      if (
        !value ||
        Object.keys(value).sort().join(",") !== "nonce,protocol_major" ||
        typeof value.nonce !== "string" ||
        value.protocol_major !== PROTOCOL_MAJOR
      ) {
        throw new BrokerPipeError("handshake");
      }
      pipe.writeJson({
        nonce: value.nonce,
        protocol_major: PROTOCOL_MAJOR,
        client_kind: "shell",
      });
      return pipe;
    } catch (error) {
      pipe.close();
      throw error instanceof BrokerPipeError
        ? error
        : new BrokerPipeError("handshake");
    }
  }

  private attach(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(name);
      // Permanent handlers land only after a successful connect: a refused attach must leave
      // the client retryable, not poisoned by a failure state from the attempt that never lived.
      const onConnect = () => {
        socket.removeListener("error", onError);
        this.socket = socket;
        socket.on("data", (chunk: Buffer) => this.receive(chunk));
        socket.on("error", () => this.fail(new BrokerPipeError("pipe_io")));
        socket.on("close", () => this.fail(new BrokerPipeError("pipe_closed")));
        resolve();
      };
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  /** One closed call: send {method, request_id, ...fields}, await the echoed reply. Fields are
   * strings for the §2.1 carriers; the 批2 confirmation carriers also pass a bool (approved), an
   * array (artifact_dir) and an object (listener_requirement), so the value type is unknown. */
  call(
    method: BrokerMethod,
    fields: Record<string, unknown> = {},
    timeoutMs = 8000,
  ): Promise<BrokerReply> {
    const result = this.tail.then(() =>
      this.callOnce(method, fields, timeoutMs),
    );
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async callOnce(
    method: BrokerMethod,
    fields: Record<string, unknown> = {},
    timeoutMs = 8000,
  ): Promise<BrokerReply> {
    if (this.closed || this.failure)
      throw this.failure ?? new BrokerPipeError("pipe_closed");
    if (!METHODS.has(method)) throw new BrokerPipeError("unknown_method");
    for (const forbidden of ["command", "path", "url"]) {
      if (Object.hasOwn(fields, forbidden)) throw new BrokerPipeError("schema");
    }
    const requestId =
      typeof fields.request_id === "string" && fields.request_id.length > 0
        ? fields.request_id
        : randomUUID();
    this.writeJson({ ...fields, method, request_id: requestId });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new BrokerPipeError("pipe_timeout");
      const raw = await this.readFrame(remaining);
      let reply: {
        request_id?: unknown;
        method?: unknown;
        result?: unknown;
        code?: unknown;
        data?: unknown;
      };
      try {
        reply = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new BrokerPipeError("schema");
      }
      if (!reply || reply.request_id !== requestId || reply.method !== method)
        continue;
      if (reply.result === "accepted") {
        if (
          reply.data !== undefined &&
          (typeof reply.data !== "object" ||
            reply.data === null ||
            Array.isArray(reply.data))
        ) {
          throw new BrokerPipeError("schema");
        }
        return { data: reply.data as Record<string, unknown> | undefined };
      }
      if (
        reply.result === "refused" &&
        typeof reply.code === "string" &&
        CODES.has(reply.code)
      ) {
        throw new BrokerPipeError(reply.code);
      }
      throw new BrokerPipeError("schema");
    }
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
    this.socket = undefined;
    this.fail(new BrokerPipeError("pipe_closed"));
  }

  private writeJson(value: Record<string, unknown>) {
    const socket = this.socket;
    if (this.closed || !socket || socket.destroyed)
      throw this.failure ?? new BrokerPipeError("pipe_closed");
    socket.write(encodeFrame(Buffer.from(JSON.stringify(value), "utf8")));
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX) return;
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        this.fail(new BrokerPipeError("frame_oversize"));
        return;
      }
      if (this.buffer.length < LENGTH_PREFIX + length) return;
      const payload = this.buffer.subarray(
        LENGTH_PREFIX,
        LENGTH_PREFIX + length,
      );
      this.buffer = this.buffer.subarray(LENGTH_PREFIX + length);
      const waiter = this.waiters.shift();
      if (waiter) waiter(Buffer.from(payload));
      else this.frames.push(Buffer.from(payload));
    }
  }

  private readFrame(timeoutMs: number): Promise<Buffer> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new BrokerPipeError("pipe_closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(onFrame);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new BrokerPipeError("pipe_timeout"));
      }, timeoutMs);
      const onFrame = (frame: Buffer | null) => {
        clearTimeout(timer);
        if (frame === null)
          reject(this.failure ?? new BrokerPipeError("pipe_closed"));
        else resolve(frame);
      };
      this.waiters.push(onFrame);
    });
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.socket?.destroy();
    // Wake every parked read with the failure itself, never a fabricated frame.
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}
