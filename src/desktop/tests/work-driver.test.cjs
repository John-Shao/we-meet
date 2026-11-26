// The §2.1 driver state machine with injected fakes (REST face, Broker pipe, gesture, store).
// Ordering is asserted on one shared event log so "gesture before any pairing request" and
// "re-deliver before poll" are facts, not accidents of separate counters.
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { WorkApiError } = require("../dist/work/api.js");
const { BrokerPipeError } = require("../dist/work/pipe.js");
const { WorkDeviceDriver, containerFor } = require("../dist/work/driver.js");
const { DeviceStore } = require("../dist/work/store.js");

const binding = {
  issuer: "https://id.example.test/realms/meet",
  clientId: "desktop",
  serviceOrigin: "https://meet.example.test",
};
const subject = "subject-1";
const orgId = "org-1";
const deviceId = "abcdefab-abcd-abcd-abcd-abcdefabcdef";
const pairingId = "12345678-1234-1234-1234-123456789012";
const renewPairingId = "87654321-4321-4321-4321-210987654321";
const ticketId = "11111111-2222-3333-4444-555555555555";
const sessionId = "44444444-4444-4444-8444-444444444444";
const workspaceGrantId = "55555555-5555-4555-8555-555555555555";
const workspaceRootHash = `sha256:${"a".repeat(64)}`;
const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const renewedPem =
  "-----BEGIN CERTIFICATE-----\nRENEWED\n-----END CERTIFICATE-----\n";
