/**
 * R0a design-time policy evaluator.
 *
 * This is not a production gateway. It validates the policy assets that the
 * implementation must enforce: tool allowlist, source labels, secret blocking,
 * request binding, fallback rules, response filtering, sandbox invariants,
 * no-content logging and usage validation.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PolicyError(code, message);
}

function readJson(name) {
  return JSON.parse(readFileSync(join(here, name), 'utf8'));
}

export function loadPolicies() {
  return {
    manifest: readJson('tool-manifest.json'),
    egress: readJson('egress-policy.json'),
    sandbox: readJson('sandbox-profile.json'),
  };
}

export function assertToolAllowed(manifest, toolId) {
  if (manifest.denied.includes(toolId)) {
    fail('tool_not_allowed', `tool is explicitly denied: ${toolId}`);
  }
  const tool = manifest.tools.find((item) => item.id === toolId);
  if (!tool && manifest.rejectUnknownTools) {
    fail('tool_not_allowed', `unknown tool: ${toolId}`);
  }
  return tool;
}

export function assertSourceLabel(egress, label) {
  if (egress.sourceLabels.allowed.includes(label)) return true;
  fail('source_label_unavailable', `source label is not allowed in R0a: ${label}`);
}

export function detectSecrets(egress, text) {
  const matched = [];
  for (const pattern of egress.secretDetection.patterns) {
    const regex = new RegExp(pattern, 'g');
    if (regex.test(text)) matched.push(pattern);
  }
  return matched;
}

/**
 * Never include the matched secret (or the scanned text) in the error message.
 */
export function assertNoSecrets(egress, text) {
  const matched = detectSecrets(egress, text);
  if (matched.length > 0) {
    fail('secret_detected', `secret patterns matched: ${matched.length}`);
  }
  return true;
}

export function assertRequestBound(egress, request, operation) {
  const binding = egress.requestBinding;
  if (binding.requireDispatchingState && operation.state !== 'dispatching') {
    fail('request_binding_mismatch', 'operation is not dispatching');
  }
  if (binding.requireOperationId && request.operationId !== operation.id) {
    fail('request_binding_mismatch', 'operation id mismatch');
  }
  if (binding.requireDispatchAttemptId && request.dispatchAttemptId !== operation.dispatchAttemptId) {
    fail('request_binding_mismatch', 'dispatch attempt mismatch');
  }
  if (binding.requireFence && request.fence !== operation.fence) {
    fail('request_binding_mismatch', 'fence mismatch');
  }
  if (binding.requireRequestHash && request.requestHash !== operation.requestHash) {
    fail('request_binding_mismatch', 'request hash mismatch');
  }
  if (binding.requirePriceVersion && request.priceVersion !== egress.providers.primary.priceVersion) {
    fail('request_binding_mismatch', 'price version mismatch');
  }
  return true;
}

export function assertFallbackAllowed(egress, phase) {
  const policy = egress.fallbackPolicy;
  if (phase === 'pre_dispatch' && policy.allowedBeforeDispatch) return true;
  if (phase === 'post_dispatch' && policy.allowedAfterDispatch) return true;
  if (phase === 'unknown' && policy.allowedAfterUnknown) return true;
  fail('egress_policy_denied', `fallback is not allowed at phase: ${phase}`);
}

export function filterModelOutput(egress, raw) {
  if (!raw || typeof raw.content !== 'string') {
    fail('provider_unknown', 'provider response has no public content');
  }
  const bytes = Buffer.byteLength(raw.content, 'utf8');
  if (bytes > egress.responseFiltering.maxOutputBytes) {
    fail('content_too_large', 'model output exceeds the R0a limit');
  }
  return {
    content: raw.content,
    bytes,
    droppedReasoning: Boolean(raw.reasoning),
    droppedToolCalls: Array.isArray(raw.toolCalls) && raw.toolCalls.length > 0,
  };
}

