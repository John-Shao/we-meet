const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DeviceStore, parseDeviceRecord } = require("../dist/work/store.js");

const binding = { issuer: "https://id.example.test/realms/meet", clientId: "desktop", serviceOrigin: "https://meet.example.test", subject: "subject-1" };
const record = () => ({
  ...binding,
  orgId: "org-1",
  deviceId: "abcdefab-abcd-abcd-abcd-abcdefabcdef",
  container: "work-device-" + "a".repeat(40),
  certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
  certSerial: "12345678901234567890",
  certNotAfter: "2026-11-19T00:00:00Z",
  journalEpoch: "12345678-1234-1234-1234-123456789012",
});
const memoryIo = () => {
  const state = { value: undefined, writes: 0, clears: 0 };
  return {
    state,
    read: () => state.value,
    write: (value) => { state.value = value; state.writes++; },
    clear: () => { state.value = undefined; state.clears++; },
  };
};

test("a bound record round-trips through save and load", () => {
  const io = memoryIo();
  const store = new DeviceStore(io, binding);
  const value = record();
  store.save(value);
  assert.deepEqual(store.load(), value);
  assert.equal(io.state.writes, 1);
  store.clear();
  assert.equal(store.load(), undefined);
  assert.equal(io.state.clears, 1);
});

test("a record of another account or service reads as absent, never as a device", () => {
  for (const key of ["issuer", "clientId", "serviceOrigin", "subject"]) {
    const io = memoryIo();
    const other = record();
    other[key] = "someone-else";
    io.write(JSON.stringify(other));
    assert.equal(new DeviceStore(io, binding).load(), undefined, key);
  }
});

test("the record key set is closed and every member is a non-empty string", () => {
  const extra = { ...record(), token: "never-persist-tokens" };
  assert.equal(parseDeviceRecord(JSON.stringify(extra)), undefined);
  for (const key of Object.keys(record())) {
    const missing = record();
    delete missing[key];
    assert.equal(parseDeviceRecord(JSON.stringify(missing)), undefined, `without ${key}`);
    for (const bad of [42, null, ""]) {
      const mistyped = { ...record(), [key]: bad };
      assert.equal(parseDeviceRecord(JSON.stringify(mistyped)), undefined, `${key}=${JSON.stringify(bad)}`);
    }
  }
});

test("identifiers, serial, PEM marker and expiry are shape-checked", () => {
  for (const [key, bad] of [
    ["deviceId", "not-a-uuid"],
    ["journalEpoch", "not-a-uuid"],
    ["certSerial", "0123"],
    ["certSerial", "12x"],
    ["certSerial", "1".repeat(40)],
    ["certificatePem", "no marker here"],
    ["certNotAfter", "not-a-date"],
  ]) {
    assert.equal(parseDeviceRecord(JSON.stringify({ ...record(), [key]: bad })), undefined, `${key}=${bad}`);
  }
  assert.equal(parseDeviceRecord(undefined), undefined);
  assert.equal(parseDeviceRecord(""), undefined);
  assert.equal(parseDeviceRecord("{broken"), undefined);
  assert.equal(parseDeviceRecord("[1,2]"), undefined);
  assert.equal(parseDeviceRecord("null"), undefined);
});