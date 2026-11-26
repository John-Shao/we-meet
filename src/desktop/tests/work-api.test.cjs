const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { WorkApi, WorkApiError } = require("../dist/work/api.js");

const pairingId = "12345678-1234-1234-1234-123456789012";
const deviceId = "abcdefab-abcd-abcd-abcd-abcdefabcdef";
const artifactId = "11111111-1111-4111-8111-111111111111";
const approvalId = "33333333-3333-4333-8333-333333333333";
const auth = () => ({
  epoch: 1,
  signedIn: true,
  subject: "subject-1",
  access: async () => "work-test-token",
});

async function localServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof WorkApiError && error.code === code,
  );
}

test("the endpoint table is closed and every route carries the Bearer plane headers", async (t) => {
  const seen = [];
  const origin = await localServer(t, (request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const api = new WorkApi(origin, auth());
  await api.request("identity");
  await api.request("listDevices");
  await api.request("pair", { body: { device_name: "test" } });
  await api.request("confirmPairing", {
    id: pairingId,
    body: { signature: "s" },
  });
  await api.request("mintTicket", { id: deviceId, body: {} });
  await api.request("requestRenewal", { id: deviceId, body: {} });
  await api.request("confirmRenewal", { id: pairingId, body: {} });
  await api.request("revoke", { id: deviceId, body: {} });
  await api.request("registerWorkspaceGrant", {
    body: {
      device_id: deviceId,
      session_id: "44444444-4444-4444-8444-444444444444",
      client_request_id: "grant-request-1",
      grant: { root_identity_hash: "a".repeat(64) },
    },
  });
  await api.request("listWorkspaceGrants");
  await api.request("createLocalArtifactVersion", {
    id: artifactId,
    body: { kind: "local", user_version_proof: { v: 1 } },
    signature: "A".repeat(86),
  });
  await api.request("listApprovals", {
    query: { status: "pending", limit: 100, cursor: "next-page" },
  });
  await api.request("getApproval", { id: approvalId });
  await api.request("decideApproval", {
    id: approvalId,
    body: {
      client_request_id: "approval-request-1",
      decision: { v: 1, signature: "A".repeat(86) },
    },
  });
  assert.deepEqual(
    seen.map((entry) => `${entry.method} ${entry.url}`),
    [
      "GET /work/v2/identity",
      "GET /work/v2/devices",
      "POST /work/v2/devices/pairings",
      `POST /work/v2/devices/pairings/${pairingId}/confirm`,
      `POST /work/v2/devices/${deviceId}/session-tickets`,
      `POST /work/v2/devices/${deviceId}/certificate-renewals`,
      `POST /work/v2/devices/certificate-renewals/${pairingId}/confirm`,
      `POST /work/v2/devices/${deviceId}/revoke`,
      "POST /work/v2/workspace-grants",
      "GET /work/v2/workspace-grants",
      `POST /work/v2/artifacts/${artifactId}/versions`,
      "GET /work/v2/approvals?status=pending&limit=100&cursor=next-page",
      `GET /work/v2/approvals/${approvalId}`,
      `POST /work/v2/approvals/${approvalId}/decisions`,
    ],
  );
  for (const entry of seen) {
    assert.equal(entry.headers.authorization, "Bearer work-test-token");
    assert.equal(entry.headers["x-work-client"], "desktop");
    assert.equal(entry.headers["content-type"], "application/json");
  }
  assert.equal(seen[0].body, "");
  assert.equal(seen[8].headers["x-device-signature"], undefined);
  assert.equal(seen[9].headers["x-device-signature"], undefined);
  assert.equal(seen[10].headers["x-device-signature"], "A".repeat(86));
  assert.equal(seen[11].headers["x-device-signature"], undefined);
  assert.equal(seen[12].headers["x-device-signature"], undefined);
  assert.equal(seen[13].headers["x-device-signature"], undefined);
  assert.equal(JSON.parse(seen[13].body).decision.signature, "A".repeat(86));
  assert.deepEqual(JSON.parse(seen[2].body), { device_name: "test" });
});

test("unclosed actions, ids and bodies are refused before any request", async (t) => {
  let fetches = 0;
  const api = new WorkApi("https://meet.example.test", auth(), async () => {
    fetches++;
    return new Response("{}");
  });
  await expectCode(api.request("execute"), "invalid_work_request");
  await expectCode(api.request("confirmPairing"), "invalid_work_request");
  await expectCode(
    api.request("confirmPairing", { id: "not-a-uuid" }),
    "invalid_work_request",
  );
  await expectCode(
    api.request("identity", { id: pairingId }),
    "invalid_work_request",
  );
  await expectCode(
    api.request("identity", { body: {} }),
    "invalid_work_request",
  );
  await expectCode(
    api.request("pair", { body: { blob: "x".repeat(16385) } }),
    "invalid_work_request",
  );
  await expectCode(
    api.request("createLocalArtifactVersion", { id: artifactId, body: {} }),
    "invalid_work_request",
  );
  await expectCode(
    api.request("identity", { signature: "A".repeat(86) }),
    "invalid_work_request",
  );
  await expectCode(
    api.request("identity", { query: { status: "pending" } }),
    "invalid_work_request",
  );
  await expectCode(
    api.request("listApprovals", { query: { status: "approved" } }),
    "invalid_work_request",
  );
  await expectCode(
    api.request("listApprovals", { query: { cursor: "bad\0cursor" } }),
    "invalid_work_request",
  );
  await expectCode(
    api.request("createLocalArtifactVersion", {
      id: artifactId,
      body: {},
      signature: "bad",
    }),
    "invalid_work_request",
  );
  assert.equal(fetches, 0);
});

test("the origin is closed: https or loopback http only, no path, credentials or trailing slash", () => {
  for (const bad of [
    "https://meet.example.test/",
    "https://meet.example.test/path",
    "https://user:pass@meet.example.test",
    "http://meet.example.test",
    "ftp://meet.example.test",
    "https://meet.example.test?q=1",
  ]) {
    assert.throws(
      () => new WorkApi(bad, auth()),
      (error) =>
        error instanceof WorkApiError &&
        error.code === "invalid_service_origin",
    );
  }
  for (const good of [
    "https://meet.example.test",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
  ]) {
    new WorkApi(good, auth());
  }
});

test("an account change fences the request at every async boundary", async () => {
  const mutable = { epoch: 1, signedIn: true, access: async () => "token" };
  let fetches = 0;
  const api = new WorkApi("https://meet.example.test", mutable, async () => {
    fetches++;
    return new Response("{}");
  });
  mutable.access = async () => {
    mutable.epoch = 2;
    return "token";
  };
  await expectCode(api.request("identity"), "work_account_changed");
  assert.equal(fetches, 0);
  mutable.epoch = 1;
  mutable.signedIn = false;
  await expectCode(api.request("identity"), "work_account_changed");
  assert.equal(fetches, 0);
});

test("missing or failing credentials never start HTTP", async () => {
  let fetches = 0;
  const fetcher = async () => {
    fetches++;
    return new Response("{}");
  };
  await expectCode(
    new WorkApi(
      "https://meet.example.test",
      { ...auth(), access: async () => undefined },
      fetcher,
    ).request("identity"),
    "work_auth_unavailable",
  );
  await expectCode(
    new WorkApi(
      "https://meet.example.test",
      {
        ...auth(),
        access: async () => {
          throw new Error("no store");
        },
      },
      fetcher,
    ).request("identity"),
    "work_auth_unavailable",
  );
  assert.equal(fetches, 0);
});

test("the total deadline covers credentials and late credentials cannot start HTTP", async (t) => {
  const deadline = new AbortController();
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return deadline.signal;
  });
  let resolveCredentials,
    fetches = 0;
  const credentials = new Promise((resolve) => (resolveCredentials = resolve));
  const api = new WorkApi(
    "https://meet.example.test",
    { ...auth(), access: () => credentials },
    async () => {
      fetches++;
      return new Response("{}");
    },
  );
  const pending = api.request("identity").then(
    () => "resolved",
    (error) => error.code,
  );
  await delay(10);
  deadline.abort(new Error("deadline"));
  resolveCredentials("late-token");
  assert.equal(await pending, "work_request_failed");
  assert.equal(fetches, 0);
  assert.deepEqual(timeouts, [8000]);
});

