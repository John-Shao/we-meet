import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TOLERANCE,
  normalizeUsage,
  reconcilePeriod,
  settleOperation,
  upperBoundCents,
  validatePriceTable,
} from './usage/usage-reconcile.mjs';
import { evaluateRelease } from './supply-chain/supply-chain.mjs';

const price = JSON.parse(fs.readFileSync(new URL('./usage/price-table.placeholder.json', import.meta.url)));
const operation = { price_version: price.price_version, provider: price.provider, model: price.model };
const policy = JSON.parse(fs.readFileSync(new URL('./supply-chain/supply-chain-policy.json', import.meta.url)));

// Usage shape observed in the real qwen3.8-flash smoke (provider-smoke.log).
const qwenUsage = {
  prompt_tokens: 80,
  completion_tokens: 110,
  total_tokens: 190,
  completion_tokens_details: { reasoning_tokens: 77, text_tokens: 110 },
};

test('price table is validated and placeholder is explicit', () => {
  assert.equal(price.placeholder, true);
  assert.doesNotThrow(() => validatePriceTable(price));
  assert.throws(() => validatePriceTable({ ...price, currency: 'cny' }), /currency/);
  assert.throws(
    () => validatePriceTable({ ...price, per_million_cents: { ...price.per_million_cents, output: 1.5 } }),
    /output/,
  );
});

test('reasoning tokens are not double-charged unless the price table says so', () => {
  assert.deepEqual(normalizeUsage(qwenUsage, price), { input: 80, cached_input: 0, output: 110 });
  assert.equal(
    normalizeUsage(qwenUsage, { ...price, reasoning_billed_separately: true }).output,
    187,
  );
  assert.equal(normalizeUsage({ total_tokens: 5 }, price), null);
});

test('preview upper bound covers the worst-case settlement', () => {
  const bound = upperBoundCents(price, { maxInputTokens: 8000 });
  const worst = settleOperation({
    reservedCents: bound,
    priceTable: price,
    operation,
    providerUsage: { prompt_tokens: 8000, completion_tokens: price.max_output_tokens },
  });
  assert.equal(worst.settleCents, bound);
  assert.equal(worst.overageCents, 0);
});

test('provider usage is the settlement basis; mismatch beyond tolerance is flagged', () => {
  const close = settleOperation({
    reservedCents: 100,
    priceTable: price,
    operation,
    providerUsage: qwenUsage,
    gatewayTokens: { input: 80, cached_input: 0, output: 140 },
  });
  assert.equal(close.basis, 'provider');
  assert.deepEqual(close.flags, []);
  assert.equal(close.usage.price_version, price.price_version);

  const far = settleOperation({
    reservedCents: 100,
    priceTable: price,
    operation,
    providerUsage: qwenUsage,
    gatewayTokens: { input: 80, cached_input: 0, output: 110 + TOLERANCE.operationTokenFloor + 1 },
  });
  assert.deepEqual(far.flags, ['usage_mismatch']);
});

test('missing provider usage settles on gateway estimate or holds as unknown', () => {
  const estimated = settleOperation({
    reservedCents: 100,
    priceTable: price,
    operation,
    providerUsage: null,
    gatewayTokens: { input: 1000, cached_input: 0, output: 1000 },
  });
  assert.equal(estimated.basis, 'gateway_estimate');
  assert.deepEqual(estimated.flags, ['usage_estimated']);

  const unknown = settleOperation({ reservedCents: 100, priceTable: price, operation, providerUsage: null });
  assert.equal(unknown.action, 'hold_unknown');
  assert.equal(unknown.settleCents, null);
});

test('overage is capped at the reservation and surfaced for adjust_budget', () => {
  const result = settleOperation({
    reservedCents: 1,
    priceTable: price,
    operation,
    providerUsage: { prompt_tokens: 100000, completion_tokens: 100000 },
  });
  assert.equal(result.settleCents, 1);
  assert.ok(result.overageCents > 0);
  assert.ok(result.flags.includes('budget_overrun'));
  assert.throws(
    () => settleOperation({ reservedCents: -1, priceTable: price, operation, providerUsage: qwenUsage }),
    /reservedCents/,
  );
});

test('period reconciliation applies max(1%, 100 cents) tolerance and lists unmatched ids', () => {
  const ledger = [
    { provider_request_id: 'a', amount_cents: 5000 },
    { provider_request_id: 'b', amount_cents: 3000 },
  ];
  assert.equal(reconcilePeriod({ ledger, invoice: ledger }).status, 'matched');

  const small = reconcilePeriod({
    ledger,
    invoice: [
      { provider_request_id: 'a', amount_cents: 5050 },
      { provider_request_id: 'b', amount_cents: 3000 },
    ],
  });
  assert.equal(small.status, 'within_tolerance');
  assert.equal(small.allowedCents, 100);
  assert.equal(small.mismatched.length, 1);

  const big = reconcilePeriod({
    ledger,
    invoice: [...ledger, { provider_request_id: 'c', amount_cents: 400 }],
  });
  assert.equal(big.status, 'adjustment_required');
  assert.deepEqual(big.missingInLedger, ['c']);
  assert.equal(big.diffCents, 400);
});