const thumbprint = "thumb-1";
const jwk = { kty: "EC", crv: "P-256", x: "x", y: "y" };
// The local preview is server-signed (`lp1.<payload>.<signature>`); the shell reads the
// Host auth_epoch from that payload, so the fixture payload has to carry one.
const previewHash = `lp1.${Buffer.from(JSON.stringify({ auth_epoch: "1" })).toString("base64url")}.signature`;
const localSubmissionInput = {
  clientRequestId: "local-submit-1",
  inputRef: "12345678-1234-4234-8234-123456789abc",
  inputHash: `sha256:${"a".repeat(64)}`,
  previewHash,
  targetSelectionHash: "b".repeat(64),
  selectedGrantIds: [workspaceGrantId],
  grantRevisions: ["1"],
  profileId: "profile-dev-fixture-v1",
  profileRevision: 2,
  profileHash: "c".repeat(64),
  artifactClassificationFloor: "local_only",
  availableDestinations: ["device_local"],
};
function localIntentReply(method, fields) {
  if (!fields.approved) return {};
  return {
    data: {
      status: "ready",
      local_intent: {
        v: 1,
        org_id: orgId,
        subject_id: subject,
        auth_plane: "bearer",
        auth_epoch: fields.auth_epoch,
        device_id: deviceId,
        session_id: "22222222-2222-4222-8222-222222222222",
        request_id: fields.client_request_id,
        input_hash: fields.input_hash,
        preview_hash: fields.preview_hash,
        target_selection_hash: fields.target_selection_hash,
        selected_grant_ids: fields.selected_grant_ids,
        grant_revisions: fields.grant_revisions,
        profile_id: fields.profile_id,
        profile_revision: fields.profile_revision,
        profile_hash: fields.profile_hash,
        nonce: "nonce-local-1",
        expires_at: new Date(Date.now() + 60_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z"),
        signature: "A".repeat(86),
      },
    },
  };
}

async function waitFor(condition, what) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

function harness(t, overrides = {}) {
  const events = [];
  const auth = {
    epoch: 1,
    signedIn: true,
    subject,
    access: async () => "token",
  };
  const io = {
    value: undefined,
    read() {
      return this.value;
    },
    write(value) {
      this.value = value;
    },
    clear() {
      this.value = undefined;
    },
  };
  const store = new DeviceStore(io, { ...binding, subject });
  const confirmed = {
    device_id: deviceId,
    certificate_pem: pem,
    cert_serial: "12345678901234567890",
    cert_not_after: "2026-11-19T00:00:00Z",
  };
  const renewed = {
    device_id: deviceId,
    certificate_pem: renewedPem,
    cert_serial: "99999999999999999999",
    cert_not_after: "2026-11-20T00:00:00Z",
  };
  const apiResponses = {
    identity: {
      org_id: orgId,
      subject_id: subject,
      auth_plane: "bearer",
      auth_epoch: "1",
    },
    pair: {
      pairing_id: pairingId,
      challenge: "challenge-1",
      device_id: deviceId,
    },
    confirmPairing: confirmed,
    requestRenewal: {
      pairing_id: renewPairingId,
      challenge: "renew-challenge",
    },
    confirmRenewal: renewed,
    mintTicket: {
      ticket: "ab".repeat(32),
      session_ticket_id: ticketId,
      device_id: deviceId,
    },
    revoke: {},
    registerWorkspaceGrant: {
      grant_id: workspaceGrantId,
      root_ref: "66666666-6666-4666-8666-666666666666",
      grant_revision: 1,
      state: "active",
      replayed: false,
    },
    createLocalTaskPreview: (action, options) => ({
      preview_hash: previewHash,
      target_selection_hash: createHash("sha256")
        .update(JSON.stringify(options.body.target_selection))
        .digest("hex"),
      artifact_classification_floor: "local_only",
      available_destinations: ["device_local"],
    }),
    submitLocalTask: (action, options) => ({
      task_id: "99999999-9999-4999-8999-999999999999",
      run_id: "55555555-5555-4555-8555-555555555555",
      revision: 1,
      binding_revision: 1,
      task_state: "open",
      display_state: "queued",
      input_ref: options.body.input_ref,
    }),
    createLocalArtifactVersion: (action, options) => ({
      version_id: options.body.user_version_proof.version_id,
      version_no: 2,
      publish_ack: `sha256:${"b".repeat(64)}`,
      replayed: false,
    }),
    createLocalAcceptance: (action, options) => ({
      acceptance_id: "88888888-8888-4888-8888-888888888888",
      task_id: options.id,
      artifact_id: options.body.artifact_id,
      version_no: 1,
      revision: options.body.revision + 1,
      replayed: false,
    }),
    listApprovals: {
      approvals: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          task_id: "99999999-9999-4999-8999-999999999999",
          run_id: "55555555-5555-4555-8555-555555555555",
          operation_id: "44444444-4444-4444-8444-444444444444",
          action_kind: "artifact.write",
          risk: "local_write",
          status: "pending",
          expires_at: "2027-01-01T00:00:00Z",
        },
      ],
      next_cursor: null,
    },
    getApproval: {
      id: "33333333-3333-4333-8333-333333333333",
      operation_id: "44444444-4444-4444-8444-444444444444",
      params_hash: "a".repeat(64),
      revision: 0,
      policy_epoch: 0,
      access_epoch: 0,
      device_id: deviceId,
      action_kind: "artifact.write",
      status: "pending",
      readonly_scope: null,
      destination_facts: {
        local_only_taint: true,
        current_action_taints: true,
        available_destinations: ["device_local"],
      },
    },
    decideApproval: {
      approval_id: "33333333-3333-4333-8333-333333333333",
      operation_id: "44444444-4444-4444-8444-444444444444",
      decision: "approved",
      approval_revision: 1,
      readonly_grant_id: null,
      run_id: "55555555-5555-4555-8555-555555555555",
      replayed: false,
    },
  };
  let preparedEdit;
  const pipeResponses = {
    getDeviceIdentity: {
      data: {
        public_key_thumbprint: thumbprint,
        public_key_jwk: jwk,
        container: "c",
      },
    },
    signDevicePairing: { data: { signature: "pair-sig" } },
    signDeviceCertificateRenewal: { data: { signature: "renew-sig" } },
    deliverDeviceCertificate: {},
    redeliverDeviceCertificate: {},
    deliverDeviceSessionTicket: {},
    getDeviceCertificateStatus: {
      data: {
        device_id: deviceId,
        cert_serial: confirmed.cert_serial,
        cert_not_after: confirmed.cert_not_after,
        renewal_window_open: false,
        awaiting_ticket: false,
      },
    },
    chooseWorkspace: {
      data: {
        confirmation_token: "tok-root",
        selected_path: "C:\\selected",
        actual_location: "C:\\selected",
        volume_label: "OS",
        differs_from_selected: false,
        other_user_writable: false,
        root_identity_hash: workspaceRootHash,
        device_id: deviceId,
        session_id: sessionId,
      },
    },
    confirmWorkspaceRoot: (method, fields) => ({
      data: {
        grant_id: fields.grant_id,
        root_identity_hash: workspaceRootHash,
      },
    }),
    probeLocalModel: {
      data: {
        confirmation_token: "tok-model",
        process_name: "node.exe",
        image_path: "C:\\node.exe",
        signer_thumbprint: null,
        owner_sid: "010500000000000515000000",
        image_sha256: "ab".repeat(32),
        listens_on_all_interfaces: false,
      },
    },
    confirmLocalModel: {
      data: { profile_id: "p-1", binding_hash: "bind-hash" },
    },
    stageLocalInput: (method, fields) => ({
      data: {
        local_input_ref: "12345678-1234-4234-8234-123456789abc",
        content_hash: `sha256:${createHash("sha256").update(fields.text, "utf8").digest("hex")}`,
        byte_count: String(Buffer.byteLength(fields.text, "utf8")),
      },
    }),
    confirmLocalSubmission: localIntentReply,
    openLocalContent: (method, fields) => {
      if (!["artifact_version", "artifact_edit"].includes(fields.kind))
        return { data: { status: "not_on_this_device" } };
      const text =
        fields.kind === "artifact_edit"
          ? "# local draft\n"
          : "# local artifact\n";
      return {
        data: {
          status: "available",
          format: "text/markdown",
          text,
          content_hash: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
          byte_count: String(Buffer.byteLength(text, "utf8")),
        },
      };
    },
    listLocalArtifactDrafts: (method, fields) => ({
      data: {
        status: "available",
        items: [
          {
            request_id: "44444444-4444-4444-8444-444444444444",
            version_id: "33333333-3333-4333-8333-333333333333",
            artifact_id: fields.artifact_id,
            task_id: fields.task_id,
            base_version_id: "55555555-5555-4555-8555-555555555555",
            base_version_no: "4",
            base_hash: `sha256:${"a".repeat(64)}`,
            format: "text/markdown",
            content_hash: `sha256:${"b".repeat(64)}`,
            byte_count: "17",
            base_byte_count: "4",
            publish_state: "pending_confirm",
            created_at: "1",
          },
        ],
      },
    }),
    prepareLocalArtifactEdit: (method, fields) => {
      preparedEdit = fields;
      return {
        data: {
          status: "pending_confirm",
          request_id: fields.client_request_id,
          version_id: fields.version_id,
          content_hash: fields.content_hash,
          byte_count: fields.byte_count,
          base_byte_count: "4",
        },
      };
    },
    decideLocalArtifactEdit: (method, fields) => {
      if (fields.action !== "confirm")
        return {
          data: {
            status:
              fields.action === "discard" ? "discarded" : "pending_confirm",
            request_id: fields.draft_request_id,
            version_id: preparedEdit.version_id,
            content_hash: fields.sealed_hash,
          },
        };
      return {
        data: {
          status: "pending_publish",
          request_id: fields.draft_request_id,
          version_id: preparedEdit.version_id,
          artifact_id: "11111111-1111-4111-8111-111111111111",
          device_id: deviceId,
          session_id: "22222222-2222-4222-8222-222222222222",
          local_ref: `local/${preparedEdit.version_id}.md`,
          content_hash: fields.sealed_hash,
          byte_count: "11",
          signature: "A".repeat(86),
          user_version_proof: {
            v: 1,
            org_id: orgId,
            subject_id: subject,
            auth_plane: "bearer",
            auth_epoch: "1",
            device_id: deviceId,
            session_id: "22222222-2222-4222-8222-222222222222",
            task_id: "44444444-4444-4444-8444-444444444444",
            artifact_id: "11111111-1111-4111-8111-111111111111",
            base_version_no: 1,
            base_hash: "a".repeat(64),
            version_id: preparedEdit.version_id,
            format: "text/markdown",
            content_hash: fields.sealed_hash.slice(7),
            bytes: 11,
            classification: "local_only",
            clipboard_derived: false,
            clipboard_source_version_ids: [],
            client_request_id: fields.draft_request_id,
            nonce: "nonce-edit-1",
            expires_at: "2027-01-01T00:00:00Z",
          },
        },
      };
    },
    prepareLocalApprovalDecision: (method, fields) => ({
      data: {
        status: "ready",
        approval_decision_proof: {
          v: 1,
          org_id: orgId,
          subject_id: subject,
          auth_plane: "bearer",
          auth_epoch: fields.auth_epoch,
          device_id: deviceId,
          session_id: "22222222-2222-4222-8222-222222222222",
          approval_id: fields.approval_id,
          operation_id: fields.operation_id,
          params_hash: fields.params_hash,
          expected_revision: fields.expected_revision,
          decision: fields.decision,
          remember_readonly: fields.remember_readonly,
          readonly_scope: fields.readonly_scope,
          readonly_expires_at: fields.readonly_expires_at,
          policy_epoch: fields.policy_epoch,
          access_epoch: fields.access_epoch,
          nonce: "nonce-approval-1",
          expires_at: "2027-01-01T00:00:00Z",
          signature: "A".repeat(86),
        },
      },
    }),
    completeLocalArtifactEdit: { data: { status: "published" } },
  };
  const configs = [];
  let stops = 0,
    closes = 0;
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
      if (typeof value === "function") return value(action, options);
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
        close() {
          closes++;
        },
      },
      stop: async () => {
        stops++;
      },
    };
  };
  const reports = [];
  const gestures = [];
  // 批2-5: the driver reads the dev fixture profile from resourceRoot/work-device-bundle. Stage a
  // minimal valid one (bare sha256-hex pins) so buildConfig succeeds without the real shipped bundle.
  const resourceRoot = path.join(
    os.tmpdir(),
    `work-driver-res-${randomUUID()}`,
  );
  mkdirSync(path.join(resourceRoot, "work-device-bundle"), { recursive: true });
  if (!overrides.noProfile) {
    writeFileSync(
      path.join(resourceRoot, "work-device-bundle", "dev-fixture-profile.json"),
      JSON.stringify({
        profile_id: "profile-dev-fixture-v1",
        model_route: { config_revision: 1, model: "fixture-model" },
        tool_manifest_hash: "a".repeat(64),
        runtime_digest: "b".repeat(64),
      }),
    );
  }
  t.after(() => rmSync(resourceRoot, { recursive: true, force: true }));
  const deps = {
    auth,
    api,
    work: {
      gatewayOrigin: "https://gw.example.test:8443",
      serverName: "gw.example.test",
      caPemPath: path.join(os.tmpdir(), "ca.pem"),
    },
    binding,
    resourceRoot,
    configDir: path.join(os.tmpdir(), `work-driver-test-${randomUUID()}`),
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
    confirmWorkspaceRebind: async (facts) => {
      events.push("gesture:confirmRebind");
      return overrides.confirmRebind ? overrides.confirmRebind(facts) : true;
    },
    confirmLocalModel: async (facts) => {
      events.push("gesture:confirmModel");
      return overrides.confirmModel ? overrides.confirmModel(facts) : true;
    },
    confirmLocalSubmission: async (facts) => {
      events.push("gesture:confirmSubmission");
      return overrides.confirmSubmission
        ? overrides.confirmSubmission(facts)
        : true;
    },
    report: (message) => reports.push(message),
    brokerFactory,
    pollIntervalMs: 15,
  };
  const driver = new WorkDeviceDriver(deps);
  t.after(() => driver.stop());
  return {
    driver,
    events,
    auth,
    io,
    store,
    configs,
    reports,
    gestures,
    pipeResponses,
    apiResponses,
    resourceRoot,
    counters: () => ({ stops, closes }),
  };
}

