import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateAdvanceRequest } from '../src/server.mjs';

const fixturePath = fileURLToPath(
  new URL('../../contracts/advance-request.execute.json', import.meta.url)
);

const loadFixture = () => JSON.parse(readFileSync(fixturePath, 'utf8'));

test('the Go-produced execute fragment passes the Node wire validator', () => {
  const request = loadFixture();
  const canonical = validateAdvanceRequest(request);
  assert.equal(canonical.kind, 'advance_request');
  assert.equal(canonical.contractVersion, 'work-runtime-fragment-v1');
  assert.equal(canonical.executionId, request.executionId);
  assert.equal(canonical.mode, 'execute');
  assert.deepEqual(canonical.permit, request.permit);
});

test('the same fragment is rejected when a field is renamed on one side', () => {
  const request = loadFixture();
  request.permit = {
    operationId: request.permit.operationId,
    dispatchAttemptId: request.permit.dispatchAttemptId,
    request_hash: request.permit.requestHash
  };
  assert.throws(() => validateAdvanceRequest(request));
});

test('the fixture is rejected when a reference id stops being a uuid', () => {
  const request = loadFixture();
  request.checkpoint.refId = 'not-a-uuid';
  assert.throws(() => validateAdvanceRequest(request));
});
