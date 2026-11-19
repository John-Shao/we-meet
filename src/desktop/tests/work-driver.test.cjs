// The §2.1 driver state machine with injected fakes (REST face, Broker pipe, gesture, store).
// Ordering is asserted on one shared event log so "gesture before any pairing request" and
// "re-deliver before poll" are facts, not accidents of separate counters.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { WorkApiError } = require("../dist/work/api.js");
const { BrokerPipeError } = require("../dist/work/pipe.js");
const { WorkDeviceDriver, containerFor } = require("../dist/work/driver.js");
const { DeviceStore } = require("../dist/work/store.js");

const binding = { issuer: "https://id.example.test/realms/meet", clientId: "desktop", serviceOrigin: "https://meet.example.test" };
const subject = "subject-1";
const orgId = "org-1";
const deviceId = "abcdefab-abcd-abcd-abcd-abcdefabcdef";
const pairingId = "12345678-1234-1234-1234-123456789012";
const renewPairingId = "87654321-4321-4321-4321-210987654321";
const ticketId = "11111111-2222-3333-4444-555555555555";
const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const renewedPem = "-----BEGIN CERTIFICATE-----\nRENEWED\n-----END CERTIFICATE-----\n";
const thumbprint = "thumb-1";
const jwk = { kty: "EC", crv: "P-256", x: "x", y: "y" };

async function waitFor(condition, what) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

function harness(t, overrides = {}) {
  const events = [];
  const auth = { epoch: 1, signedIn: true, subject, access: async () => "token" };
  const io = { value: undefined, read() { return this.value; }, write(value) { this.value = value; }, clear() { this.value = undefined; } };
  const store = new DeviceStore(io, { ...binding, subject });
  const confirmed = { device_id: deviceId, certificate_pem: pem, cert_serial: "12345678901234567890", cert_not_after: "2026-11-19T00:00:00Z" };
  const renewed = { device_id: deviceId, certificate_pem: renewedPem, cert_serial: "99999999999999999999", cert_not_after: "2026-11-20T00:00:00Z" };
  const apiResponses = {
    identity: { org_id: orgId, subject_id: subject },
    pair: { pairing_id: pairingId, challenge: "challenge-1", device_id: deviceId },
    confirmPairing: confirmed,
    requestRenewal: { pairing_id: renewPairingId, challenge: "renew-challenge" },
    confirmRenewal: renewed,
    mintTicket: { ticket: "ab".repeat(32), session_ticket_id: ticketId, device_id: deviceId },
    revoke: {},
  };
  const pipeResponses = {
    getDeviceIdentity: { data: { public_key_thumbprint: thumbprint, public_key_jwk: jwk, container: "c" } },
    signDevicePairing: { data: { signature: "pair-sig" } },
    signDeviceCertificateRenewal: { data: { signature: "renew-sig" } },
    deliverDeviceCertificate: {},
    redeliverDeviceCertificate: {},
    deliverDeviceSessionTicket: {},
    getDeviceCertificateStatus: { data: { device_id: deviceId, cert_serial: confirmed.cert_serial, cert_not_after: confirmed.cert_not_after, renewal_window_open: false, awaiting_ticket: false } },
  };
  const configs = [];
  let stops = 0, closes = 0;
  const api = {
    async request(action, options = {}) {
      events.push(`api:${action}`);
      if (overrides.apiResponse) {
        const value = overrides.apiResponse(action, options);
        if (value instanceof Error) throw value;
        if (value !== undefined) return value;
      }
      const value = apiResponses[action];
      if (value instanceof Error) throw value;
      return value;
    },
  };
  const brokerFactory = async (config, configPath) => {
    configs.push({ config, configPath });
    return {
      pipe: {
        async call(method, fields = {}) {
          events.push(`pipe:${method}`);
          const response = pipeResponses[method];
          if (response instanceof Error) throw response;
          if (typeof response === "function") return response(method, fields);
          return response ?? {};
        },
        close() { closes++; },
      },
      stop: async () => { stops++; },
    };
  };
  const reports = [];
  const gestures = [];
  const deps = {
    auth, api, work: { gatewayOrigin: "https://gw.example.test:8443", serverName: "gw.example.test", caPemPath: path.join(os.tmpdir(), "ca.pem") },
    binding, resourceRoot: "injected", configDir: path.join(os.tmpdir(), `work-driver-test-${randomUUID()}`),
    store,
    askDeviceName: async (defaultName) => {
      events.push("gesture");
      gestures.push(defaultName);
      return overrides.gesture ? overrides.gesture(defaultName) : defaultName;
    },
    report: (message) => reports.push(message),
    brokerFactory,
    pollIntervalMs: 15,
  };
  const driver = new WorkDeviceDriver(deps);
  t.after(() => driver.stop());
  return { driver, events, auth, io, store, configs, reports, gestures, pipeResponses, apiResponses, counters: () => ({ stops, closes }) };
}