test("a fresh device pairs in the §2.1 order: gesture before any pairing request", async (t) => {
  const h = harness(t);
  await h.driver.start();
  assert.equal(h.driver.currentState, "running");
  assert.deepEqual(
    h.events.filter((e) => e !== "pipe:getDeviceCertificateStatus"),
    [
      "api:identity",
      "pipe:getDeviceIdentity",
      "gesture",
      "pipe:getDeviceIdentity",
      "api:pair",
      "pipe:signDevicePairing",
      "api:confirmPairing",
      "pipe:deliverDeviceCertificate",
    ],
  );
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
  h.pipeResponses.signDevicePairing = (method, f) => {
    fields.push(f);
    return original;
  };
  await h.driver.start();
  assert.deepEqual(fields[0], {
    pairing_id: pairingId,
    challenge: "challenge-1",
    org_id: orgId,
    subject_id: subject,
  });
});

test("a cancelled name gesture leaves zero pairing rows and returns to idle", async (t) => {
  const h = harness(t, { gesture: () => undefined });
  await h.driver.start();
  assert.equal(h.driver.currentState, "idle");
  assert.equal(
    h.events.filter((e) => e.startsWith("api:")).join(","),
    "api:identity",
  );
  assert.equal(h.store.load(), undefined);
  assert.equal(h.counters().stops, 1);
  assert.deepEqual(h.reports, []);
});

test("a stored certificate is re-delivered on restart without a new gesture or pairing", async (t) => {
  const h = harness(t);
  h.io.value = JSON.stringify({
    ...binding,
    subject,
    orgId,
    deviceId,
    container: containerFor(binding, subject),
    certificatePem: pem,
    certSerial: "12345678901234567890",
    certNotAfter: "2026-11-19T00:00:00Z",
  });
  const delivered = [];
  h.pipeResponses.redeliverDeviceCertificate = (method, fields) => {
    delivered.push(fields);
    return {};
  };
  await h.driver.start();
  assert.equal(h.driver.currentState, "running");
  // The restart carrier declares the record's org and subject explicitly: a fresh Broker has no
  // signing history, so the signed-org delivery gate cannot be the re-delivery path, and the
  // certificate carries no subject field for the permit identity gate (F5 甲).
  assert.deepEqual(delivered, [
    {
      device_id: deviceId,
      certificate_pem: pem,
      org_id: orgId,
      subject_id: subject,
    },
  ]);
  assert.equal(
    h.events.filter((e) => e === "pipe:deliverDeviceCertificate").length,
    0,
  );
  assert.equal(h.gestures.length, 0);
  assert.equal(h.events.filter((e) => e === "api:pair").length, 0);
  assert.ok(h.configs[0].config.journal_dir.endsWith("journal"));
});