test('gateway counts must be non-negative integers; bad counts never settle as zero', () => {
  for (const bad of [{ input: NaN, cached_input: 0, output: 1 }, { input: 1, cached_input: -1, output: 1 }, { input: 1.5, cached_input: 0, output: 1 }, { input: 1, output: 1 }]) {
    assert.throws(
      () => settleOperation({ reservedCents: 100, priceTable: price, operation, providerUsage: null, gatewayTokens: bad }),
      (error) => error.code === 'invalid_gateway_usage',
    );
  }
});

test('settlement refuses a price table that is not the operation\'s reserved price version/model', () => {
  for (const op of [
    { ...operation, price_version: 'qwen3.8-flash-2027-01' },
    { ...operation, model: 'qwen3.8-max' },
    { ...operation, provider: 'openai' },
    undefined,
  ]) {
    assert.throws(
      () => settleOperation({ reservedCents: 100, priceTable: price, operation: op, providerUsage: qwenUsage }),
      (error) => error.code === 'price_version_mismatch',
    );
  }
});

test('period reconciliation rejects duplicate ids and non-integer amounts', () => {
  assert.throws(
    () => reconcilePeriod({ ledger: [{ provider_request_id: 'a', amount_cents: 1 }, { provider_request_id: 'a', amount_cents: 2 }], invoice: [] }),
    (error) => error.code === 'invalid_reconciliation_input',
  );
  assert.throws(
    () => reconcilePeriod({ ledger: [], invoice: [{ provider_request_id: 'a', amount_cents: 1.25 }] }),
    (error) => error.code === 'invalid_reconciliation_input',
  );
});

function goodEvidence() {
  const digest = `sha256:${'ab'.repeat(32)}`;
  return {
    image: {
      digest,
      reference: `registry.example/work-r0a-runner@${digest}`,
      base: 'gcr.io/distroless/nodejs24-debian12',
    },
    signature: {
      verified: true,
      issuer: 'https://token.actions.githubusercontent.com',
      subject: 'https://github.com/we-meet/we-meet/.github/workflows/runner-image.yml@refs/heads/aliyun-dev',
      rekor_log_index: 123,
      digest,
    },
    provenance: {
      format: 'slsa-provenance-v1',
      slsa_build_level: 2,
      builder_id: 'https://github.com/actions/runner',
      subject_digest: digest,
    },
    sbom: {
      format: 'spdx-json',
      subject_digest: digest,
      lockfile_sha256: 'f'.repeat(64),
      components: [
        { name: '@mariozechner/pi-agent-core', version: '1.4.0', purl: 'pkg:npm/%40mariozechner/pi-agent-core@1.4.0' },
        { name: 'undici', version: '7.0.0', purl: 'pkg:npm/undici@7.0.0' },
      ],
    },
    vulnerabilities: { image_digest: digest, findings: [{ id: 'CVE-1', severity: 'medium' }], waivers: [] },
  };
}

test('signed, pinned, SBOM-complete release is admitted', () => {
  assert.deepEqual(evaluateRelease(policy, goodEvidence()), { admitted: true, errors: [] });
});

test('placeholder digest, tag reference and unverified signature are denied', () => {
  const evidence = goodEvidence();
  evidence.image.digest = `sha256:${'1'.repeat(64)}`;
  evidence.image.reference = 'registry.example/work-r0a-runner:latest';
  evidence.signature.verified = false;
  const codes = evaluateRelease(policy, evidence).errors.map((e) => e.code);
  assert.ok(codes.includes('image_digest_placeholder'));
  assert.ok(codes.includes('image_reference_not_pinned'));
  assert.ok(codes.includes('signature_unverified'));
  assert.ok(codes.includes('provenance_digest_mismatch'));
});

test('Pi version drift, package managers and missing lockfile are denied', () => {
  const evidence = goodEvidence();
  evidence.sbom.components[0].version = '1.5.0';
  evidence.sbom.components[0].purl = 'pkg:npm/%40mariozechner/pi-agent-core@1.5.0';
  evidence.sbom.components.push({ name: 'npm', version: '11.0.0', purl: 'pkg:npm/npm@11.0.0' });
  evidence.sbom.components.push({ name: 'x', version: '', purl: 'pkg:npm/x' });
  delete evidence.sbom.lockfile_sha256;
  const codes = evaluateRelease(policy, evidence).errors.map((e) => e.code);
  assert.deepEqual(
    codes.sort(),
    ['lockfile_missing', 'sbom_component_incomplete', 'sbom_forbidden_component', 'sbom_pin_mismatch'],
  );
});

