const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const {
  VIEWER_METHODS,
  allowViewerRequest,
  isViewerSender,
  validateViewerMessage,
  validateViewerPayload,
  viewerUrl,
  viewerWindowOptions,
} = require("../dist/work/viewer.js");

test("viewer window uses a dedicated preload and an empty non-persistent partition", () => {
  const options = viewerWindowOptions("C:\\app\\viewer-preload.js");
  assert.equal(options.webPreferences.preload, "C:\\app\\viewer-preload.js");
  assert.equal(options.webPreferences.partition, "");
  assert.equal(options.webPreferences.cache, false);
  assert.equal(Object.hasOwn(options.webPreferences, "session"), false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.devTools, false);
  assert.equal(options.webPreferences.spellcheck, false);
  assert.equal(options.webPreferences.webviewTag, false);
  assert.throws(
    () => viewerWindowOptions("C:\\app\\preload.js"),
    /dedicated preload/,
  );
});

test("viewer requests cannot escape the signed local scheme", () => {
  assert.equal(allowViewerRequest("wemeet-local://viewer/index.html"), true);
  for (const url of [
    "https://example.test/",
    "http://example.test/",
    "file:///C:/secret.txt",
    "data:text/html,hello",
    "wemeet-local://other/index.html",
    "wemeet-local://user@viewer/index.html",
  ])
    assert.equal(allowViewerRequest(url), false, url);
  assert.equal(viewerUrl(), "wemeet-local://viewer/index.html");
  assert.throws(() => viewerUrl("../secret"));
});

test("viewer message closure is separate from the shell and forbids arbitrary targets", () => {
  assert.deepEqual(
    [...VIEWER_METHODS],
    [
      "decideLocalApproval",
      "prepareUserArtifactVersion",
      "confirmLocalWrite",
      "confirmDisclosureDecision",
      "signObjectProof",
      "close",
    ],
  );
  for (const method of VIEWER_METHODS) {
    assert.equal(validateViewerMessage({ method, payload: {} }), method);
  }
  for (const method of [
    "chooseWorkspace",
    "stageLocalInput",
    "openLocalContent",
  ]) {
    assert.throws(
      () => validateViewerMessage({ method }),
      /unknown viewer method/,
    );
  }
  for (const field of ["command", "path", "url"]) {
    assert.throws(
      () => validateViewerMessage({ method: "close", [field]: "x" }),
      /forbidden/,
    );
  }
  assert.throws(() => validateViewerMessage(null), /object/);
});

test("viewer payloads bind the current object and consume authorized requests", () => {
  const artifact = {
    kind: "artifact_version",
    id: "55555555-5555-4555-8555-555555555555",
  };
  const requests = new Set(["request-1"]);
  const proof = {
    purpose: "accept",
    artifact_id: "44444444-4444-4444-8444-444444444444",
    version_id: "55555555-5555-4555-8555-555555555555",
    content_hash: `sha256:${"a".repeat(64)}`,
    request_id: "request-1",
  };
  assert.deepEqual(
    validateViewerPayload("signObjectProof", proof, artifact, requests),
    proof,
  );
  assert.throws(
    () =>
      validateViewerPayload(
        "signObjectProof",
        { ...proof, artifact_id: "artifact-2" },
        artifact,
        requests,
      ),
    /artifact mismatch/,
  );
  assert.throws(
    () =>
      validateViewerPayload(
        "signObjectProof",
        { ...proof, version_id: "99999999-9999-4999-8999-999999999999" },
        artifact,
        requests,
      ),
    /artifact mismatch/,
  );
  assert.throws(
    () =>
      validateViewerPayload(
        "signObjectProof",
        { ...proof, request_id: "request-2" },
        artifact,
        requests,
      ),
    /not authorized/,
  );
  assert.throws(
    () =>
      validateViewerPayload(
        "signObjectProof",
        { ...proof, url: "https://evil.test" },
        artifact,
        requests,
      ),
    /unexpected viewer field/,
  );
  assert.throws(
    () =>
      validateViewerPayload(
        "confirmDisclosureDecision",
        {},
        { kind: "artifact_version", id: "artifact-1" },
        requests,
      ),
    /unavailable/,
  );
  assert.equal(
    validateViewerPayload("close", undefined, artifact, requests),
    undefined,
  );
});

test("viewer approval decisions use the server vocabulary and bind the request", () => {
  const binding = { kind: "approval", id: "approval-1" };
  for (const decision of ["approved", "rejected"]) {
    const payload = {
      approval_id: "approval-1",
      request_id: `request-${decision}`,
      decision,
      remember_readonly: false,
    };
    assert.deepEqual(
      validateViewerPayload(
        "decideLocalApproval",
        payload,
        binding,
        new Set([payload.request_id]),
      ),
      payload,
    );
  }
  assert.deepEqual(
    validateViewerPayload(
      "decideLocalApproval",
      {
        approval_id: "approval-1",
        request_id: "request-remember",
        decision: "approved",
        remember_readonly: true,
      },
      binding,
      new Set(["request-remember"]),
    ),
    {
      approval_id: "approval-1",
      request_id: "request-remember",
      decision: "approved",
      remember_readonly: true,
    },
  );
  assert.throws(
    () =>
      validateViewerPayload(
        "decideLocalApproval",
        {
          approval_id: "approval-1",
          request_id: "request-rejected",
          decision: "rejected",
          remember_readonly: true,
        },
        binding,
        new Set(["request-rejected"]),
      ),
    /invalid readonly remembrance/,
  );
  assert.throws(
    () =>
      validateViewerPayload(
        "decideLocalApproval",
        {
          approval_id: "approval-1",
          request_id: "request-approved",
          decision: "denied",
          remember_readonly: false,
        },
        binding,
        new Set(["request-approved"]),
      ),
    /invalid approval decision/,
  );
});

test("viewer artifact edits and local write actions use closed payloads", () => {
  const binding = { kind: "artifact_edit", id: "artifact-1" };
  const body = {
    artifact_id: "artifact-1",
    base_version_no: 3,
    base_hash: "sha256:base",
    format: "text/markdown",
    body: "# edited",
  };
  assert.deepEqual(
    validateViewerPayload(
      "prepareUserArtifactVersion",
      body,
      binding,
      new Set(),
    ),
    body,
  );
  for (const action of ["confirm", "discard", "cancel"]) {
    const payload = {
      request_id: `request-${action}`,
      action,
      sealed_hash: "sha256:sealed",
    };
    assert.deepEqual(
      validateViewerPayload(
        "confirmLocalWrite",
        payload,
        binding,
        new Set([payload.request_id]),
      ),
      payload,
    );
  }
  assert.throws(
    () =>
      validateViewerPayload(
        "confirmLocalWrite",
        {
          request_id: "request-1",
          action: "publish",
          sealed_hash: "sha256:sealed",
        },
        binding,
        new Set(["request-1"]),
      ),
    /invalid local write action/,
  );
});

test("viewer sender must be the bound webContents main frame", () => {
  const mainFrame = { url: "wemeet-local://viewer/index.html" };
  const webContents = { mainFrame };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.equal(isViewerSender(event, webContents), true);
  assert.equal(
    isViewerSender({ sender: {}, senderFrame: mainFrame }, webContents),
    false,
  );
  assert.equal(
    isViewerSender({ sender: webContents, senderFrame: {} }, webContents),
    false,
  );
  assert.equal(
    isViewerSender({ sender: webContents, senderFrame: null }, webContents),
    false,
  );
  assert.equal(
    isViewerSender(
      {
        sender: webContents,
        senderFrame: { url: "https://example.test/" },
      },
      webContents,
    ),
    false,
  );
});
