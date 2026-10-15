/** Browser-compatible v1 signal schema. Input events retain their binary codec. */
import { canonical, publicKeyBytes, type PublicKey } from "./authorization";
import { base64url, bytesFromUuid, decodeBase64url } from "./wire";

export const SIGNAL_TOPIC = "we-meet.remote-control.v1.signal";
export const INPUT_TOPIC = "we-meet.remote-control.v1.input";
export const SIGNAL_AUDIENCE = "we-meet.remote-control.signal.v1";
export type ControllerSignal = "HELLO" | "HEARTBEAT" | "INPUT_SUSPEND" | "INPUT_RESUME" | "END";
export type TargetSignal = "CHALLENGE" | "READY" | "HEARTBEAT_ACK" | "INPUT_ACK" | "SUSPEND_ACK" | "STATE";
export type SignalType = ControllerSignal | TargetSignal;
export type SignalBinding = {
  roomId: string; roomSid: string; sessionId: string; shareInstanceId: string; trackSid: string;
  controllerIdentity: string; controllerSid: string; targetIdentity: string; targetSid: string;
};
export type SignalPayload = {
  v: 1; audience: typeof SIGNAL_AUDIENCE; roomId: string; roomSid: string;
  sessionId: string; shareInstanceId: string; trackSid: string; epoch: number;
  inputGeneration: string | null; seq: number; from: string; to: string;
  type: SignalType; body: Record<string, unknown>;
};
const controllerTypes = new Set<string>(["HELLO", "HEARTBEAT", "INPUT_SUSPEND", "INPUT_RESUME", "END"]);
const targetTypes = new Set<string>(["CHALLENGE", "READY", "HEARTBEAT_ACK", "INPUT_ACK", "SUSPEND_ACK", "STATE"]);
const nonce = (value: unknown) => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;
const keys = (value: object, expected: string) => Object.keys(value).sort().join(",") === expected;

export function validateSignal(payload: SignalPayload, direction?: "controller" | "target"): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !keys(payload,
    "audience,body,epoch,from,inputGeneration,roomId,roomSid,seq,sessionId,shareInstanceId,to,trackSid,type,v")) throw new Error("invalid_signal");
  if (payload.v !== 1 || payload.audience !== SIGNAL_AUDIENCE || !count(payload.epoch, 0xffffffff) || !count(payload.seq) ||
    typeof payload.from !== "string" || !payload.from || payload.from.length > 512 ||
    typeof payload.to !== "string" || !payload.to || payload.to.length > 512 || payload.from === payload.to ||
    !/^RM_[A-Za-z0-9_-]{1,100}$/.test(payload.roomSid) || !/^TR_[A-Za-z0-9_-]{1,120}$/.test(payload.trackSid)) throw new Error("invalid_signal");
  for (const id of [payload.roomId, payload.sessionId, payload.shareInstanceId]) bytesFromUuid(id);
  if (payload.inputGeneration !== null) bytesFromUuid(payload.inputGeneration);
  if (!(direction === "controller" ? controllerTypes : direction === "target" ? targetTypes : new Set([...controllerTypes, ...targetTypes])).has(payload.type)) throw new Error("invalid_signal_type");
  const b = payload.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("invalid_signal_body");
  let valid = false;
  switch (payload.type) {
    case "HELLO": case "HEARTBEAT": case "INPUT_SUSPEND":
      valid = keys(b, "captureReady,challenge,videoReady") && nonce(b.challenge) && typeof b.captureReady === "boolean" && typeof b.videoReady === "boolean";
      if (payload.type === "HELLO") valid = valid && b.captureReady === true && b.videoReady === true && payload.inputGeneration === null;
      if (payload.type === "INPUT_SUSPEND") valid = valid && b.captureReady === false;
      break;
    case "INPUT_RESUME":
      valid = keys(b, "captureReady,challenge,resumeChallenge,videoReady") && nonce(b.challenge) && nonce(b.resumeChallenge) && b.captureReady === true && b.videoReady === true && payload.inputGeneration === null;
      break;
    case "END": valid = keys(b, "challenge") && nonce(b.challenge); break;
    case "CHALLENGE":
      valid = keys(b, "challenge,inputChallenge,resumeChallenge,state,ttlMs") && nonce(b.challenge) &&
        (b.inputChallenge === null || nonce(b.inputChallenge)) && (b.resumeChallenge === null || nonce(b.resumeChallenge)) &&
        ["ACTIVE", "PAUSED"].includes(b.state as string) && count(b.ttlMs, 3000); break;
    case "READY": valid = keys(b, "height,inputChallenge,ttlMs,width") && nonce(b.inputChallenge) && count(b.ttlMs, 3000) &&
      count(b.width, 65536) && count(b.height, 65536) && payload.inputGeneration !== null; break;
    case "HEARTBEAT_ACK": valid = keys(b, "heartbeatSeq") && count(b.heartbeatSeq); break;
    case "INPUT_ACK": valid = keys(b, "lastAppliedInputSeq") && count(b.lastAppliedInputSeq) && payload.inputGeneration !== null; break;
    case "SUSPEND_ACK": valid = keys(b, "requestSeq,resumeChallenge,ttlMs") && count(b.requestSeq) && nonce(b.resumeChallenge) && count(b.ttlMs, 3000) && payload.inputGeneration === null; break;
    case "STATE": valid = keys(b, "state") && b.state === "PAUSED" && payload.inputGeneration === null; break;
  }
  if (!valid) throw new Error("invalid_signal_body");
  canonical(payload);
}