test("a fresh device pairs in the §2.1 order: gesture before any pairing request", async (t) => {
  const h = harness(t);
  await h.driver.start();
  assert.equal(h.driver.currentState, "running");
  assert.deepEqual(h.events.filter((e) => e !== "pipe:getDeviceCertificateStatus"), [
    "api:identity", "pipe:getDeviceIdentity", "gesture", "pipe:getDeviceIdentity",
    "api:pair", "pipe:signDevicePairing", "api:confirmPairing", "pipe:deliverDeviceCertificate",
  ]);
  assert.equal(h.gestures.length, 1);
  assert.equal(h.gestures[0], os.hostname().slice(0, 100));
  const record = h.store.load();
  assert.ok(record);
  assert.equal(record.deviceId, deviceId);
  assert.equal(record.orgId, orgId);
  assert.equal(record.subject, subject);
  assert.equal(record.certificatePem, pem);
  assert.equal(record.container, containerFor(binding, subject));
  const { config } = h.configs[0];
  assert.equal(config.shell_pid, process.pid);
  assert.equal(config.container, record.container);
  // The Broker owns the journal epoch now; the shell only hands it a stable base directory.
  assert.ok(config.journal_dir.endsWith("journal"));
  assert.equal(record.journalEpoch, undefined);
  assert.equal(config.endpoint, "https://gw.example.test:8443");
  assert.equal(config.server_name, "gw.example.test");
  assert.match(config.pipe_name, /^\\\\\.\\pipe\\work-device-[0-9a-f-]{36}$/);
  assert.equal(config.provider, "Microsoft Software Key Storage Provider");
});

test("the signing pre-image carries the identity endpoint's org and subject", async (t) => {
  const h = harness(t);
  const fields = [];
  const original = h.pipeResponses.signDevicePairing;
  h.pipeResponses.signDevicePairing = (method, f) => { fields.push(f); return original; };
  await h.driver.start();
  assert.deepEqual(fields[0], { pairing_id: pairingId, challenge: "challenge-1", org_id: orgId, subject_id: subject });
});

test("a cancelled name gesture leaves zero pairing rows and returns to idle", async (t) => {
  const h = harness(t, { gesture: () => undefined });
  await h.driver.start();
  assert.equal(h.driver.currentState, "idle");
  assert.equal(h.events.filter((e) => e.startsWith("api:")).join(","), "api:identity");
  assert.equal(h.store.load(), undefined);
  assert.equal(h.counters().stops, 1);
  assert.deepEqual(h.reports, []);
});

test("a stored certificate is re-delivered on restart without a new gesture or pairing", async (t) => {
  const h = harness(t);
  h.io.value = JSON.stringify({
    ...binding, subject, orgId, deviceId, container: containerFor(binding, subject),
    certificatePem: pem, certSerial: "12345678901234567890", certNotAfter: "2026-11-19T00:00:00Z",
  });
  const delivered = [];
  h.pipeResponses.redeliverDeviceCertificate = (method, fields) => { delivered.push(fields); return {}; };
  await h.driver.start();
  assert.equal(h.driver.currentState, "running");
  // The restart carrier declares the record's org and subject explicitly: a fresh Broker has no
  // signing history, so the signed-org delivery gate cannot be the re-delivery path, and the
  // certificate carries no subject field for the permit identity gate (F5 甲).
  assert.deepEqual(delivered, [{ device_id: deviceId, certificate_pem: pem, org_id: orgId, subject_id: subject }]);
  assert.equal(h.events.filter((e) => e === "pipe:deliverDeviceCertificate").length, 0);
  assert.equal(h.gestures.length, 0);
  assert.equal(h.events.filter((e) => e === "api:pair").length, 0);
  assert.ok(h.configs[0].config.journal_dir.endsWith("journal"));
});

test("a record of another container or org is not re-delivered; the device pairs fresh", async (t) => {
  for (const patch of [{ container: "work-device-" + "b".repeat(40) }, { orgId: "org-2" }]) {
    const h = harness(t);
    h.io.value = JSON.stringify({
      ...binding, subject, orgId, deviceId, container: containerFor(binding, subject),
      certificatePem: pem, certSerial: "12345678901234567890", certNotAfter: "2026-11-19T00:00:00Z",
      ...patch,
    });
    await h.driver.start();
    assert.equal(h.driver.currentState, "running");
    assert.equal(h.gestures.length, 1);
    assert.equal(h.events.filter((e) => e === "api:pair").length, 1);
  }
});

test("an undeliverable stored certificate goes through the renewal re-issuance path", async (t) => {
  const h = harness(t);
  h.io.value = JSON.stringify({
    ...binding, subject, orgId, deviceId, container: containerFor(binding, subject),
    certificatePem: pem, certSerial: "12345678901234567890", certNotAfter: "2026-11-19T00:00:00Z",
  });
  h.pipeResponses.redeliverDeviceCertificate = () => {
    throw new BrokerPipeError("certificate_invalid");
  };
  h.pipeResponses.deliverDeviceCertificate = (method, fields) => {
    assert.equal(fields.certificate_pem, renewedPem);
    return {};
  };
  await h.driver.start();
  assert.equal(h.driver.currentState, "running");
  assert.deepEqual(h.events.filter((e) => e.startsWith("api:")), ["api:identity", "api:requestRenewal", "api:confirmRenewal"]);
  assert.equal(h.store.load().certSerial, "99999999999999999999");
  assert.equal(h.store.load().certificatePem, renewedPem);
});

