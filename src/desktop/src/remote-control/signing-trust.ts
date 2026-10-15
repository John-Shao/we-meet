/** Bounded trust metadata received only from the authenticated service origin.
 * JWT headers select a known kid; they never supply a key or a discovery URL.
 */
import { canonical, publicKeyBytes, verifyLease, type ConsentRecord, type LeaseClock, type SigningKey } from "./authorization";

type VerificationKey = SigningKey & { verifyUntil: number | null };
export type SigningKeyRing = { v: 1; revision: number; generation: number; activeKid: string | null; keys: VerificationKey[] };
const kid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const same = (a: unknown, b: unknown) => new TextDecoder().decode(canonical(a)) === new TextDecoder().decode(canonical(b));

function parse(value: unknown): SigningKeyRing {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_signing_keys");
  const ring = value as SigningKeyRing;
  if (Object.keys(ring).sort().join(",") !== "activeKid,generation,keys,revision,v" || ring.v !== 1 ||
      !positive(ring.revision) || !positive(ring.generation) || (ring.activeKid !== null && !kid(ring.activeKid)) ||
      !Array.isArray(ring.keys) || ring.keys.length > 8) throw new Error("invalid_signing_keys");
  const ids = new Set<string>(), points = new Set<string>();
  for (const key of ring.keys) {
    if (!key || typeof key !== "object" || Object.keys(key).sort().join(",") !== "alg,crv,kid,kty,verifyUntil,x,y" ||
        key.alg !== "ES256" || !kid(key.kid) || ids.has(key.kid) ||
        (key.kid === ring.activeKid ? key.verifyUntil !== null : !positive(key.verifyUntil))) throw new Error("invalid_signing_keys");
    publicKeyBytes({ kty: key.kty, crv: key.crv, x: key.x, y: key.y });
    const point = `${key.x}:${key.y}`;
    if (points.has(point)) throw new Error("invalid_signing_keys");
    ids.add(key.kid); points.add(point);
  }
  if (ring.activeKid !== null && !ids.has(ring.activeKid)) throw new Error("invalid_signing_keys");
  canonical(ring);
  return JSON.parse(JSON.stringify(ring)) as SigningKeyRing;
}

export class SigningTrust {
  private ring: SigningKeyRing;
  private invalid = false;
  private readonly seen = new Map<string, string>();
  constructor(value: unknown) {
    this.ring = parse(value);
    if (!this.ring.activeKid) throw new Error("signing_unavailable");
    this.remember(this.ring);
  }
  get generation() { return this.ring.generation; }

  update(value: unknown, sessionGeneration: unknown) {
    try {
      if (this.invalid) throw new Error("invalid_signing_keys");
      const next = parse(value);
      if (next.generation !== this.ring.generation || sessionGeneration !== this.ring.generation) throw new Error("signing_generation_revoked");
      if (next.revision < this.ring.revision || (next.revision === this.ring.revision && !same(next, this.ring))) throw new Error("signing_keys_stale");
      if (!next.activeKid) throw new Error("signing_unavailable");
      if (next.revision === this.ring.revision) return;
      this.remember(next);
      this.ring = next;
    } catch (error) { this.invalid = true; throw error; }
  }

  private remember(ring: SigningKeyRing) {
    for (const key of ring.keys) {
      const point = `${key.x}:${key.y}`;
      if (this.seen.has(key.kid) && this.seen.get(key.kid) !== point) throw new Error("signing_key_reused");
      // At most 30 minutes per session; refuse unbounded operator churn too.
      if (!this.seen.has(key.kid) && this.seen.size >= 1024) throw new Error("invalid_signing_keys");
      this.seen.set(key.kid, point);
    }
  }

  async verify(token: string, consent: ConsentRecord, clock: LeaseClock) {
    if (this.invalid) throw new Error("invalid_signing_keys");
    const snapshot = this.ring;
    if (typeof token !== "string" || token.length > 16384) throw new Error("invalid_lease");
    const { decodeProtectedHeader, decodeJwt } = await import("jose");
    const header = decodeProtectedHeader(token);
    const key = snapshot.keys.find(entry => entry.kid === header.kid);
    if (!key) throw new Error("unknown_signing_key");
    const expires = decodeJwt(token).exp;
    if (key.verifyUntil !== null && (key.verifyUntil <= clock.serverTime ||
        !positive(expires) || expires > key.verifyUntil)) throw new Error("signing_key_expired");
    const { verifyUntil: _deadline, ...trusted } = key;
    const result = await verifyLease(token, trusted, consent, clock);
    // A concurrent planned rotation may retain this exact key. Revocation,
    // removal or a shorter retirement window must close even an in-flight verify.
    const current = this.ring.keys.find(entry => entry.kid === key.kid);
    if (this.invalid || !current || current.x !== key.x || current.y !== key.y ||
        (current.verifyUntil !== null && (!positive(expires) || expires > current.verifyUntil))) throw new Error("signing_keys_changed");
    return result;
  }
}
