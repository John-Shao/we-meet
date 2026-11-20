// The §2.1 driver state machine with injected fakes (REST face, Broker pipe, gesture, store).
// Ordering is asserted on one shared event log so "gesture before any pairing request" and
// "re-deliver before poll" are facts, not accidents of separate counters.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdirSync, writeFileSync, rmSync } = require("node:fs");
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
    chooseWorkspace: { data: { confirmation_token: "tok-root", selected_path: "C:\\selected", actual_location: "C:\\selected", volume_label: "OS", differs_from_selected: false, other_user_writable: false } },
    confirmWorkspaceRoot: { data: { grant_id: "g-1", root_identity_hash: "root-hash" } },
    probeLocalModel: { data: { confirmation_token: "tok-model", process_name: "node.exe", image_path: "C:\\node.exe", signer_thumbprint: null, owner_sid: "010500000000000515000000", image_sha256: "ab".repeat(32), listens_on_all_interfaces: false } },
    confirmLocalModel: { data: { profile_id: "p-1", binding_hash: "bind-hash" } },
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
  // 批2-5: the driver reads the dev fixture profile from resourceRoot/work-device-bundle. Stage a
  // minimal valid one (bare sha256-hex pins) so buildConfig succeeds without the real shipped bundle.
  const resourceRoot = path.join(os.tmpdir(), `work-driver-res-${randomUUID()}`);
  mkdirSync(path.join(resourceRoot, "work-device-bundle"), { recursive: true });
  if (!overrides.noProfile) {
    writeFileSync(path.join(resourceRoot, "work-device-bundle", "dev-fixture-profile.json"), JSON.stringify({
      profile_id: "profile-dev-fixture-v1", tool_manifest_hash: "a".repeat(64), runtime_digest: "b".repeat(64),
    }));
  }
  t.after(() => rmSync(resourceRoot, { recursive: true, force: true }));
  const deps = {
    auth, api, work: { gatewayOrigin: "https://gw.example.test:8443", serverName: "gw.example.test", caPemPath: path.join(os.tmpdir(), "ca.pem") },
    binding, resourceRoot, configDir: path.join(os.tmpdir(), `work-driver-test-${randomUUID()}`),
    store,
    askDeviceName: async (defaultName) => {
      events.push("gesture");
      gestures.push(defaultName);
      return overrides.gesture ? overrides.gesture(defaultName) : defaultName;
    },
    selectWorkspaceDirectory: async () => {
      events.push("gesture:selectDir");
      return overrides.selectDir ? overrides.selectDir() : "C:\\selected";
    },
    confirmWorkspaceRoot: async (facts) => {
      events.push("gesture:confirmRoot");
      return overrides.confirmRoot ? overrides.confirmRoot(facts) : true;
    },
    confirmLocalModel: async (facts) => {
      events.push("gesture:confirmModel");
      return overrides.confirmModel ? overrides.confirmModel(facts) : true;
    },
    report: (message) => reports.push(message),
    brokerFactory,
    pollIntervalMs: 15,
  };
  const driver = new WorkDeviceDriver(deps);
  t.after(() => driver.stop());
  return { driver, events, auth, io, store, configs, reports, gestures, pipeResponses, apiResponses, resourceRoot, counters: () => ({ stops, closes }) };
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

// ---- 批2 (主签单选乙): the §4.2/§5.4 confirmation flow + native dialog gestures ----

test("chooseWorkspace runs selector → prepare → dialog → confirm and returns the root identity hash", async (t) => {
  const h = harness(t);
  await h.driver.start();
  let confirmFields;
  h.pipeResponses.confirmWorkspaceRoot = (method, fields) => { confirmFields = fields; return { data: { grant_id: fields.grant_id, root_identity_hash: "root-hash" } }; };
  const result = await h.driver.chooseWorkspace("g-1", ["WeMeet成果"]);
  assert.deepEqual(result, { grantId: "g-1", rootIdentityHash: "root-hash" });
  // The selector gesture precedes the prepare call; the dialog precedes the confirm call.
  const flow = h.events.filter((e) => e.startsWith("gesture:") || e === "pipe:chooseWorkspace" || e === "pipe:confirmWorkspaceRoot");
  assert.deepEqual(flow, ["gesture:selectDir", "pipe:chooseWorkspace", "gesture:confirmRoot", "pipe:confirmWorkspaceRoot"]);
  assert.equal(confirmFields.confirmation_token, "tok-root");
  assert.equal(confirmFields.grant_id, "g-1");
  assert.deepEqual(confirmFields.artifact_dir, ["WeMeet成果"]);
  assert.equal(confirmFields.approved, true);
});

test("cancelling the folder selector produces no grant and never calls the Broker", async (t) => {
  const h = harness(t, { selectDir: () => undefined });
  await h.driver.start();
  const result = await h.driver.chooseWorkspace("g-1", ["out"]);
  assert.equal(result, undefined);
  assert.ok(!h.events.includes("pipe:chooseWorkspace"));
  assert.ok(!h.events.includes("pipe:confirmWorkspaceRoot"));
});

