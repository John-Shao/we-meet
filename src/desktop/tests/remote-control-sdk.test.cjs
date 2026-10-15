// Exercise the installed browser ESM SDK's real protobuf decoder and Room
// callback. No connect(), SFU, PeerConnection, native helper or input injection.
const assert = require("node:assert/strict");
const { randomUUID, webcrypto } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { Kind, signInput } = require("../dist/remote-control/wire.js");

const frontend = path.resolve(__dirname, "../../frontend");
const sdkRoot = path.join(frontend, "node_modules/livekit-client");
const sdkPackage = JSON.parse(
  readFileSync(path.join(sdkRoot, "package.json"), "utf8"),
);
const lock = JSON.parse(
  readFileSync(path.join(frontend, "package-lock.json"), "utf8"),
);
const sdk = import(pathToFileURL(path.join(sdkRoot, sdkPackage.module)).href);
// Resolve the protobuf codec from the SDK's own locked dependency tree.
const sdkRequire = createRequire(path.join(sdkRoot, "package.json"));
const { DataPacket, UserPacket } = sdkRequire("@livekit/protocol");
const inputTopic = "we-meet.remote-control.v1.input";
const signalTopic = "we-meet.remote-control.v1.signal";

async function fixture(t) {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Network is forbidden in the SDK contract test");
  });
  t.mock.method(globalThis, "WebSocket", () => {
    throw new Error("WebSocket is forbidden in the SDK contract test");
  });
  const {
    Room,
    RoomEvent,
    RemoteParticipant,
    DataPacket_Kind,
    Encryption_Type,
  } = await sdk;
  const room = new Room();
  t.after(async () => {
    await room.engine.close();
    room.engine.removeAllListeners();
    room.removeAllListeners();
  });
  const participant = new RemoteParticipant(room.engine.client, "PA_A", "A");
  room.remoteParticipants.set("A", participant);
  const received = [];
  room.on(RoomEvent.DataReceived, (...args) => received.push(args));
  // This internal entry point intentionally pins the installed SDK contract.
  // Fail on upgrades instead of silently substituting a hand-written decoder.
  assert.equal(typeof room.engine.handleDataMessage, "function");
  const packet = ({
    sequence = 1,
    sid = "PA_A",
    identity = "A",
    topic = inputTopic,
    payload = new Uint8Array([1]),
  } = {}) => {
    const bytes = new DataPacket({
      kind: DataPacket_Kind.RELIABLE,
      participantSid: sid,
      participantIdentity: identity,
      sequence,
      value: {
        case: "user",
        value: new UserPacket({ payload, topic, destinationIdentities: ["B"] }),
      },
    }).toBinary();
    return Uint8Array.from(bytes).buffer;
  };
  const receive = (options) =>
    room.engine.handleDataMessage({ data: packet(options) });
  return {
    room,
    participant,
    received,
    packet,
    receive,
    DataPacket_Kind,
    Encryption_Type,
  };
}

test("SDK contract is pinned to the application and lockfile versions", async () => {
  const application = JSON.parse(
    readFileSync(path.join(frontend, "package.json"), "utf8"),
  );
  assert.equal(application.dependencies["livekit-client"], "2.17.1");
  assert.equal(sdkPackage.version, "2.17.1");
  assert.equal((await sdk).version, "2.17.1");
  assert.equal(
    lock.packages["node_modules/livekit-client"].version,
    sdkPackage.version,
  );
  assert.equal(sdkPackage.dependencies["@livekit/protocol"], "1.44.0");
  assert.equal(
    lock.packages["node_modules/@livekit/protocol"].version,
    "1.44.0",
  );
});

test("SDK removes duplicate and older sequence numbers before the application callback", async (t) => {
  const f = await fixture(t);
  for (const sequence of [10, 10, 9, 11]) {
    await f.receive({ sequence, payload: new Uint8Array([sequence]) });
  }
  assert.deepEqual(
    f.received.map(([payload]) => [...payload]),
    [[10], [11]],
  );
  const args = f.received[0];
  assert.equal(
    args.length,
    5,
    "DataReceived does not expose the packet destination",
  );
  assert.equal(args[1], f.participant);
  assert.equal(args[2], f.DataPacket_Kind.RELIABLE);
  assert.equal(args[3], inputTopic);
  assert.equal(args[4], f.Encryption_Type.NONE);
});

