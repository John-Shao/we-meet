const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { RemoteControlCloud } = require("../dist/remote-control/cloud.js");
const { canonical, sessionKey, signProof, verifyLease, AUDIENCE } = require("../dist/remote-control/authorization.js");

const room = "12345678-1234-1234-1234-123456789012";
const session = "87654321-1234-1234-1234-123456789012";
const response = (data, status = 200) => new Response(JSON.stringify({ serverTime: 1800000000, ...data }), { status });
const auth = () => ({ epoch: 1, signedIn: true, access: async () => "test-token-not-a-real-credential" });

test("cloud only constructs fixed endpoints and never accepts arbitrary paths", async () => {
  const calls = [];
  const cloud = new RemoteControlCloud("https://meet.example.test", auth(), async (url, options) => {
    calls.push({ url, options }); return response({ state: "ACTIVE" });
  }, () => 100);
  const result = await cloud.request("lease", room, { sessionId: session, body: { challengeId: room, signature: "proof" } });
  assert.equal(calls[0].url, `https://meet.example.test/api/v1.0/rooms/${room}/remote-control/${session}/lease/`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(result.serverTime, 1800000000);
  for (const [action, id, options] of [["__proto__", room, {}], ["session", "../admin", {}], ["lease", room, {}], ["capabilities", room, { sessionId: session }], ["session", room, { sessionId: session, body: {} }]]) {
    await assert.rejects(cloud.request(action, id, options), /invalid_remote_request/);
  }
  assert.equal(calls.length, 1);
  for (const origin of ["http://meet.example.test", "https://meet.example.test/api", "https://name:password@meet.example.test"]) {
    assert.throws(() => new RemoteControlCloud(origin, auth()), /invalid_service_origin/);
  }
});

test("account epoch changes during credential or HTTP waits cannot return a usable response", async () => {
  const a = auth();
  a.access = async () => { a.epoch++; return "expired-account-token"; };
  let fetched = false;
  await assert.rejects(new RemoteControlCloud("https://meet.example.test", a, async () => { fetched = true; return response({}); }).request("capabilities", room), /remote_account_changed/);
  assert.equal(fetched, false);
  const b = auth();
  const cloud = new RemoteControlCloud("https://meet.example.test", b, async () => { b.epoch++; return response({}); });
  await assert.rejects(cloud.request("capabilities", room), /remote_account_changed/);
});

test("stream limits apply without Content-Length; unknown upstream errors are redacted", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2_100_001)); }, cancel() { cancelled = true; } });
  const oversized = new RemoteControlCloud("https://meet.example.test", auth(), async () => new Response(stream));
  await assert.rejects(oversized.request("capabilities", room), /remote_response_oversize/);
  assert.equal(cancelled, true);
  for (const [code, expected] of [["upstream-secret-text", "remote_request_failed"], ["busy", "busy"]]) {
    const cloud = new RemoteControlCloud("https://meet.example.test", auth(), async () => response({ code, detail: "must-never-reach-renderer" }, 409));
    await assert.rejects(cloud.request("capabilities", room), error => error.message === expected && !JSON.stringify(error).includes("must-never"));
  }
});

test("restricted canonical JSON rejects values without a cross-language representation", () => {
  assert.equal(new TextDecoder().decode(canonical({ z: "中文", a: 1 })), '{"a":1,"z":"中文"}');
  for (const invalid of [1.5, NaN, Infinity, 2**53, undefined, "\ud800", { "键": 1 }, new Array(2), [undefined], new Date(), { x: "a".repeat(4097) }]) {
    assert.throws(() => canonical(invalid));
  }
});

function python(script, data) {
  const result = spawnSync("python", ["-c", script], { input: JSON.stringify(data), encoding: "utf8",
    env: { ...process.env, PYTHONPATH: path.resolve(__dirname, "../../backend") }, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("WebCrypto approval proof verifies with backend P1363 and private key stays nonexportable", async () => {
  const pair = await sessionKey();
  assert.equal(pair.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("jwk", pair.privateKey));
  const payload = { v: 1, audience: AUDIENCE, purpose: "approve", scope: ["pointer", "keyboard", "text"], binding: { sessionId: session, displayBindingHash: "a".repeat(64) }, expiresAt: 1800000015 };
  const signed = await signProof(payload, pair.privateKey);
  const script = "import sys,json; from core.services.remote_control_crypto import verify_consent; d=json.load(sys.stdin); verify_consent(d['key'],d['payload'],d['signature'])";
  python(script, { key: pair.publicKey, payload, signature: signed });
});

function leaseFixture() {
  return JSON.parse(python(`import json,sys
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from core.services.remote_control_crypto import issue_lease,encode64
d=json.load(sys.stdin)
k=ec.generate_private_key(ec.SECP256R1()); n=k.public_key().public_numbers()
pem=k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())
b={**d,'epoch':1,'state':'ACTIVE','stateVersion':3,'policyDigest':'a'*64,'maxExpiresAt':1800001800}
token=issue_lease(b,pem=pem,kid='test-key',issued_at=1800000000,expires_at=1800000015)
print(json.dumps({'token':token,'key':{'kty':'EC','crv':'P-256','x':encode64(n.x.to_bytes(32,'big')),'y':encode64(n.y.to_bytes(32,'big')),'kid':'test-key','alg':'ES256'}}))`, { sessionId: session, targetDeviceSessionId: room, targetPublicKey: { x: "local-key" }, shareInstanceId: room, trackSid: "TR_bound", displayBindingHash: "b".repeat(64) }));
}
const binding = { sessionId: session, targetDeviceSessionId: room, targetPublicKey: { x: "local-key" }, shareInstanceId: room, trackSid: "TR_bound", displayBindingHash: "b".repeat(64) };
test("backend lease uses trusted server time and subtracts round-trip and timestamp budget", async () => {
  const fixture = leaseFixture();
  const consent = { binding, epoch: 1, state: "ACTIVE", maximumDeadline: 1800000 };
  const result = await verifyLease(fixture.token, fixture.key, consent, { serverTime: 1800000000, startedAt: 100, now: 400 });
  assert.equal(result.remainingMs, 13700);
  assert.equal(result.deadline, 14100);
  const bounded = await verifyLease(fixture.token, fixture.key, { ...consent, maximumDeadline: 500 }, { serverTime: 1800000000, startedAt: 100, now: 400 });
  assert.equal(bounded.remainingMs, 100);
  await assert.rejects(verifyLease(fixture.token, fixture.key, consent, { serverTime: 1800000014, startedAt: 100, now: 400 }), /lease_expired/);
  await assert.rejects(verifyLease(fixture.token, fixture.key, consent, { serverTime: 1800000020, startedAt: 100, now: 400 }));
});

test("a valid server signature cannot replace native consent key, source, epoch or state", async () => {
  const fixture = leaseFixture();
  const consent = { binding, epoch: 1, state: "ACTIVE", maximumDeadline: 1800000 };
  const clock = { serverTime: 1800000000, startedAt: 100, now: 400 };
  for (const change of [{ binding: { ...binding, targetPublicKey: { x: "renderer-key" } } }, { binding: { ...binding, trackSid: "TR_other" } }, { binding: { ...binding, shareInstanceId: session } }, { epoch: 2 }, { state: "PAUSED" }]) {
    await assert.rejects(verifyLease(fixture.token, fixture.key, { ...consent, ...change }, clock), /lease_binding_mismatch/);
  }
  await assert.rejects(verifyLease(fixture.token, { ...fixture.key, kid: "unknown-key" }, consent, clock), /invalid_lease/);
});
