import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPolicies,
  assertToolAllowed,
  assertSourceLabel,
  detectSecrets,
  assertNoSecrets,
  assertRequestBound,
  assertFallbackAllowed,
  filterModelOutput,
  assertSandboxProfile,
  assertNoContentLogging,
  validateUsage,
  createFauxModel,
} from './evaluator.mjs';

const { manifest, egress, sandbox } = loadPolicies();

test('tool manifest allows exactly the three R0a tools', () => {
  assert.deepEqual(
    manifest.tools.map((tool) => tool.id),
    ['model_call', 'read_builtin_template', 'write_artifact_draft'],
  );
  assert.equal(assertToolAllowed(manifest, 'model_call').consumesQuota, true);
  assert.equal(assertToolAllowed(manifest, 'read_builtin_template').consumesQuota, false);
  assert.equal(assertToolAllowed(manifest, 'write_artifact_draft').network, 'none');
  for (const denied of ['shell', 'filesystem', 'network', 'browser', 'connector', 'code_exec', 'unknown_tool']) {
    assert.throws(
      () => assertToolAllowed(manifest, denied),
      (error) => error.code === 'tool_not_allowed',
      denied,
    );
  }
});

test('R0a allows only user input and system template labels', () => {
  assert.equal(assertSourceLabel(egress, 'user_input'), true);
  assert.equal(assertSourceLabel(egress, 'system_template'), true);
  for (const label of ['external_content', 'connector_content', 'tool_result', 'unknown']) {
    assert.throws(
      () => assertSourceLabel(egress, label),
      (error) => error.code === 'source_label_unavailable',
      label,
    );
  }
});

test('secret patterns block before egress and do not echo the secret', () => {
  const fakeOpenAiKey = `sk-${'A'.repeat(24)}`;
  const fakeAwsKey = `AKIA${'B'.repeat(16)}`;
  const fakePrivateKey = '-----BEGIN PRIVATE KEY-----';
  const fakeBearer = `Bearer ${'c'.repeat(24)}`;

  for (const value of [fakeOpenAiKey, fakeAwsKey, fakePrivateKey, fakeBearer]) {
    assert.ok(detectSecrets(egress, value).length > 0);
    assert.throws(
      () => assertNoSecrets(egress, value),
      (error) => error.code === 'secret_detected' && !error.message.includes(value),
    );
  }
  assert.doesNotThrow(() => assertNoSecrets(egress, '会员改版方案：先做访谈，再出初稿。'));
});

test('request binding requires operation, attempt, fence and hash', () => {
  const operation = {
    id: 'op-1',
    state: 'dispatching',
    dispatchAttemptId: 'attempt-1',
    fence: 2,
    requestHash: 'sha256:req-1',
  };
  const request = {
    operationId: 'op-1',
    dispatchAttemptId: 'attempt-1',
    fence: 2,
    requestHash: 'sha256:req-1',
  };
  assert.equal(assertRequestBound(egress, request, operation), true);
  assert.throws(
    () => assertRequestBound(egress, { ...request, fence: 1 }, operation),
    (error) => error.code === 'request_binding_mismatch',
  );
  assert.throws(
    () => assertRequestBound(egress, { ...request, requestHash: 'sha256:other' }, operation),
    (error) => error.code === 'request_binding_mismatch',
  );
  assert.throws(
    () => assertRequestBound(egress, request, { ...operation, state: 'authorized' }),
    (error) => error.code === 'request_binding_mismatch',
  );
});

test('fallback is allowed before dispatch only', () => {
  assert.equal(assertFallbackAllowed(egress, 'pre_dispatch'), true);
  for (const phase of ['post_dispatch', 'unknown']) {
    assert.throws(
      () => assertFallbackAllowed(egress, phase),
      (error) => error.code === 'egress_policy_denied',
      phase,
    );
  }
});

test('response filter exposes public content only', () => {
  const filtered = filterModelOutput(egress, {
    content: '# 方案\n\n正文',
    reasoning: 'raw chain of thought',
    toolCalls: [{ name: 'shell' }],
  });
  assert.equal(filtered.content, '# 方案\n\n正文');
  assert.equal(filtered.droppedReasoning, true);
  assert.equal(filtered.droppedToolCalls, true);
  assert.ok(!filtered.content.includes('chain of thought'));

  assert.throws(
    () => filterModelOutput(egress, { reasoning: 'no public content' }),
    (error) => error.code === 'provider_unknown',
  );
  assert.throws(
    () => filterModelOutput(egress, { content: 'x'.repeat(262145) }),
    (error) => error.code === 'content_too_large',
  );
});

test('sandbox profile enforces gVisor, read-only, no host mounts and egress-only network', () => {
  assert.equal(assertSandboxProfile(sandbox), true);

  const writableRoot = structuredClone(sandbox);
  writableRoot.filesystem.readOnlyRootFilesystem = false;
  assert.throws(
    () => assertSandboxProfile(writableRoot),
    (error) => error.code === 'sandbox_violation' && error.message.includes('rootfs'),
  );

  const hostMount = structuredClone(sandbox);
  hostMount.filesystem.hostMounts = 1;
  assert.throws(() => assertSandboxProfile(hostMount), (error) => error.code === 'sandbox_violation');

  const internet = structuredClone(sandbox);
  internet.network.egress.allowInternet = true;
  assert.throws(() => assertSandboxProfile(internet), (error) => error.code === 'sandbox_violation');

  assert.equal(sandbox.reducedProfile.claim, 'no_sandbox_proof');
  assert.deepEqual(sandbox.reducedProfile.allowedTools, ['model_call']);
});

test('content and credential logging must stay disabled', () => {
  assert.equal(assertNoContentLogging(egress), true);
  const logContent = structuredClone(egress);
  logContent.logging.logContent = true;
  assert.throws(() => assertNoContentLogging(logContent), (error) => error.code === 'egress_policy_denied');

  const notHashesOnly = structuredClone(egress);
  notHashesOnly.logging.logHashesOnly = false;
  assert.throws(
    () => assertNoContentLogging(notHashesOnly),
    (error) => error.code === 'egress_policy_denied',
  );
});

test('usage requires non-negative token integers', () => {
  assert.equal(validateUsage({ inputTokens: 10, outputTokens: 20 }), true);
  assert.throws(
    () => validateUsage({ inputTokens: -1, outputTokens: 20 }),
    (error) => error.code === 'usage_invalid',
  );
  assert.throws(
    () => validateUsage({ inputTokens: 10, outputTokens: 1.5 }),
    (error) => error.code === 'usage_invalid',
  );
});

test('faux model is deterministic and never needs network', async () => {
  const model = createFauxModel({ content: '# Same content\n', usage: { inputTokens: 5, outputTokens: 7 } });
  const request = { requestHash: 'sha256:req-1' };
  const first = await model(request);
  const second = await model(request);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.contentRef, second.contentRef);
  assert.deepEqual(first.usage, { inputTokens: 5, outputTokens: 7 });
  assert.equal(first.providerRequestId, 'faux-provider-request-1');
  assert.equal(model.calls(), 2);
  await assert.rejects(() => model({}), (error) => error.code === 'request_binding_mismatch');
});
