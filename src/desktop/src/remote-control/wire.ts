/** Browser/main/native v1 input contract. No Node or Electron imports here. */
export const INPUT_BYTES = 704;
export const SIGNED_BYTES = 640;
export const PROTOCOL_VERSION = 1;
export const INPUT_MAGIC = 0x31435257;
export const Command = { Hello: 1, Arm: 2, Challenge: 3, ParentAlive: 4, Close: 5, Lease: 6, Input: 7, Consent: 8, Suspend: 9, Pause: 10 } as const;
export const Kind = { Move: 1, Button: 2, Wheel: 3, Key: 4, Text: 5, Release: 6, Heartbeat: 7 } as const;
export type InputKind = (typeof Kind)[keyof typeof Kind];
export type Binding = { sessionId: string; shareInstanceId: string; inputGeneration: string; epoch: number };
export type InputEvent = Binding & {
  seq: number; challenge: string; kind: InputKind; action?: 0 | 1;
  code?: number; extended?: boolean; repeat?: boolean;
  x?: number; y?: number; delta?: number; text?: string;
};
export type Display = { left: number; top: number; width: number; height: number };
export type NativeDisplay = Display & { deviceName: string; devicePath: string; rotation: number; dpiX: number; dpiY: number };

export function bytesFromUuid(value: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("invalid_uuid");
  return bytesFromHex(value.replace(/-/g, ""), 16);
}
export function bytesFromHex(value: string, length: number): Uint8Array {
  if (value.length !== length * 2 || !/^[0-9a-f]+$/i.test(value)) throw new Error("invalid_hex");
  return Uint8Array.from(value.match(/../g)!, (pair) => parseInt(pair, 16));
}
export function base64url(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeBase64url(value: string, length?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 4096) throw new Error("invalid_base64");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  if ((length !== undefined && bytes.length !== length) || base64url(bytes) !== value) throw new Error("invalid_base64");
  return bytes;
}
function integer(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("invalid_integer");
  return value;
}
function coordinate(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("invalid_coordinate");
  return value;
}
export function encodeInput(event: InputEvent): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(SIGNED_BYTES), view = new DataView(bytes.buffer);
  view.setUint32(0, INPUT_MAGIC, true); view.setUint32(4, PROTOCOL_VERSION, true);
  bytes.set(bytesFromUuid(event.sessionId), 8); bytes.set(bytesFromUuid(event.shareInstanceId), 24);
  bytes.set(bytesFromUuid(event.inputGeneration), 40);
  view.setUint32(56, integer(event.epoch, 1, 0xffffffff), true);
  view.setUint16(60, integer(event.kind, 1, 7), true);
  view.setUint16(62, integer(event.action ?? 0, 0, 1), true);
  view.setBigUint64(64, BigInt(integer(event.seq, 1, Number.MAX_SAFE_INTEGER)), true);
  bytes.set(bytesFromHex(event.challenge, 16), 72);
  view.setUint32(88, integer(event.code ?? 0, 0, 0xffff), true);
  view.setUint32(92, (event.extended ? 1 : 0) | (event.repeat ? 2 : 0), true);
  view.setFloat64(96, coordinate(event.x ?? 0), true); view.setFloat64(104, coordinate(event.y ?? 0), true);
  view.setInt32(112, integer(event.delta ?? 0, -1200, 1200), true);
  const text = event.text ?? "";
  if (text.length > 256 || (text && event.kind !== Kind.Text)) throw new Error("invalid_text");
  // Reject unpaired surrogates; valid pairs remain two UTF-16 code units.
  for (let i=0;i<text.length;++i) {
    const unit=text.charCodeAt(i);
    if(unit>=0xd800 && unit<=0xdbff) {
      const next=text.charCodeAt(++i);
      if(!(next>=0xdc00 && next<=0xdfff))throw new Error("invalid_unicode");
    } else if(unit>=0xdc00 && unit<=0xdfff)throw new Error("invalid_unicode");
  }
  view.setUint32(116, text.length, true);
  for (let i = 0; i < text.length; ++i) view.setUint16(120 + i * 2, text.charCodeAt(i), true);
  return bytes;
}
export async function signInput(event: InputEvent, key: CryptoKey): Promise<Uint8Array> {
  const bytes = encodeInput(event);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes));
  if (signature.length !== 64) throw new Error("invalid_signature_encoding");
  const packet = new Uint8Array(INPUT_BYTES); packet.set(bytes); packet.set(signature, SIGNED_BYTES); return packet;
}
export function encodeArm(binding: Binding, display: Display, leaseMs: number, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("invalid_public_key");
  const bytes = new Uint8Array(136), view = new DataView(bytes.buffer);
  bytes.set(bytesFromUuid(binding.sessionId), 0); bytes.set(bytesFromUuid(binding.shareInstanceId), 16);
  bytes.set(bytesFromUuid(binding.inputGeneration), 32); view.setUint32(48, integer(binding.epoch, 1, 0xffffffff), true);
  view.setInt32(52, integer(display.left, -0x7fffffff, 0x7fffffff), true);
  view.setInt32(56, integer(display.top, -0x7fffffff, 0x7fffffff), true);
  view.setInt32(60, integer(display.width, 1, 65536), true); view.setInt32(64, integer(display.height, 1, 65536), true);
  view.setUint32(68, integer(leaseMs, 1, 15000), true); bytes.set(publicKey.subarray(1), 72); return bytes;
}

/** Never exposed as a renderer method: name and binding come from trusted main state. */
export function encodeConsent(id: string, binding: Binding, display: Display, publicKey: Uint8Array, controller: string, timeoutMs: number): Uint8Array {
  if (!controller.trim() || controller.length > 159 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(controller)) throw new Error("invalid_controller_name");
  // Reuse the Unicode validation of the input encoder without sending input.
  encodeInput({ ...binding, kind: Kind.Text, text: controller, seq: 1, challenge: "00".repeat(16) });
  const bytes = new Uint8Array(476), view = new DataView(bytes.buffer);
  bytes.set(encodeArm(binding, display, 1, publicKey));
  view.setUint32(136, integer(timeoutMs, 1, 60000), true);bytes.set(bytesFromUuid(id), 140);
  for(let i=0;i<controller.length;++i)view.setUint16(156+i*2,controller.charCodeAt(i),true);
  return bytes;
}