export function assertSandboxProfile(sandbox) {
  const violations = [];
  if (sandbox.runtimeClass !== 'gvisor' || sandbox.sandboxProof !== true) {
    violations.push('gvisor profile/proof missing');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(sandbox.image.digest)) violations.push('image digest not pinned');
  if (sandbox.image.node !== '24') violations.push('node version not 24');
  if (!sandbox.image.piVersion) violations.push('pi version missing');
  if (sandbox.image.immutable !== true) violations.push('image not immutable');
  if (sandbox.image.packageInstall !== false) violations.push('runtime package install enabled');
  if (sandbox.image.userExtensions !== false) violations.push('user extensions enabled');
  if (sandbox.identity.runAsNonRoot !== true) violations.push('runtime is root');
  if (sandbox.identity.allowPrivilegeEscalation !== false) violations.push('privilege escalation allowed');
  if (!sandbox.identity.capabilitiesDrop.includes('ALL')) violations.push('capabilities not dropped');
  if (sandbox.filesystem.readOnlyRootFilesystem !== true) violations.push('rootfs is writable');
  if (sandbox.filesystem.hostMounts !== 0 || sandbox.filesystem.hostPaths.length > 0) {
    violations.push('host filesystem exposed');
  }
  if (sandbox.network.ingress !== false || sandbox.network.hostNetwork !== false) {
    violations.push('network ingress/host network enabled');
  }
  if (
    sandbox.network.egress.mode !== 'gateway_only' ||
    sandbox.network.egress.allowInternet !== false ||
    sandbox.network.egress.allowMetadata !== false ||
    sandbox.network.egress.allowLoopback !== false ||
    sandbox.network.egress.allowPrivate !== false
  ) {
    violations.push('egress is not gateway-only');
  }
  if (sandbox.secrets.providerKeys !== false || sandbox.secrets.databaseCredentials !== false) {
    violations.push('long-term credentials exposed to runtime');
  }
  if (sandbox.secrets.kmsMounts.length > 0) violations.push('KMS mounted into runtime');
  if (sandbox.content.hostPaths.length > 0) violations.push('content uses host paths');
  if (sandbox.reducedProfile.claim !== 'no_sandbox_proof') violations.push('reduced profile overclaims sandbox');
  if (sandbox.reducedProfile.allowedTools.length !== 1 || sandbox.reducedProfile.allowedTools[0] !== 'model_call') {
    violations.push('reduced profile exposes extra tools');
  }
  if (violations.length > 0) {
    fail('sandbox_violation', violations.join('; '));
  }
  return true;
}

export function assertNoContentLogging(egress) {
  const logging = egress.logging;
  if (logging.logContent || logging.logPrompt || logging.logResponse || logging.logProviderKey) {
    fail('egress_policy_denied', 'content or credential logging enabled');
  }
  if (logging.logHashesOnly !== true) {
    fail('egress_policy_denied', 'logging must be hash/metadata only');
  }
  return true;
}

export function validateUsage(egress, usage, priceVersion) {
  if (priceVersion !== egress.providers.primary.priceVersion) {
    fail('usage_invalid', 'price version does not match the primary provider');
  }
  if (
    !Number.isInteger(usage.inputTokens) ||
    !Number.isInteger(usage.outputTokens) ||
    usage.inputTokens < 0 ||
    usage.outputTokens < 0
  ) {
    fail('usage_invalid', 'token usage must be non-negative integers');
  }
  if (usage.cachedInputTokens !== undefined && (!Number.isInteger(usage.cachedInputTokens) || usage.cachedInputTokens < 0)) {
    fail('usage_invalid', 'cached input tokens must be a non-negative integer');
  }
  return true;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Deterministic faux model for design tests. It never performs network I/O.
 */
export function createFauxModel({
  content = '# Faux R0a artifact\n',
  usage = { inputTokens: 20, outputTokens: 40 },
  providerRequestId = 'faux-provider-request-1',
} = {}) {
  const bytes = Buffer.byteLength(content, 'utf8');
  const contentHash = `sha256:${sha256(content)}`;
  let calls = 0;
  async function modelCall(request) {
    if (!request || !request.requestHash) {
      fail('request_binding_mismatch', 'faux model requires requestHash');
    }
    calls += 1;
    return {
      contentRef: `content://faux/${contentHash.slice(7, 23)}`,
      contentHash,
      bytes,
      mediaType: 'text/markdown',
      providerRequestId,
      usage: { ...usage },
      finishReason: 'stop',
    };
  }
  modelCall.calls = () => calls;
  return modelCall;
}