test("a record of another container or org is not re-delivered; the device pairs fresh", async (t) => {
  for (const patch of [
    { container: "work-device-" + "b".repeat(40) },
    { orgId: "org-2" },
  ]) {
    const h = harness(t);
    h.io.value = JSON.stringify({
      ...binding,
      subject,
      orgId,
      deviceId,
      container: containerFor(binding, subject),
      certificatePem: pem,
      certSerial: "12345678901234567890",
      certNotAfter: "2026-11-19T00:00:00Z",
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
    ...binding,
    subject,
    orgId,
    deviceId,
    container: containerFor(binding, subject),
    certificatePem: pem,
    certSerial: "12345678901234567890",
    certNotAfter: "2026-11-19T00:00:00Z",
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
  assert.deepEqual(
    h.events.filter((e) => e.startsWith("api:")),
    ["api:identity", "api:requestRenewal", "api:confirmRenewal"],
  );
  assert.equal(h.store.load().certSerial, "99999999999999999999");
  assert.equal(h.store.load().certificatePem, renewedPem);
});

test("the poll mints exactly one ticket while awaiting_ticket is true", async (t) => {
  const mints = [];
  const h = harness(t, {
    apiResponse: (action, options) => {
      if (action === "mintTicket") mints.push(options);
      return undefined;
    },
  });
  let statusCalls = 0;
  const base = h.pipeResponses.getDeviceCertificateStatus;
  h.pipeResponses.getDeviceCertificateStatus = () => {
    statusCalls++;
    return { data: { ...base.data, awaiting_ticket: statusCalls === 1 } };
  };
  const tickets = [];
  h.pipeResponses.deliverDeviceSessionTicket = (method, fields) => {
    tickets.push(fields);
    return {};
  };
  await h.driver.start();
  await waitFor(() => tickets.length >= 1, "ticket delivery");
  await delay(60);
  assert.equal(tickets.length, 1);
  assert.deepEqual(tickets[0], {
    ticket: "ab".repeat(32),
    device_id: deviceId,
    session_ticket_id: ticketId,
  });
  assert.equal(mints.length, 1);
  assert.equal(mints[0].id, deviceId);
  assert.equal(mints[0].body.public_key_thumbprint, thumbprint);
});

test("an open renewal window triggers the renewal flow from the poll", async (t) => {
  const h = harness(t);
  const base = h.pipeResponses.getDeviceCertificateStatus;
  let renewed = false;
  h.pipeResponses.getDeviceCertificateStatus = () => ({
    data: { ...base.data, renewal_window_open: !renewed },
  });
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
  const h = harness(t, {
    apiResponse: (action) =>
      action === "mintTicket" ? new WorkApiError("device_revoked") : undefined,
  });
  const base = h.pipeResponses.getDeviceCertificateStatus;
  h.pipeResponses.getDeviceCertificateStatus = () => ({
    data: { ...base.data, awaiting_ticket: true },
  });
  await h.driver.start();
  await waitFor(() => h.driver.currentState === "stopped", "revocation stop");
  assert.equal(h.store.load(), undefined);
  assert.deepEqual(h.reports, ["本机设备已被撤销，请重新配对。"]);
});

test("a dead Broker pipe stops the poll loop instead of hiding the exit", async (t) => {
  const h = harness(t);
  await h.driver.start();
  h.pipeResponses.getDeviceCertificateStatus = () => {
    throw new BrokerPipeError("pipe_closed");
  };
  await waitFor(() => h.driver.currentState === "stopped", "pipe-loss stop");
  assert.deepEqual(h.reports, ["本机设备进程已停止，请重启客户端后重试。"]);
  const before = h.events.length;
  await delay(50);
  assert.equal(h.events.length, before);
});

test("an account change during startup fails closed and tears the Broker down", async (t) => {
  const h = harness(t, {
    apiResponse: (action) => {
      if (action === "confirmPairing") h.auth.epoch = 2;
      return undefined;
    },
  });
  await h.driver.start();
  assert.equal(h.driver.currentState, "failed");
  assert.deepEqual(h.reports, ["账号已切换，设备驱动已停止。"]);
  assert.equal(h.counters().stops, 1);
  assert.equal(h.store.load(), undefined);
});

test("an identity subject that disagrees with the signed-in account is refused", async (t) => {
  const h = harness(t, {
    apiResponse: (action) =>
      action === "identity"
        ? { org_id: orgId, subject_id: "someone-else" }
        : undefined,
  });
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

test("grantWorkspace registers the server grant id with the Broker after native approval", async (t) => {
  const h = harness(t);
  await h.driver.start();
  let confirmFields;
  let registered;
  h.pipeResponses.confirmWorkspaceRoot = (method, fields) => {
    confirmFields = fields;
    return {
      data: {
        grant_id: fields.grant_id,
        root_identity_hash: workspaceRootHash,
      },
    };
  };
  h.apiResponses.registerWorkspaceGrant = (action, options) => {
    registered = options;
    return {
      grant_id: workspaceGrantId,
      root_ref: "66666666-6666-4666-8666-666666666666",
      grant_revision: 1,
      state: "active",
      replayed: false,
    };
  };
  const result = await h.driver.grantWorkspace(["WeMeet成果"]);
  assert.deepEqual(result, {
    grantId: workspaceGrantId,
    rootIdentityHash: workspaceRootHash,
  });
  const flow = h.events.filter(
    (e) =>
      e.startsWith("gesture:") ||
      e === "pipe:chooseWorkspace" ||
      e === "api:registerWorkspaceGrant" ||
      e === "pipe:confirmWorkspaceRoot",
  );
  assert.deepEqual(flow, [
    "gesture:selectDir",
    "pipe:chooseWorkspace",
    "gesture:confirmRoot",
    "api:registerWorkspaceGrant",
    "pipe:confirmWorkspaceRoot",
  ]);
  assert.equal(registered.body.device_id, deviceId);
  assert.equal(registered.body.session_id, sessionId);
  assert.equal(registered.body.grant.root_identity_hash, "a".repeat(64));
  assert.equal(confirmFields.confirmation_token, "tok-root");
  assert.equal(confirmFields.grant_id, workspaceGrantId);
  assert.deepEqual(confirmFields.artifact_dir, ["WeMeet成果"]);
  assert.equal(confirmFields.approved, true);
});

test("cancelling the folder selector produces no grant and never calls the Broker", async (t) => {
  const h = harness(t, { selectDir: () => undefined });
  await h.driver.start();
  const result = await h.driver.grantWorkspace(["out"]);
  assert.equal(result, undefined);
  assert.ok(!h.events.includes("pipe:chooseWorkspace"));
  assert.ok(!h.events.includes("pipe:confirmWorkspaceRoot"));
});

test("cancelling the root dialog still sends approved:false so the Broker closes the handle", async (t) => {
  const h = harness(t, { confirmRoot: () => false });
  await h.driver.start();
  let confirmFields;
  h.pipeResponses.confirmWorkspaceRoot = (method, fields) => {
    confirmFields = fields;
    return {};
  };
  const result = await h.driver.grantWorkspace(["out"]);
  assert.equal(result, undefined);
  assert.equal(confirmFields.approved, false);
  assert.equal(confirmFields.confirmation_token, "tok-root");
  assert.equal(h.events.includes("api:registerWorkspaceGrant"), false);
});

test("the root dialog receives the actual location and the two §4.2 warnings", async (t) => {
  let seen;
  const h = harness(t, {
    confirmRoot: (facts) => {
      seen = facts;
      return true;
    },
  });
  await h.driver.start();
  h.pipeResponses.chooseWorkspace = {
    data: {
      confirmation_token: "tok",
      selected_path: "C:\\selected",
      actual_location: "D:\\redirected",
      volume_label: "Data",
      differs_from_selected: true,
      other_user_writable: true,
      root_identity_hash: workspaceRootHash,
      device_id: deviceId,
      session_id: sessionId,
    },
  };
  await h.driver.grantWorkspace(["out"]);
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
  h.pipeResponses.confirmLocalModel = (method, fields) => {
    confirmFields = fields;
    return {
      data: { profile_id: fields.profile_id, binding_hash: "bind-hash" },
    };
  };
  const requirement = {
    allowedSigners: [],
    allowUserPinnedHash: true,
    allowedServiceSids: [],
  };
  const result = await h.driver.configureLocalModel("p-1", 11434, requirement);
  assert.deepEqual(result, { profileId: "p-1", bindingHash: "bind-hash" });
  const flow = h.events.filter(
    (e) =>
      e.startsWith("gesture:") ||
      e === "pipe:probeLocalModel" ||
      e === "pipe:confirmLocalModel",
  );
  assert.deepEqual(flow, [
    "pipe:probeLocalModel",
    "gesture:confirmModel",
    "pipe:confirmLocalModel",
  ]);
  assert.equal(confirmFields.confirmation_token, "tok-model");
  assert.equal(confirmFields.port, "11434");
  assert.equal(confirmFields.approved, true);
  assert.deepEqual(confirmFields.listener_requirement, {
    allowed_signers: [],
    allow_user_pinned_hash: true,
    allowed_service_sids: [],
  });
});

test("cancelling the model dialog sends approved:false and produces no binding", async (t) => {
  const h = harness(t, { confirmModel: () => false });
  await h.driver.start();
  let confirmFields;
  h.pipeResponses.confirmLocalModel = (method, fields) => {
    confirmFields = fields;
    return {};
  };
  const result = await h.driver.configureLocalModel("p-1", 11434, {
    allowedSigners: [],
    allowUserPinnedHash: true,
    allowedServiceSids: [],
  });
  assert.equal(result, undefined);
  assert.equal(confirmFields.approved, false);
});

test("a malformed confirmation reply is a shape refusal, never a silent dialog", async (t) => {
  const h = harness(t);
  await h.driver.start();
  h.pipeResponses.chooseWorkspace = { data: { confirmation_token: "tok" } };
  await assert.rejects(
    () => h.driver.grantWorkspace(["out"]),
    (e) => e.code === "shape",
  );
  assert.ok(!h.events.includes("gesture:confirmRoot"));
});

test("stageLocalInput returns only validated ref/hash/byte metadata", async (t) => {
  const h = harness(t);
  await h.driver.start();
  const text = "目标正文\n\n背景";
  const result = await h.driver.stageLocalInput(text);
  assert.deepEqual(result, {
    localInputRef: "12345678-1234-4234-8234-123456789abc",
    contentHash: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
    byteCount: Buffer.byteLength(text, "utf8"),
  });
  assert.equal(h.events.at(-1), "pipe:stageLocalInput");
});

test("stageLocalInput refuses invalid text before touching the Broker", async (t) => {
  const h = harness(t);
  await h.driver.start();
  for (const text of ["", "   ", "bad\x00text", "x".repeat(60 * 1024 + 1)]) {
    await assert.rejects(
      () => h.driver.stageLocalInput(text),
      (error) => error.code === "shape",
    );
  }
  assert.ok(!h.events.includes("pipe:stageLocalInput"));
});

test("stageLocalInput rejects extra or mismatched Broker metadata", async (t) => {
  const h = harness(t);
  await h.driver.start();
  h.pipeResponses.stageLocalInput = {
    data: {
      local_input_ref: "12345678-1234-4234-8234-123456789abc",
      content_hash: `sha256:${"a".repeat(64)}`,
      byte_count: "1",
      body: "must never cross back",
    },
  };
  await assert.rejects(
    () => h.driver.stageLocalInput("abc"),
    (error) => error.code === "shape",
  );
  h.pipeResponses.stageLocalInput = {
    data: {
      local_input_ref: "12345678-1234-4234-8234-123456789abc",
      content_hash: `sha256:${"a".repeat(64)}`,
      byte_count: "999",
    },
  };
  await assert.rejects(
    () => h.driver.stageLocalInput("abc"),
    (error) => error.code === "shape",
  );
});

test("local submission confirms natively before the Broker signs the exact metadata", async (t) => {
  let confirmed;
  const h = harness(t, {
    confirmSubmission: (facts) => {
      confirmed = facts;
      return true;
    },
  });
  await h.driver.start();
  const original = h.pipeResponses.confirmLocalSubmission;
  let sent;
  h.pipeResponses.confirmLocalSubmission = (method, fields) => {
    sent = fields;
    return original(method, fields);
  };
  const result = await h.driver.confirmLocalSubmission(localSubmissionInput);
  assert.equal(result.status, "ready");
  assert.equal(
    result.localIntent.requestId,
    localSubmissionInput.clientRequestId,
  );
  assert.equal(result.localIntent.inputHash, "a".repeat(64));
  assert.equal(result.localIntent.authEpoch, "1");
  assert.equal(result.localIntent.profileRevision, "2");
  assert.deepEqual(confirmed, { ...localSubmissionInput, authEpoch: "1" });
  assert.equal(sent.approved, true);
  assert.equal(sent.auth_epoch, "1");
  assert.equal(sent.input_hash, "a".repeat(64));
  assert.ok(!("approved" in confirmed));
  assert.ok(
    h.events.indexOf("gesture:confirmSubmission") <
      h.events.indexOf("pipe:confirmLocalSubmission"),
  );
  assert.ok(!JSON.stringify(sent).includes("selected_path"));
});

test("local submission cancel sends approved:false and returns no proof", async (t) => {
  const h = harness(t, { confirmSubmission: () => false });
  await h.driver.start();
  let sent;
  const original = h.pipeResponses.confirmLocalSubmission;
  h.pipeResponses.confirmLocalSubmission = (method, fields) => {
    sent = fields;
    return original(method, fields);
  };
  assert.deepEqual(
    await h.driver.confirmLocalSubmission(localSubmissionInput),
    {
      status: "canceled",
    },
  );
  assert.equal(sent.approved, false);
});

test("local submission refuses renderer-owned approval, epoch and mismatched proofs", async (t) => {
  const h = harness(t);
  await h.driver.start();
  await assert.rejects(
    () =>
      h.driver.confirmLocalSubmission({
        ...localSubmissionInput,
        approved: true,
      }),
    (error) => error.code === "shape",
  );
  await assert.rejects(
    () =>
      h.driver.confirmLocalSubmission({
        ...localSubmissionInput,
        authEpoch: "999",
      }),
    (error) => error.code === "shape",
  );
  assert.ok(!h.events.includes("gesture:confirmSubmission"));
  const original = h.pipeResponses.confirmLocalSubmission;
  for (const mutate of [
    (reply) => {
      reply.data.local_intent.request_id = "other-submit";
    },
    (reply) => {
      reply.data.local_intent.target_selection_hash = "d".repeat(64);
    },
    (reply) => {
      reply.data.local_intent.grant_revisions = ["2"];
    },
    (reply) => {
      reply.data.local_intent.auth_epoch = "2";
    },
    (reply) => {
      reply.data.local_intent.extra = "open";
    },
    (reply) => {
      reply.data.local_intent.expires_at = "2000-01-01T00:00:00Z";
    },
  ]) {
    h.pipeResponses.confirmLocalSubmission = (method, fields) => {
      const reply = original(method, fields);
      mutate(reply);
      return reply;
    };
    await assert.rejects(
      () => h.driver.confirmLocalSubmission(localSubmissionInput),
      (error) => error.code === "shape",
    );
  }
});

test("local submission reports an unavailable live input without inventing a proof", async (t) => {
  const h = harness(t);
  await h.driver.start();
  h.pipeResponses.confirmLocalSubmission = { data: { status: "unavailable" } };
  assert.deepEqual(
    await h.driver.confirmLocalSubmission(localSubmissionInput),
    {
      status: "unavailable",
    },
  );
  h.pipeResponses.confirmLocalSubmission = {
    data: { status: "unavailable", local_intent: {} },
  };
  await assert.rejects(
    () => h.driver.confirmLocalSubmission(localSubmissionInput),
    (error) => error.code === "shape",
  );
});

test("openLocalContent returns validated viewer text only for an available artifact", async (t) => {
  const h = harness(t);
  await h.driver.start();
  const text = "# local artifact\n";
  const result = await h.driver.openLocalContent(
    "artifact_version",
    "version-1",
  );
  assert.deepEqual(result, {
    status: "available",
    format: "text/markdown",
    text,
    contentHash: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
    byteCount: Buffer.byteLength(text, "utf8"),
  });
  assert.deepEqual(await h.driver.openLocalContent("approval", "approval-1"), {
    status: "not_on_this_device",
  });
});

test("pending local approvals paginate and return only display metadata", async (t) => {
  const h = harness(t);
  await h.driver.start();
  const row = {
    id: "33333333-3333-4333-8333-333333333333",
    task_id: "99999999-9999-4999-8999-999999999999",
    run_id: "55555555-5555-4555-8555-555555555555",
    operation_id: "44444444-4444-4444-8444-444444444444",
    action_kind: "artifact.write",
    risk: "local_write",
    status: "pending",
    params_hash: "a".repeat(64),
    scope_summary: { path: "private" },
    local_detail_ref: "local-only",
    expires_at: "2027-01-01T00:00:00Z",
  };
  const second = {
    ...row,
    id: "77777777-7777-4777-8777-777777777777",
    action_kind: "model.request",
  };
  const queries = [];
  h.apiResponses.listApprovals = (_action, options) => {
    queries.push(options.query);
    return queries.length === 1
      ? { approvals: [row], next_cursor: "next-page" }
      : { approvals: [second], next_cursor: null };
  };
  assert.deepEqual(await h.driver.listPendingLocalApprovals(), [
    {
      approvalId: row.id,
      taskId: row.task_id,
      runId: row.run_id,
      operationId: row.operation_id,
      actionKind: row.action_kind,
      risk: row.risk,
      expiresAt: row.expires_at,
    },
    {
      approvalId: second.id,
      taskId: second.task_id,
      runId: second.run_id,
      operationId: second.operation_id,
      actionKind: second.action_kind,
      risk: second.risk,
      expiresAt: second.expires_at,
    },
  ]);
  assert.deepEqual(queries, [
    { status: "pending", limit: 100 },
    { status: "pending", limit: 100, cursor: "next-page" },
  ]);
  h.apiResponses.listApprovals = () => ({
    approvals: [{ ...row, id: "not-a-uuid" }],
    next_cursor: null,
  });
  await assert.rejects(
    () => h.driver.listPendingLocalApprovals(),
    (error) => error.code === "shape",
  );
  h.apiResponses.listApprovals = () => ({ approvals: [], next_cursor: "loop" });
  await assert.rejects(
    () => h.driver.listPendingLocalApprovals(),
    (error) => error.code === "shape",
  );
});

test("local approval reads metadata, signs through Broker and submits the closed proof", async (t) => {
  const h = harness(t);
  await h.driver.start();
  const detail = await h.driver.getLocalApproval(
    "33333333-3333-4333-8333-333333333333",
  );
  assert.deepEqual(detail.destinationFacts, {
    localOnlyTaint: true,
    currentActionTaints: true,
    availableDestinations: ["device_local"],
  });
  const requestId = "66666666-6666-4666-8666-666666666666";
  const result = await h.driver.decideLocalApproval(
    detail,
    "approved",
    requestId,
  );
  assert.deepEqual(result, {
    approvalId: detail.approvalId,
    operationId: detail.operationId,
    decision: "approved",
    approvalRevision: 1,
    readonlyGrantId: null,
    runId: "55555555-5555-4555-8555-555555555555",
    replayed: false,
  });
  assert.deepEqual(h.events.slice(-3), [
    "api:getApproval",
    "pipe:prepareLocalApprovalDecision",
    "api:decideApproval",
  ]);
});

test("local approval can remember the exact server-issued readonly scope", async (t) => {
  const h = harness(t);
  await h.driver.start();
  const scope = {
    tool_set: ["workspace.read"],
    resource_selector_hash: "a".repeat(64),
    grant_id: "99999999-9999-4999-8999-999999999999",
    grant_revision: "1",
  };
  h.apiResponses.getApproval = {
    id: "33333333-3333-4333-8333-333333333333",
    operation_id: "44444444-4444-4444-8444-444444444444",
    params_hash: "a".repeat(64),
    revision: 0,
    policy_epoch: 0,
    access_epoch: 0,
    device_id: deviceId,
    action_kind: "workspace.read",
    status: "pending",
    readonly_scope: scope,
    destination_facts: {
      local_only_taint: false,
      current_action_taints: false,
      available_destinations: ["device_local", "org_private", "org_remote"],
    },
  };
  let sent;
  h.pipeResponses.prepareLocalApprovalDecision = (method, fields) => {
    sent = fields;
    return {
      data: {
        status: "ready",
        approval_decision_proof: {
          v: 1,
          org_id: orgId,
          subject_id: subject,
          auth_plane: "bearer",
          auth_epoch: fields.auth_epoch,
          device_id: deviceId,
          session_id: "22222222-2222-4222-8222-222222222222",
          approval_id: fields.approval_id,
          operation_id: fields.operation_id,
          params_hash: fields.params_hash,
          expected_revision: fields.expected_revision,
          decision: fields.decision,
          remember_readonly: true,
          readonly_scope: fields.readonly_scope,
          readonly_expires_at: fields.readonly_expires_at,
          policy_epoch: fields.policy_epoch,
          access_epoch: fields.access_epoch,
          nonce: "nonce-remember-1",
          expires_at: "2027-01-01T00:00:00Z",
          signature: "A".repeat(86),
        },
      },
    };
  };
  const detail = await h.driver.getLocalApproval(
    "33333333-3333-4333-8333-333333333333",
  );
  await h.driver.decideLocalApproval(
    detail,
    "approved",
    "66666666-6666-4666-8666-666666666666",
    true,
  );
  assert.equal(sent.remember_readonly, true);
  assert.deepEqual(sent.readonly_scope, scope);
  assert.ok(Number.isFinite(Date.parse(sent.readonly_expires_at)));
});

test("local approval refuses a proof that does not bind the displayed decision", async (t) => {
  const h = harness(t);
  await h.driver.start();
  const detail = await h.driver.getLocalApproval(
    "33333333-3333-4333-8333-333333333333",
  );
  h.pipeResponses.prepareLocalApprovalDecision = (method, fields) => ({
    data: {
      status: "ready",
      approval_decision_proof: {
        v: 1,
        org_id: orgId,
        subject_id: subject,
        auth_plane: "bearer",
        auth_epoch: fields.auth_epoch,
        device_id: deviceId,
        session_id: "22222222-2222-4222-8222-222222222222",
        approval_id: fields.approval_id,
        operation_id: fields.operation_id,
        params_hash: fields.params_hash,
        expected_revision: fields.expected_revision,
        decision: "rejected",
        remember_readonly: false,
        readonly_scope: null,
        readonly_expires_at: null,
        policy_epoch: fields.policy_epoch,
        access_epoch: fields.access_epoch,
        nonce: "nonce-approval-1",
        expires_at: "2027-01-01T00:00:00Z",
        signature: "A".repeat(86),
      },
    },
  });
  await assert.rejects(
    () =>
      h.driver.decideLocalApproval(
        detail,
        "approved",
        "66666666-6666-4666-8666-666666666666",
      ),
    (error) => error instanceof BrokerPipeError && error.code === "shape",
  );
  assert.equal(h.events.includes("api:decideApproval"), false);
});

test("openLocalContent rejects malformed or mismatched Broker bodies", async (t) => {
  const h = harness(t);
  await h.driver.start();
  h.pipeResponses.openLocalContent = {
    data: {
      status: "available",
      format: "text/markdown",
      text: "body",
      content_hash: `sha256:${"a".repeat(64)}`,
      byte_count: "999",
    },
  };
  await assert.rejects(
    () => h.driver.openLocalContent("artifact_version", "version-1"),
    (error) => error.code === "shape",
  );
  h.pipeResponses.openLocalContent = {
    data: { status: "not_on_this_device", text: "leak" },
  };
  await assert.rejects(
    () => h.driver.openLocalContent("artifact_version", "version-1"),
    (error) => error.code === "shape",
  );
});

// ---- 批2-5: the config digests come from the shipped dev fixture profile, never a placeholder ----

test("local acceptance binds the viewer request, Broker proof and REST submission", async (t) => {
  const h = harness(t);
  await h.driver.start();
  const context = {
    taskId: "22222222-2222-4222-8222-222222222222",
    artifactId: "11111111-1111-4111-8111-111111111111",
    versionId: "77777777-7777-4777-8777-777777777777",
    contentHash: `sha256:${"c".repeat(64)}`,
    revision: 4,
  };
  let sent;
  let submitted;
  h.pipeResponses.prepareLocalAcceptance = (method, fields) => {
    sent = fields;
    return {
      data: {
        status: "ready",
        device_id: deviceId,
        session_id: "22222222-2222-4222-8222-222222222222",
        signature: "A".repeat(86),
        possession_proof: {
          v: 1,
          org_id: orgId,
          subject_id: subject,
          auth_plane: "bearer",
          auth_epoch: fields.auth_epoch,
          device_id: deviceId,
          session_id: "22222222-2222-4222-8222-222222222222",
          task_id: fields.task_id,
          artifact_id: fields.artifact_id,
          version_id: fields.version_id,
          content_hash: fields.content_hash,
          purpose: "accept",
          request_id: fields.request_id,
          nonce: "nonce-accept-1",
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        },
      },
    };
  };
  h.apiResponses.createLocalAcceptance = (action, options) => {
    submitted = options;
    return {
      acceptance_id: "88888888-8888-4888-8888-888888888888",
      task_id: options.id,
      artifact_id: options.body.artifact_id,
      version_no: 1,
      revision: options.body.revision + 1,
      replayed: false,
    };
  };
  const accepted = await h.driver.acceptLocalArtifactVersion(context);
  assert.deepEqual(accepted, {
    acceptanceId: "88888888-8888-4888-8888-888888888888",
    taskId: context.taskId,
    artifactId: context.artifactId,
    versionNo: 1,
    revision: 5,
    replayed: false,
  });
  assert.equal(sent.content_hash, "c".repeat(64));
  assert.equal(submitted.signature, "A".repeat(86));
  assert.equal(submitted.body.possession_proof.request_id, sent.request_id);
  assert.equal(submitted.body.possession_proof.version_id, context.versionId);
  assert.deepEqual(h.events.slice(-2), [
    "pipe:prepareLocalAcceptance",
    "api:createLocalAcceptance",
  ]);
});

test("local acceptance refuses a proof for another version before REST", async (t) => {
  const h = harness(t);
  await h.driver.start();
  h.pipeResponses.prepareLocalAcceptance = (method, fields) => ({
    data: {
      status: "ready",
      device_id: deviceId,
      session_id: "22222222-2222-4222-8222-222222222222",
      signature: "A".repeat(86),
      possession_proof: {
        v: 1,
        org_id: orgId,
        subject_id: subject,
        auth_plane: "bearer",
        auth_epoch: fields.auth_epoch,
        device_id: deviceId,
        session_id: "22222222-2222-4222-8222-222222222222",
        task_id: fields.task_id,
        artifact_id: fields.artifact_id,
        version_id: "99999999-9999-4999-8999-999999999999",
        content_hash: fields.content_hash,
        purpose: "accept",
        request_id: fields.request_id,
        nonce: "nonce-accept-1",
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      },
    },
  });
  await assert.rejects(
    () =>
      h.driver.acceptLocalArtifactVersion({
        taskId: "22222222-2222-4222-8222-222222222222",
        artifactId: "11111111-1111-4111-8111-111111111111",
        versionId: "77777777-7777-4777-8777-777777777777",
        contentHash: `sha256:${"c".repeat(64)}`,
        revision: 4,
      }),
    (error) => error.code === "shape",
  );
  assert.equal(h.events.includes("api:createLocalAcceptance"), false);
});

test("workspace grant list returns only closed metadata for rebind selection", async (t) => {
  const h = harness(t);
  await h.driver.start();
  await h.driver.grantWorkspace(["WeMeet成果"]);
  h.pipeResponses.listWorkspaceGrants = {
    data: {
      status: "available",
      grants: [
        {
          grant_id: workspaceGrantId,
          root_identity_hash: `sha256:${"a".repeat(64)}`,
          artifact_dir: ["WeMeet成果"],
        },
      ],
    },
  };
  assert.deepEqual(await h.driver.listWorkspaceGrants(), [
    {
      grantId: workspaceGrantId,
      rootIdentityHash: `sha256:${"a".repeat(64)}`,
      artifactDir: ["WeMeet成果"],
    },
  ]);
});

test("workspace rebind uses the Broker session and submits the exact succession proof", async (t) => {
  let confirmed;
  const h = harness(t, {
    confirmRebind: (facts) => {
      confirmed = facts;
      return true;
    },
  });
  await h.driver.start();
  const runId = "88888888-8888-4888-8888-888888888888";
  const oldGrantId = "11111111-1111-4111-8111-111111111111";
  const newGrantId = "22222222-2222-4222-8222-222222222222";
  const sessionId = "33333333-3333-4333-8333-333333333333";
  let sent;
  let submitted;
  h.pipeResponses.rebindRunWorkspace = (method, fields) => {
    sent = fields;
    return {
      data: {
        old_grant_id: oldGrantId,
        new_grant_id: newGrantId,
        root_identity_hash: "a".repeat(64),
        run_id: runId,
        session_id: sessionId,
        auth_plane: "bearer",
        auth_epoch: fields.auth_epoch,
        nonce: "nonce-rebind-1",
        expires_at: new Date(Date.now() + 240_000).toISOString(),
        signature: "A".repeat(86),
      },
    };
  };
  h.apiResponses.rebindRunWorkspace = (action, options) => {
    submitted = options;
    return {
      run_id: runId,
      old_grant_id: oldGrantId,
      new_grant_id: newGrantId,
      binding_revision: 2,
      expected_checkpoint_seq: 0,
      expected_checkpoint_hash: "d".repeat(64),
      offer_expiry: new Date(Date.now() + 120_000).toISOString(),
      state: "active",
      checkpoint_seq: 0,
      checkpoint_hash: "d".repeat(64),
      invalidated_readonly_grants: 2,
      replayed: false,
    };
  };
  const rebound = await h.driver.rebindRunWorkspace(
    runId,
    oldGrantId,
    newGrantId,
  );
  assert.deepEqual(rebound, {
    runId,
    oldGrantId,
    newGrantId,
    bindingRevision: 2,
    state: "active",
    invalidatedReadonlyGrants: 2,
    replayed: false,
  });
  assert.equal(Object.hasOwn(sent, "session_id"), false);
  assert.equal(sent.auth_epoch, "1");
  assert.equal(submitted.body.grant_succession_proof.session_id, sessionId);
  assert.equal(submitted.body.grant_succession_proof.run_id, runId);
  assert.deepEqual(confirmed, {
    runId,
    oldGrantId,
    newGrantId,
    rootIdentityHash: "a".repeat(64),
  });
  assert.deepEqual(h.events.slice(-3), [
    "pipe:rebindRunWorkspace",
    "gesture:confirmRebind",
    "api:rebindRunWorkspace",
  ]);
});

test("workspace rebind cancellation submits no REST request", async (t) => {
  let confirmed = false;
  const h = harness(t, {
    confirmRebind: () => {
      confirmed = true;
      return false;
    },
  });
  await h.driver.start();
  const runId = "88888888-8888-4888-8888-888888888888";
  const oldGrantId = "11111111-1111-4111-8111-111111111111";
  const newGrantId = "22222222-2222-4222-8222-222222222222";
  h.pipeResponses.rebindRunWorkspace = (method, fields) => ({
    data: {
      old_grant_id: oldGrantId,
      new_grant_id: newGrantId,
      root_identity_hash: "a".repeat(64),
      run_id: runId,
      session_id: "33333333-3333-4333-8333-333333333333",
      auth_plane: "bearer",
      auth_epoch: fields.auth_epoch,
      nonce: "nonce-rebind-cancel",
      expires_at: new Date(Date.now() + 240_000).toISOString(),
      signature: "A".repeat(86),
    },
  });
  await assert.rejects(
    () => h.driver.rebindRunWorkspace(runId, oldGrantId, newGrantId),
    (error) => error.code === "cancelled",
  );
  assert.equal(confirmed, true);
  assert.deepEqual(h.events.slice(-2), [
    "pipe:rebindRunWorkspace",
    "gesture:confirmRebind",
  ]);
  assert.equal(h.events.includes("api:rebindRunWorkspace"), false);
});

test("workspace rebind refuses a proof for another run before REST", async (t) => {
  const h = harness(t);
  await h.driver.start();
  h.pipeResponses.rebindRunWorkspace = (method, fields) => ({
    data: {
      old_grant_id: fields.old_grant_id,
      new_grant_id: fields.new_grant_id,
      root_identity_hash: "a".repeat(64),
      run_id: "99999999-9999-4999-8999-999999999999",
      session_id: "33333333-3333-4333-8333-333333333333",
      auth_plane: "bearer",
      auth_epoch: fields.auth_epoch,
      nonce: "nonce-rebind-1",
      expires_at: new Date(Date.now() + 240_000).toISOString(),
      signature: "A".repeat(86),
    },
  });
  await assert.rejects(
    () =>
      h.driver.rebindRunWorkspace(
        "88888888-8888-4888-8888-888888888888",
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ),
    (error) => error.code === "shape",
  );
  assert.equal(h.events.includes("api:rebindRunWorkspace"), false);
});

test("local artifact edit carries task context, signs, publishes and completes the ack", async (t) => {
  const h = harness(t);
  await h.driver.start();
  const context = {
    artifactId: "11111111-1111-4111-8111-111111111111",
    taskId: "44444444-4444-4444-8444-444444444444",
    baseVersionId: "55555555-5555-4555-8555-555555555555",
    baseVersionNo: 1,
    baseHash: `sha256:${"a".repeat(64)}`,
  };
  const opened = await h.driver.editLocalArtifact(context);
  assert.equal(opened.status, "available");
  const draft = await h.driver.prepareLocalArtifactEdit({
    context,
    format: "text/markdown",
    body: "edited body",
  });
  assert.equal(draft.byteCount, 11);
  assert.match(draft.contentHash, /^sha256:[0-9a-f]{64}$/);
  const published = await h.driver.confirmLocalArtifactEdit(
    draft.requestId,
    draft.contentHash,
  );
  assert.deepEqual(published, {
    versionId: draft.versionId,
    versionNo: 2,
    publishAck: `sha256:${"b".repeat(64)}`,
    replayed: false,
  });
  assert.ok(h.events.includes("pipe:prepareLocalArtifactEdit"));
  assert.ok(h.events.includes("api:createLocalArtifactVersion"));
  assert.ok(h.events.includes("pipe:completeLocalArtifactEdit"));
});

test("local artifact drafts are discoverable and reopen without renderer body bytes", async (t) => {
  const h = harness(t);
  await h.driver.start();
  const taskId = "22222222-2222-4222-8222-222222222222";
  const artifactId = "11111111-1111-4111-8111-111111111111";
  const drafts = await h.driver.listLocalArtifactDrafts(taskId, artifactId);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].publishState, "pending_confirm");
  assert.equal(drafts[0].baseVersionNo, 4);
  const opened = await h.driver.openLocalArtifactDraft(
    taskId,
    artifactId,
    drafts[0].versionId,
  );
  assert.equal(opened.status, "available");
  assert.equal(opened.draft.requestId, "44444444-4444-4444-8444-444444444444");
  assert.equal(opened.text, "# local draft\n");
  assert.ok(h.events.includes("pipe:listLocalArtifactDrafts"));
});

test("submitLocalTask previews, confirms natively, signs and submits the exact local intent", async (t) => {
  let submit;
  let confirmationFacts;
  const h = harness(t, {
    apiResponse(action, options) {
      if (action === "submitLocalTask") submit = options;
    },
    confirmSubmission(facts) {
      confirmationFacts = facts;
      return true;
    },
  });
  await h.driver.start();
  await h.driver.grantWorkspace(["WeMeet成果"]);
  const inputRef = "12345678-1234-4234-8234-123456789abc";
  const inputHash = `sha256:${"a".repeat(64)}`;
  const result = await h.driver.submitLocalTask({
    clientRequestId: "local-submit-1",
    inputRef,
    inputHash,
    inputBytes: 27,
    title: "local goal",
    templateId: "summary",
    templateVersion: 1,
    permissionMode: "ask_each",
    outputFormat: "text/markdown",
    selectedGrantIds: [workspaceGrantId],
  });
  assert.deepEqual(result, {
    taskId: "99999999-9999-4999-8999-999999999999",
    runId: "55555555-5555-4555-8555-555555555555",
    revision: 1,
    bindingRevision: 1,
    taskState: "open",
    displayState: "queued",
    inputRef,
  });
  assert.equal(confirmationFacts.artifactClassificationFloor, "local_only");
  assert.deepEqual(confirmationFacts.availableDestinations, ["device_local"]);
  const relevant = h.events.filter(
    (event) =>
      event === "api:createLocalTaskPreview" ||
      event === "gesture:confirmSubmission" ||
      event === "pipe:confirmLocalSubmission" ||
      event === "api:submitLocalTask",
  );
  assert.deepEqual(relevant, [
    "api:createLocalTaskPreview",
    "gesture:confirmSubmission",
    "pipe:confirmLocalSubmission",
    "api:submitLocalTask",
  ]);
  assert.equal(submit.body.local_intent.request_id, "local-submit-1");
  assert.equal(submit.body.local_intent.auth_epoch, "1");
  assert.deepEqual(submit.body.local_intent.selected_grant_ids, [
    workspaceGrantId,
  ]);
  assert.deepEqual(submit.body.local_intent.grant_revisions, ["1"]);
  assert.equal(submit.body.local_intent.profile_id, "profile-dev-fixture-v1");
  assert.equal(submit.body.local_intent.profile_revision, "1");
  assert.equal(
    submit.body.local_intent.profile_hash,
    createHash("sha256")
      .update(
        readFileSync(
          path.join(
            h.resourceRoot,
            "work-device-bundle",
            "dev-fixture-profile.json",
          ),
        ),
      )
      .digest("hex"),
  );
});

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
  writeFileSync(
    path.join(h.resourceRoot, "work-device-bundle", "dev-fixture-profile.json"),
    JSON.stringify({
      profile_id: "profile-dev-fixture-v1",
      tool_manifest_hash: "not-hex",
      runtime_digest: "b".repeat(64),
    }),
  );
  await h.driver.start();
  assert.equal(h.driver.currentState, "failed");
  assert.equal(h.configs.length, 0);
});