export function signalPayload(binding: SignalBinding, direction: "controller" | "target", epoch: number,
  inputGeneration: string | null, seq: number, type: SignalType, body: Record<string, unknown>): SignalPayload {
  const payload: SignalPayload = { v: 1, audience: SIGNAL_AUDIENCE, roomId: binding.roomId, roomSid: binding.roomSid,
    sessionId: binding.sessionId, shareInstanceId: binding.shareInstanceId, trackSid: binding.trackSid, epoch, inputGeneration, seq,
    from: direction === "controller" ? binding.controllerIdentity : binding.targetIdentity,
    to: direction === "controller" ? binding.targetIdentity : binding.controllerIdentity, type, body };
  validateSignal(payload, direction); return payload;
}

export async function signSignal(payload: SignalPayload, key: CryptoKey): Promise<Uint8Array> {
  validateSignal(payload);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, canonical(payload)));
  if (signature.length !== 64) throw new Error("invalid_signature_encoding");
  return canonical({ ...payload, signature: base64url(signature) });
}

export async function importSignalKey(key: PublicKey): Promise<CryptoKey> {
  publicKeyBytes(key);
  return crypto.subtle.importKey("jwk", key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

export async function verifySignal(packet: Uint8Array, key: CryptoKey, binding: SignalBinding,
  direction: "controller" | "target"): Promise<SignalPayload> {
  if (!(packet instanceof Uint8Array) || packet.byteLength > 8192 || packet.byteLength < 2) throw new Error("invalid_signal_size");
  const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packet));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || typeof decoded.signature !== "string") throw new Error("invalid_signal");
  const { signature, ...payload } = decoded;
  validateSignal(payload, direction);
  const expected = signalPayload(binding, direction, payload.epoch, payload.inputGeneration, payload.seq, payload.type, payload.body);
  if (new TextDecoder().decode(canonical(expected)) !== new TextDecoder().decode(canonical(payload))) throw new Error("signal_binding_mismatch");
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeBase64url(signature, 64), canonical(payload))) throw new Error("invalid_signal_signature");
  return payload;
}

/** Sequence is committed only after verification. A bootstrap CHALLENGE may
 * establish B's initial cursor; every subsequent signal must be contiguous. */
export class SignalSequence {
  private last = 0;
  accept(seq: number, bootstrap = false): boolean {
    if (!count(seq)) throw new Error("invalid_signal_sequence");
    if (seq <= this.last) return false;
    if (seq !== this.last + 1 && !(bootstrap && this.last === 0)) throw new Error("signal_gap");
    this.last = seq; return true;
  }
}
