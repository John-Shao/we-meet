// The shell pipe client against a REAL Windows named-pipe server (net.createServer on
// \\.\pipe\...), speaking the Broker's own framing and one-time handshake. Windows-only:
// named pipes are the shipped transport (device-design §1).
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const net = require("node:net");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { BrokerPipe, BrokerPipeError, encodeFrame, MAX_FRAME_BYTES, PROTOCOL_MAJOR } = require("../dist/work/pipe.js");

const windows = { skip: process.platform !== "win32" };
const frame = (value) => encodeFrame(Buffer.from(JSON.stringify(value), "utf8"));

function startBroker(t, { hello, onMessage } = {}) {
  const name = `\\\\.\\pipe\\work-pipe-test-${randomUUID()}`;
  const state = { hellos: [], messages: [], sockets: [] };
  const server = net.createServer((socket) => {
    state.sockets.push(socket);
    let buffer = Buffer.alloc(0);
    const send = (value) => socket.write(frame(value));
    send(hello ?? { nonce: `nonce-${randomUUID()}`, protocol_major: PROTOCOL_MAJOR });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        if (message.client_kind !== undefined) { state.hellos.push(message); continue; }
        state.messages.push(message);
        if (onMessage) onMessage(message, send, socket);
        else send({ request_id: message.request_id, method: message.method, result: "accepted", data: { echoed: true } });
      }
    });
    socket.on("error", () => {});
  });
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(name, resolve);
  });
  t.after(async () => {
    for (const socket of state.sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { name, state, listening };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof BrokerPipeError && error.code === code);
}

test("the handshake echoes the server nonce in the closed three-key shell hello", windows, async (t) => {
  const nonce = `nonce-${randomUUID()}`;
  const { name, state, listening } = startBroker(t, { hello: { nonce, protocol_major: PROTOCOL_MAJOR } });
  await listening;
  const pipe = await BrokerPipe.connect(name);
  t.after(() => pipe.close());
  await delay(20);
  assert.equal(state.hellos.length, 1);
  assert.deepEqual(state.hellos[0], { nonce, protocol_major: PROTOCOL_MAJOR, client_kind: "shell" });
  const reply = await pipe.call("getDeviceIdentity");
  assert.deepEqual(reply, { data: { echoed: true } });
  assert.equal(state.messages[0].method, "getDeviceIdentity");
  assert.match(state.messages[0].request_id, /^[0-9a-f-]{36}$/);
});

test("an unclosed or mistyped server hello refuses the connection", windows, async (t) => {
  for (const hello of [
    { nonce: "n", protocol_major: PROTOCOL_MAJOR + 1 },
    { nonce: "n", protocol_major: PROTOCOL_MAJOR, extra: 1 },
    { protocol_major: PROTOCOL_MAJOR },
    { nonce: 42, protocol_major: PROTOCOL_MAJOR },
  ]) {
    const { name, listening } = startBroker(t, { hello });
    await listening;
    await expectCode(BrokerPipe.connect(name), "handshake");
  }
});

test("a refused reply carries only the closed code vocabulary", windows, async (t) => {
  const { name, listening } = startBroker(t, {
    onMessage: (message, send) => send({ request_id: message.request_id, method: message.method, result: "refused", code: "certificate_invalid" }),
  });
  await listening;
  const pipe = await BrokerPipe.connect(name);
  t.after(() => pipe.close());
  await expectCode(pipe.call("deliverDeviceCertificate", { device_id: "d", certificate_pem: "p" }), "certificate_invalid");
});

test("the restart re-delivery carrier is closed and carries the org declaration", windows, async (t) => {
  const { name, state, listening } = startBroker(t);
  await listening;
  const pipe = await BrokerPipe.connect(name);
  t.after(() => pipe.close());
  const reply = await pipe.call("redeliverDeviceCertificate", { device_id: "d", certificate_pem: "p", org_id: "o" });
  assert.deepEqual(reply, { data: { echoed: true } });
  assert.equal(state.messages[0].method, "redeliverDeviceCertificate");
  assert.equal(state.messages[0].org_id, "o");
});

test("an unclosed refusal code or a malformed accepted reply is a schema failure", windows, async (t) => {
  const replies = [
    { result: "refused", code: "made_up_code" },
    { result: "accepted", data: [1, 2] },
    { result: "accepted", data: "text" },
    { result: "maybe" },
  ];
  for (const reply of replies) {
    const { name, listening } = startBroker(t, {
      onMessage: (message, send) => send({ request_id: message.request_id, method: message.method, ...reply }),
    });
    await listening;
    const pipe = await BrokerPipe.connect(name);
    t.after(() => pipe.close());
    await expectCode(pipe.call("getDeviceIdentity"), "schema");
  }
});

test("forbidden top-level fields and unclosed methods never reach the pipe", windows, async (t) => {
  const { name, state, listening } = startBroker(t);
  await listening;
  const pipe = await BrokerPipe.connect(name);
  t.after(() => pipe.close());
  for (const forbidden of ["command", "path", "url"]) {
    await expectCode(pipe.call("getDeviceIdentity", { [forbidden]: "x" }), "schema");
  }
  await expectCode(pipe.call("executeTool"), "unknown_method");
  assert.equal(state.messages.length, 0);
});

test("a reply for another request_id is skipped, not answered", windows, async (t) => {
  const { name, listening } = startBroker(t, {
    onMessage: (message, send) => {
      send({ request_id: randomUUID(), method: message.method, result: "accepted", data: { wrong: true } });
      send({ request_id: message.request_id, method: message.method, result: "accepted", data: { right: true } });
    },
  });
  await listening;
  const pipe = await BrokerPipe.connect(name);
  t.after(() => pipe.close());
  assert.deepEqual(await pipe.call("getDeviceIdentity"), { data: { right: true } });
});

test("a vanished server wakes the parked call with pipe_closed, not a fabricated frame", windows, async (t) => {
  const { name, state, listening } = startBroker(t, { onMessage: () => {} });
  await listening;
  const pipe = await BrokerPipe.connect(name);
  const pending = pipe.call("getDeviceIdentity");
  await delay(20);
  for (const socket of state.sockets) socket.destroy();
  await expectCode(pending, "pipe_closed");
  await expectCode(pipe.call("getDeviceIdentity"), "pipe_closed");
});

test("a silent server times out the call without killing the client", windows, async (t) => {
  const { name, listening } = startBroker(t, { onMessage: () => {} });
  await listening;
  const pipe = await BrokerPipe.connect(name);
  t.after(() => pipe.close());
  await expectCode(pipe.call("getDeviceIdentity", {}, 100), "pipe_timeout");
});

test("the attach retries until the single-instance pipe listens", windows, async (t) => {
  const name = `\\\\.\\pipe\\work-pipe-test-${randomUUID()}`;
  const server = net.createServer((socket) => {
    socket.write(frame({ nonce: "n", protocol_major: PROTOCOL_MAJOR }));
    socket.on("data", () => {});
    socket.on("error", () => {});
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  setTimeout(() => server.listen(name), 80);
  const pipe = await BrokerPipe.connect(name, 3000);
  pipe.close();
});

test("a connect budget that expires refuses with pipe_unavailable", windows, async () => {
  await expectCode(BrokerPipe.connect(`\\\\.\\pipe\\work-pipe-absent-${randomUUID()}`, 150), "pipe_unavailable");
});

test("frames are 4-byte big-endian and capped at 64KiB", () => {
  const payload = Buffer.from("hello");
  const encoded = encodeFrame(payload);
  assert.equal(encoded.readUInt32BE(0), 5);
  assert.deepEqual(encoded.subarray(4), payload);
  assert.throws(() => encodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1)), (error) => error instanceof BrokerPipeError && error.code === "frame_oversize");
});

test("an oversized inbound frame fails the connection", windows, async (t) => {
  const { name, state, listening } = startBroker(t, {
    onMessage: (message, send, socket) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
      socket.write(header);
    },
  });
  await listening;
  const pipe = await BrokerPipe.connect(name);
  await expectCode(pipe.call("getDeviceIdentity"), "frame_oversize");
});