test("only closed public codes branch; anything else is a transport failure", async (t) => {
  const origin = await localServer(t, (request, response) => {
    response.statusCode = 403;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ code: "csrf_invalid" }));
  });
  const api = new WorkApi(origin, auth());
  await expectCode(api.request("identity"), "csrf_invalid");
  // The closed set is the device face's error-codes.json vocabulary.
  for (const code of [
    "unauthorized",
    "invalid_request",
    "not_found",
    "forbidden",
    "idempotency_conflict",
    "idempotency_key_conflict",
    "device_revoked",
    "local_policy_not_configured",
    "local_policy_incomplete",
    "invalid_pagination",
    "service_degraded",
  ]) {
    const face = new WorkApi(
      origin,
      auth(),
      async () => new Response(JSON.stringify({ code }), { status: 400 }),
    );
    await expectCode(face.request("identity"), code);
  }
  await expectCode(
    new WorkApi(
      origin,
      auth(),
      async () =>
        new Response(JSON.stringify({ code: "made_up" }), { status: 400 }),
    ).request("identity"),
    "work_request_failed",
  );
  await expectCode(
    new WorkApi(origin, auth(), async () => new Response("not json")).request(
      "identity",
    ),
    "work_request_failed",
  );
});

test("a redirect is a transport failure, never followed", async (t) => {
  const origin = await localServer(t, (request, response) => {
    response.statusCode = 302;
    response.setHeader("Location", "https://elsewhere.example.test/");
    response.end();
  });
  await expectCode(
    new WorkApi(origin, auth()).request("identity"),
    "work_request_failed",
  );
});

test("success bodies must be JSON objects and stay under the response cap", async (t) => {
  const api = (body) =>
    new WorkApi(
      "https://meet.example.test",
      auth(),
      async () => new Response(body),
    );
  await expectCode(api("[1,2]").request("identity"), "work_response_invalid");
  await expectCode(api("null").request("identity"), "work_response_invalid");
  const oversize = "x".repeat(262145);
  await expectCode(
    api(JSON.stringify({ blob: oversize })).request("identity"),
    "work_response_oversize",
  );
  const honest = await api(
    JSON.stringify({ org_id: "org", subject_id: "sub" }),
  ).request("identity");
  assert.deepEqual(honest, { org_id: "org", subject_id: "sub" });
});

test("a streamed response that grows past the cap is cancelled mid-stream", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(200000)));
      controller.enqueue(new TextEncoder().encode("x".repeat(100000)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const api = new WorkApi(
    "https://meet.example.test",
    auth(),
    async () => new Response(stream),
  );
  await expectCode(api.request("identity"), "work_response_oversize");
  assert.equal(cancelled, true);
});
