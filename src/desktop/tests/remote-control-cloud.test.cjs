const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { RemoteControlCloud } = require("../dist/remote-control/cloud.js");

const roomId = "12345678-1234-1234-1234-123456789012";
const auth = () => ({
  epoch: 1,
  signedIn: true,
  access: async () => "isolated-test-token",
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

test("the total request deadline covers credentials and late credentials cannot start HTTP", async (t) => {
  const deadline = new AbortController();
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return deadline.signal;
  });
  let resolveCredentials,
    credentialsStarted,
    fetches = 0;
  const started = new Promise((resolve) => {
    credentialsStarted = resolve;
  });
  const credentials = new Promise((resolve) => {
    resolveCredentials = resolve;
  });
  const cloud = new RemoteControlCloud(
    "https://meeting.example.test",
    {
      ...auth(),
      access: () => {
        credentialsStarted();
        return credentials;
      },
    },
    async () => {
      fetches++;
      return new Response(JSON.stringify({ serverTime: 1800000000 }));
    },
  );
  const result = cloud.request("capabilities", roomId).then(
    () => "resolved",
    (error) => error.code,
  );
  await started;
  deadline.abort(new DOMException("Test deadline", "TimeoutError"));
  let observed;
  try {
    observed = await Promise.race([
      result,
      delay(100).then(() => "still-pending"),
    ]);
  } finally {
    resolveCredentials("late-isolated-test-token");
    await result;
  }
  assert.equal(observed, "remote_request_failed");
  assert.deepEqual(timeouts, [8000]);
  assert.equal(fetches, 0);
});

test("account replacement in the deadline scheduling gap cannot obtain credentials", async () => {
  const account = auth();
  let accesses = 0;
  account.access = async () => {
    accesses++;
    return "isolated-test-token";
  };
  const cloud = new RemoteControlCloud(
    "https://meeting.example.test",
    account,
    async () => {
      throw new Error("HTTP must not start");
    },
  );
  const result = cloud.request("capabilities", roomId);
  account.epoch++;
  await assert.rejects(
    result,
    (error) => error.code === "remote_account_changed",
  );
  assert.equal(accesses, 0);
});

test("real HTTP redirects are refused without making the redirected request", async (t) => {
  const paths = [];
  const origin = await localServer(t, (request, response) => {
    paths.push(request.url);
    response.writeHead(302, { Location: "/must-not-follow" });
    response.end();
  });
  await assert.rejects(
    new RemoteControlCloud(origin, auth()).request("capabilities", roomId),
    (error) => error.code === "remote_request_failed",
  );
  assert.deepEqual(paths, [
    `/api/v1.0/rooms/${roomId}/remote-control/capabilities/`,
  ]);
});

test(
  "real HTTP deadlines cover both stalled headers and a never-ending response body",
  { timeout: 12000 },
  async (t) => {
    const observed = await Promise.all(
      ["headers", "body"].map(async (phase) => {
        const origin = await localServer(t, (_request, response) => {
          if (phase === "body") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.write('{"serverTime":1800000000,"unfinished":');
          }
        });
        const started = performance.now();
        await assert.rejects(
          new RemoteControlCloud(origin, auth()).request(
            "capabilities",
            roomId,
          ),
          (error) => error.code === "remote_request_failed",
        );
        return { phase, elapsedMs: Math.round(performance.now() - started) };
      }),
    );
    for (const result of observed) {
      assert.ok(
        result.elapsedMs >= 7900,
        "Exercise the real eight-second deadline",
      );
      assert.ok(
        result.elapsedMs < 11000,
        "Test watchdog is not the request deadline",
      );
      t.diagnostic(`${result.phase}: ${result.elapsedMs} ms`);
    }
  },
);