test('critical vulns are never waivable; high needs an owned, unexpired, <=30d waiver', () => {
  const now = new Date('2026-10-26T00:00:00Z');
  const evidence = goodEvidence();
  evidence.vulnerabilities = {
    image_digest: evidence.image.digest,
    findings: [{ id: 'CVE-H', severity: 'high' }],
    waivers: [{ id: 'CVE-H', owner: 'runtime', reason: 'no fix', expires_at: '2026-11-10T00:00:00Z' }],
  };
  assert.equal(evaluateRelease(policy, evidence, { now }).admitted, true);

  evidence.vulnerabilities.waivers[0].expires_at = '2027-03-01T00:00:00Z';
  assert.deepEqual(evaluateRelease(policy, evidence, { now }).errors.map((e) => e.code), ['vuln_high']);

  evidence.vulnerabilities = {
    image_digest: evidence.image.digest,
    findings: [{ id: 'CVE-C', severity: 'critical' }],
    waivers: [{ id: 'CVE-C', owner: 'runtime', reason: 'x', expires_at: '2026-11-01T00:00:00Z' }],
  };
  assert.deepEqual(evaluateRelease(policy, evidence, { now }).errors.map((e) => e.code), ['vuln_critical']);
  delete evidence.vulnerabilities;
  assert.ok(evaluateRelease(policy, evidence, { now }).errors.some((e) => e.code === 'scan_missing'));
});

test('the D4 sandbox profile placeholder digest would be denied at admission', () => {
  const sandbox = JSON.parse(
    fs.readFileSync(new URL('./policy/sandbox-profile.json', import.meta.url)),
  );
  const evidence = goodEvidence();
  evidence.image.digest = sandbox.image.digest;
  const codes = evaluateRelease(policy, evidence).errors.map((e) => e.code);
  assert.ok(codes.includes('image_digest_placeholder'));
});

test('scanner severity is case-insensitive and unrated findings are not silently clean', () => {
  const evidence = goodEvidence();
  evidence.vulnerabilities.findings = [
    { id: 'CVE-UP', severity: 'Critical' },
    { id: 'CVE-HI', severity: 'HIGH' },
    { id: 'CVE-X', severity: 'severe' },
  ];
  const codes = evaluateRelease(policy, evidence).errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ['scan_severity_unknown', 'vuln_critical', 'vuln_high']);
});

test('a scan without a findings array is treated as missing, not clean', () => {
  const evidence = goodEvidence();
  evidence.vulnerabilities = { image_digest: evidence.image.digest, matches: [] };
  assert.deepEqual(
    evaluateRelease(policy, evidence).errors.map((e) => `${e.code}:${e.detail}`),
    ['scan_missing:findings_not_array'],
  );
});

test('SBOM, scan and reference must all describe the admitted digest', () => {
  const evidence = goodEvidence();
  const other = `sha256:${'cd'.repeat(32)}`;
  evidence.sbom.subject_digest = other;
  evidence.vulnerabilities.image_digest = other;
  evidence.image.reference = `registry.example/work-r0a-runner@${other}`;
  const codes = evaluateRelease(policy, evidence).errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ['image_reference_digest_mismatch', 'sbom_digest_mismatch', 'scan_digest_mismatch']);
  delete evidence.image.reference;
  assert.ok(evaluateRelease(policy, evidence).errors.some((e) => e.code === 'image_reference_not_pinned'));
});

test('corepack, apt/dpkg and mixed-case purls of package managers are denied; slim base is not allowlisted', () => {
  const evidence = goodEvidence();
  evidence.sbom.components.push(
    { name: 'corepack', version: '0.34.0', purl: 'pkg:npm/corepack@0.34.0' },
    { name: 'apt', version: '2.6.1', purl: 'pkg:deb/debian/apt@2.6.1?arch=amd64&distro=debian-12' },
    { name: 'NPM', version: '11.0.0', purl: 'pkg:npm/NPM@11.0.0' },
  );
  evidence.image.base = 'node:24-bookworm-slim';
  const result = evaluateRelease(policy, evidence);
  const forbidden = result.errors.find((e) => e.code === 'sbom_forbidden_component');
  assert.ok(forbidden.detail.includes('corepack') && forbidden.detail.includes('apt') && forbidden.detail.includes('NPM'));
  assert.ok(result.errors.some((e) => e.code === 'base_image_not_allowed'));
});
