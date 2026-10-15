/** Shared proof encoding and main-process lease validation. No Renderer trust. */
import { base64url, decodeBase64url } from "./wire";

export const AUDIENCE = "we-meet.remote-control.v1";
export type PublicKey = { kty: "EC"; crv: "P-256"; x: string; y: string };
export type SigningKey = PublicKey & { kid: string; alg: "ES256" };
export type ConsentRecord = { binding: Record<string, unknown>; epoch: number; state: "ACTIVE" | "PAUSED"; maximumDeadline: number };
export type LeaseClock = { serverTime: number; startedAt: number; now: number };

function validText(value: string) {
  for (let i = 0; i < value.length; ++i) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("invalid_unicode");
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("invalid_unicode");
  }
  if (new TextEncoder().encode(value).length > 4096) throw new Error("invalid_payload");
}

export function canonical(value: unknown): Uint8Array<ArrayBuffer> {
  function encode(item: unknown, depth: number): string {
    if (depth > 8) throw new Error("invalid_payload");
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isSafeInteger(item)) return JSON.stringify(item);
    if (typeof item === "string") { validText(item); return JSON.stringify(item); }
    if (Array.isArray(item) && item.length <= 64) return "[" + Array.from(item, entry => encode(entry, depth + 1)).join(",") + "]";
    if (typeof item === "object" && item !== null && Object.getPrototypeOf(item) === Object.prototype) {
      const keys = Object.keys(item).sort();
      if (keys.length > 64 || keys.some(key => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))) throw new Error("invalid_key");
      return "{" + keys.map(key => JSON.stringify(key) + ":" + encode((item as Record<string, unknown>)[key], depth + 1)).join(",") + "}";
    }
    throw new Error("invalid_payload");
  }
  const result = new TextEncoder().encode(encode(value, 0));
  if (result.length > 8192) throw new Error("invalid_payload");
  return result;
}

export async function sessionKey(): Promise<{ privateKey: CryptoKey; publicKey: PublicKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: { kty: "EC", crv: "P-256", x: exported.x!, y: exported.y! } };
}

export async function signProof(payload: Record<string, unknown>, key: CryptoKey): Promise<string> {
  if (payload.v !== 1 || payload.audience !== AUDIENCE || !["prepare", "approve", "resume", "lease"].includes(payload.purpose as string)) {
    throw new Error("invalid_purpose");
  }
  const bytes = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, canonical(payload)));
  if (bytes.length !== 64) throw new Error("invalid_signature_encoding");
  return base64url(bytes);
}

export function publicKeyBytes(key: PublicKey): Uint8Array {
  if (key.kty !== "EC" || key.crv !== "P-256" || Object.keys(key).sort().join(",") !== "crv,kty,x,y") throw new Error("invalid_public_key");
  const raw = new Uint8Array(65); raw[0] = 4;
  raw.set(decodeBase64url(key.x, 32), 1); raw.set(decodeBase64url(key.y, 32), 33);
  return raw;
}

export async function verifyLease(token: string, trusted: SigningKey, consent: ConsentRecord, clock: LeaseClock): Promise<{ deadline: number; remainingMs: number; stateVersion: number }> {
  if (token.length > 16384 || trusted.alg !== "ES256" || !/^[A-Za-z0-9_-]{1,64}$/.test(trusted.kid) ||
    !Number.isSafeInteger(clock.serverTime) || !Number.isFinite(clock.startedAt) || !Number.isFinite(clock.now) || clock.now < clock.startedAt ||
    !Number.isFinite(consent.maximumDeadline) || consent.maximumDeadline <= clock.now) throw new Error("invalid_lease");
  const { importJWK, jwtVerify } = await import("jose");
  const { payload, protectedHeader } = await jwtVerify(token, await importJWK(trusted, "ES256"), {
    algorithms: ["ES256"], audience: AUDIENCE, typ: "JWT", currentDate: new Date(clock.serverTime * 1000),
  });
  if (protectedHeader.kid !== trusted.kid || Object.keys(protectedHeader).sort().join(",") !== "alg,kid,typ" || payload.v !== 1 ||
    !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) || payload.iat! > clock.serverTime ||
    payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 15) throw new Error("invalid_lease");
  const binding = payload.binding as Record<string, unknown>;
  const variable = ["epoch", "state", "stateVersion", "policyDigest", "maxExpiresAt"];
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || binding.epoch !== consent.epoch || binding.state !== consent.state ||
    !Number.isSafeInteger(binding.stateVersion) || (binding.stateVersion as number) < 1 || !Number.isSafeInteger(binding.maxExpiresAt) ||
    payload.exp! > (binding.maxExpiresAt as number) || typeof binding.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(binding.policyDigest)) throw new Error("lease_binding_mismatch");
  const base = Object.fromEntries(Object.entries(binding).filter(([key]) => !variable.includes(key)));
  if (new TextDecoder().decode(canonical(base)) !== new TextDecoder().decode(canonical(consent.binding))) throw new Error("lease_binding_mismatch");
  // Whole round-trip + one second timestamp quantization are deducted. A stale
  // receipt must use the fresh top-level serverTime supplied by the HTTP API.
  const remainingMs = Math.floor(Math.min(consent.maximumDeadline - clock.now,
    (payload.exp! - clock.serverTime) * 1000 - (clock.now - clock.startedAt) - 1000));
  if (remainingMs <= 0 || remainingMs > 15000) throw new Error("lease_expired");
  return { deadline: clock.now + remainingMs, remainingMs, stateVersion: binding.stateVersion as number };
}