test("SDK sequence state is shared across topics but independent for different participant SIDs", async (t) => {
  const f = await fixture(t);
  await f.receive({ sequence: 7 });
  await f.receive({ sequence: 7, topic: signalTopic });
  await f.receive({ sequence: 8, topic: signalTopic });
  await f.receive({ sequence: 1, sid: "PA_C", identity: "C" });
  assert.deepEqual(
    f.received.map(([, participant, , topic]) => [participant?.sid, topic]),
    [
      ["PA_A", inputTopic],
      ["PA_A", signalTopic],
      [undefined, inputTopic],
    ],
  );
  // No fabricated participant context: the application must reject C here.
  assert.equal(f.room.remoteParticipants.has("C"), false);
});

test("zero SDK sequence and missing SID bypass SDK deduplication and need application validation", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) await f.receive({ sequence: 0 });
  for (let i = 0; i < 2; i++)
    await f.receive({ sequence: 10, sid: "", identity: "" });
  assert.equal(f.received.length, 4);
  assert.equal(f.received[2][1], undefined);
  assert.equal(f.received[3][1], undefined);
});

test("SDK receive history expires and is not a durable application replay barrier", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t);
  await f.receive({ sequence: 99 });
  now += 29_000;
  await f.receive({ sequence: 99 });
  assert.equal(f.received.length, 1);
  now += 2_000;
  await f.receive({ sequence: 99 });
  assert.equal(f.received.length, 2);
});

test("a delayed Blob decode cannot reorder a following ArrayBuffer message", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  const first = new Blob([
    f.packet({ sequence: 1, payload: new Uint8Array([1]) }),
  ]);
  const originalRead = first.arrayBuffer.bind(first);
  first.arrayBuffer = async () => {
    entered();
    await delayed;
    return originalRead();
  };
  const processingFirst = f.room.engine.handleDataMessage({ data: first });
  await waiting;
  const processingSecond = f.receive({
    sequence: 2,
    payload: new Uint8Array([2]),
  });
  try {
    await Promise.resolve();
    assert.equal(f.received.length, 0);
  } finally {
    release();
  }
  await Promise.all([processingFirst, processingSecond]);
  assert.deepEqual(
    f.received.map(([payload]) => [...payload]),
    [[1], [2]],
  );
});

test("valid signed application inputs 1 and 3 pass through consecutive SDK sequences without gap repair", async (t) => {
  const f = await fixture(t);
  const keys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const binding = {
    sessionId: randomUUID(),
    shareInstanceId: randomUUID(),
    inputGeneration: randomUUID(),
    epoch: 1,
    challenge: "12".repeat(16),
    kind: Kind.Key,
    action: 1,
    code: 0x1d,
  };
  const inputs = await Promise.all(
    [1, 3].map((seq) => signInput({ ...binding, seq }, keys.privateKey)),
  );
  await f.receive({ sequence: 40, payload: inputs[0] });
  await f.receive({ sequence: 41, payload: inputs[1] });
  // A new SDK sequence can carry an application replay too; SDK does not
  // inspect the signed remote-control envelope or enforce its own input seq.
  await f.receive({ sequence: 42, payload: inputs[0] });
  assert.equal(f.received.length, 3);
  assert.deepEqual(
    f.received.map(([payload]) =>
      new DataView(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength,
      ).getBigUint64(64, true),
    ),
    [1n, 3n, 1n],
  );
  for (const [payload] of f.received) {
    assert.equal(payload.length, 704);
    assert.equal(
      await webcrypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        keys.publicKey,
        payload.slice(640),
        payload.slice(0, 640),
      ),
      true,
    );
  }
  assert.deepEqual(f.received[0][0], inputs[0]);
  assert.deepEqual(f.received[1][0], inputs[1]);
});