test("the poll mints exactly one ticket while awaiting_ticket is true", async (t) => {
  const mints = [];
  const h = harness(t, { apiResponse: (action, options) => { if (action === "mintTicket") mints.push(options); return undefined; } });
  let statusCalls = 0;
  const base = h.pipeResponses.getDeviceCertificateStatus;
  h.pipeResponses.getDeviceCertificateStatus = () => {
    statusCalls++;
    return { data: { ...base.data, awaiting_ticket: statusCalls === 1 } };
  };
  const tickets = [];
  h.pipeResponses.deliverDeviceSessionTicket = (method, fields) => { tickets.push(fields); return {}; };
  await h.driver.start();
  await waitFor(() => tickets.length >= 1, "ticket delivery");
  await delay(60);
  assert.equal(tickets.length, 1);
  assert.deepEqual(tickets[0], { ticket: "ab".repeat(32), device_id: deviceId, session_ticket_id: ticketId });
  assert.equal(mints.length, 1);
  assert.equal(mints[0].id, deviceId);
  assert.equal(mints[0].body.public_key_thumbprint, thumbprint);
});

test("an open renewal window triggers the renewal flow from the poll", async (t) => {
  const h = harness(t);
  const base = h.pipeResponses.getDeviceCertificateStatus;
  let renewed = false;
  h.pipeResponses.getDeviceCertificateStatus = () => ({ data: { ...base.data, renewal_window_open: !renewed } });
  h.pipeResponses.deliverDeviceCertificate = (method, fields) => {
    if (fields.certificate_pem === renewedPem) renewed = true;
    return {};
  };
  await h.driver.start();
  await waitFor(() => renewed, "renewal delivery");
  assert.ok(h.events.includes("api:requestRenewal"));
  assert.ok(h.events.includes("pipe:signDeviceCertificateRenewal"));
  assert.equal(h.store.load().certificatePem, renewedPem);
});

test("device_revoked clears the record, stops the driver and reports", async (t) => {
  const h = harness(t, { apiResponse: (action) => action === "mintTicket" ? new WorkApiError("device_revoked") : undefined });
  const base = h.pipeResponses.getDeviceCertificateStatus;
  h.pipeResponses.getDeviceCertificateStatus = () => ({ data: { ...base.data, awaiting_ticket: true } });
  await h.driver.start();
  await waitFor(() => h.driver.currentState === "stopped", "revocation stop");
  assert.equal(h.store.load(), undefined);
  assert.deepEqual(h.reports, ["本机设备已被撤销，请重新配对。"]);
});

test("a dead Broker pipe stops the poll loop instead of hiding the exit", async (t) => {
  const h = harness(t);
  await h.driver.start();
  h.pipeResponses.getDeviceCertificateStatus = () => { throw new BrokerPipeError("pipe_closed"); };
  await waitFor(() => h.driver.currentState === "stopped", "pipe-loss stop");
  assert.deepEqual(h.reports, ["本机设备进程已停止，请重启客户端后重试。"]);
  const before = h.events.length;
  await delay(50);
  assert.equal(h.events.length, before);
});

test("an account change during startup fails closed and tears the Broker down", async (t) => {
  const h = harness(t, { apiResponse: (action) => { if (action === "confirmPairing") h.auth.epoch = 2; return undefined; } });
  await h.driver.start();
  assert.equal(h.driver.currentState, "failed");
  assert.deepEqual(h.reports, ["账号已切换，设备驱动已停止。"]);
  assert.equal(h.counters().stops, 1);
  assert.equal(h.store.load(), undefined);
});

test("an identity subject that disagrees with the signed-in account is refused", async (t) => {
  const h = harness(t, { apiResponse: (action) => action === "identity" ? { org_id: orgId, subject_id: "someone-else" } : undefined });
  await h.driver.start();
  assert.equal(h.driver.currentState, "failed");
  assert.equal(h.events.filter((e) => e === "api:pair").length, 0);
});

test("a signed-out shell never starts the driver", async (t) => {
  const h = harness(t);
  h.auth.signedIn = false;
  await h.driver.start();
  assert.equal(h.driver.currentState, "idle");
  assert.deepEqual(h.events, []);
});

test("stop clears the poll timer and releases the Broker", async (t) => {
  const h = harness(t);
  await h.driver.start();
  await h.driver.stop();
  assert.equal(h.driver.currentState, "stopped");
  assert.equal(h.counters().stops, 1);
  assert.equal(h.counters().closes, 1);
  const before = h.events.length;
  await delay(50);
  assert.equal(h.events.length, before);
});