test("cancelling the root dialog still sends approved:false so the Broker closes the handle", async (t) => {
  const h = harness(t, { confirmRoot: () => false });
  await h.driver.start();
  let confirmFields;
  h.pipeResponses.confirmWorkspaceRoot = (method, fields) => { confirmFields = fields; return {}; };
  const result = await h.driver.chooseWorkspace("g-1", ["out"]);
  assert.equal(result, undefined);
  assert.equal(confirmFields.approved, false);
  assert.equal(confirmFields.confirmation_token, "tok-root");
});

test("the root dialog receives the actual location and the two §4.2 warnings", async (t) => {
  let seen;
  const h = harness(t, { confirmRoot: (facts) => { seen = facts; return true; } });
  await h.driver.start();
  h.pipeResponses.chooseWorkspace = { data: { confirmation_token: "tok", selected_path: "C:\\selected", actual_location: "D:\\redirected", volume_label: "Data", differs_from_selected: true, other_user_writable: true } };
  await h.driver.chooseWorkspace("g", ["out"]);
  assert.equal(seen.actualLocation, "D:\\redirected");
  assert.equal(seen.selectedPath, "C:\\selected");
  assert.equal(seen.differsFromSelected, true);
  assert.equal(seen.otherUserWritable, true);
  assert.equal(seen.volumeLabel, "Data");
});

test("configureLocalModel runs probe → dialog → confirm and returns the binding hash", async (t) => {
  const h = harness(t);
  await h.driver.start();
  let confirmFields;
  h.pipeResponses.confirmLocalModel = (method, fields) => { confirmFields = fields; return { data: { profile_id: fields.profile_id, binding_hash: "bind-hash" } }; };
  const requirement = { allowedSigners: [], allowUserPinnedHash: true, allowedServiceSids: [] };
  const result = await h.driver.configureLocalModel("p-1", 11434, requirement);
  assert.deepEqual(result, { profileId: "p-1", bindingHash: "bind-hash" });
  const flow = h.events.filter((e) => e.startsWith("gesture:") || e === "pipe:probeLocalModel" || e === "pipe:confirmLocalModel");
  assert.deepEqual(flow, ["pipe:probeLocalModel", "gesture:confirmModel", "pipe:confirmLocalModel"]);
  assert.equal(confirmFields.confirmation_token, "tok-model");
  assert.equal(confirmFields.port, "11434");
  assert.equal(confirmFields.approved, true);
  assert.deepEqual(confirmFields.listener_requirement, { allowed_signers: [], allow_user_pinned_hash: true, allowed_service_sids: [] });
});

test("cancelling the model dialog sends approved:false and produces no binding", async (t) => {
  const h = harness(t, { confirmModel: () => false });
  await h.driver.start();
  let confirmFields;
  h.pipeResponses.confirmLocalModel = (method, fields) => { confirmFields = fields; return {}; };
  const result = await h.driver.configureLocalModel("p-1", 11434, { allowedSigners: [], allowUserPinnedHash: true, allowedServiceSids: [] });
  assert.equal(result, undefined);
  assert.equal(confirmFields.approved, false);
});

test("a malformed confirmation reply is a shape refusal, never a silent dialog", async (t) => {
  const h = harness(t);
  await h.driver.start();
  h.pipeResponses.chooseWorkspace = { data: { confirmation_token: "tok" } };
  await assert.rejects(() => h.driver.chooseWorkspace("g", ["out"]), (e) => e.code === "shape");
  assert.ok(!h.events.includes("gesture:confirmRoot"));
});

// ---- 批2-5: the config digests come from the shipped dev fixture profile, never a placeholder ----

test("the config carries the dev fixture profile's real hashes and profile_id", async (t) => {
  const h = harness(t);
  await h.driver.start();
  const { config } = h.configs[0];
  assert.equal(config.profile_id, "profile-dev-fixture-v1");
  assert.equal(config.tool_manifest_hash, "a".repeat(64));
  assert.equal(config.runtime_digest, "b".repeat(64));
});

test("a missing bundle profile is a hard failure, not a placeholder fallback", async (t) => {
  const h = harness(t, { noProfile: true });
  await h.driver.start();
  assert.equal(h.driver.currentState, "failed");
  assert.ok(h.reports.some((m) => m.includes("启动失败")));
  assert.equal(h.configs.length, 0);
});

test("an invalid bundle profile (non-hex digest) is refused", async (t) => {
  const h = harness(t);
  writeFileSync(path.join(h.resourceRoot, "work-device-bundle", "dev-fixture-profile.json"), JSON.stringify({
    profile_id: "profile-dev-fixture-v1", tool_manifest_hash: "not-hex", runtime_digest: "b".repeat(64),
  }));
  await h.driver.start();
  assert.equal(h.driver.currentState, "failed");
  assert.equal(h.configs.length, 0);
});