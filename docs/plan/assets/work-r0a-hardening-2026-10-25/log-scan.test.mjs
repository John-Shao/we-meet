import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPaths, scanText } from './log-scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('detects API keys and never echoes the full value', () => {
  const fakeKey = `sk-${'A1b2C3d4E5f6G7h8'.repeat(2)}`;
  const result = scanText(`provider call failed key=${fakeKey}`, {
    source: 'unit.log',
  });
  assert.equal(result.failed, true);
  assert.equal(result.byRule['secret.openai_like'], 1);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(fakeKey));
  assert.ok(serialized.includes('…'));
});

test('detects environment assignments, bearer tokens and private keys', () => {
  const text = [
    'DASHSCOPE_API_KEY=abcdef1234567890',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    '-----BEGIN PRIVATE KEY-----',
  ].join('\n');
  const result = scanText(text);
  assert.equal(result.byRule['secret.env_assignment'], 1);
  assert.equal(result.byRule['secret.bearer'], 1);
  assert.equal(result.byRule['secret.private_key'], 1);
});

test('detects project-scoped OpenAI, Anthropic, GitHub and Aliyun credentials', () => {
  const samples = {
    'secret.openai_like': `sk-proj-${'Ab3dEf6hIj9kLm2n'.repeat(3)}`,
    'secret.anthropic_like': `sk-ant-api03-${'Zx8cVb7nMq6wEr5t'.repeat(2)}`,
    'secret.github_token': [`ghp_${'a1B2c3D4e5'.repeat(4)}`, `github_pat_${'11AbCdEfGh'.repeat(3)}_xyz`],
    'secret.aliyun_access_key': `LTAI5t${'Qw8Er7Ty6Ui5'.repeat(1)}Op`,
  };
  for (const [rule, value] of Object.entries(samples)) {
    for (const secret of [value].flat()) {
      const result = scanText(`upstream error token=${secret}`);
      assert.equal(result.failed, true, rule);
      assert.ok(result.byRule[rule] >= 1, `${rule} should match`);
      assert.ok(!JSON.stringify(result).includes(secret), `${rule} must stay redacted`);
    }
  }
});

test('synthetic canary detects prompt or artifact content in logs', () => {
  const canary = 'CANARY-8f2c-46b1-9e77';
  const result = scanText(`run started goal=${canary}`, {
    canaries: [canary],
  });
  assert.equal(result.failed, true);
  assert.ok(result.findings.some((finding) => finding.rule === 'content.canary'));
  assert.ok(!JSON.stringify(result).includes(canary));
});

test('clean provider evidence log has no fail findings', () => {
  const result = scanPaths([path.join(HERE, 'provider-smoke.log')]);
  assert.equal(result.bySeverity.fail, 0);
  assert.equal(result.failed, false);
});

test('email is a warning unless strict mode is requested', () => {
  const text = 'support contact alice@example.com';
  const normal = scanText(text);
  assert.equal(normal.bySeverity.warn, 1);
  assert.equal(normal.failed, false);

  const strict = scanText(text, { failOnWarning: true });
  assert.equal(strict.failed, true);
});

test('directory scan is recursive and stays redacted in the report', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-log-scan-'));
  try {
    fs.mkdirSync(path.join(directory, 'nested'));
    fs.writeFileSync(
      path.join(directory, 'nested', 'runtime.log'),
      'session we_meet_session=super-secret-cookie\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(directory, 'ignore.bin'),
      'sk-shouldnotbescanned000000',
      'utf8',
    );
    const result = scanPaths([directory]);
    assert.equal(result.files, 1);
    assert.equal(result.byRule['auth.session_cookie'], 1);
    assert.ok(!JSON.stringify(result).includes('super-secret-cookie'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('current R0a evidence logs contain no secret or content leaks', () => {
  const sliceDir = path.join(HERE, '..', 'work-temporal-slice-2026-10-25');
  const evidenceFiles = fs
    .readdirSync(sliceDir)
    .filter((file) => file.endsWith('.log'))
    .map((file) => path.join(sliceDir, file));
  const result = scanPaths([
    path.join(HERE, 'provider-smoke.log'),
    path.join(HERE, 'sandbox-smoke.log'),
    ...evidenceFiles,
  ]);
  assert.equal(result.bySeverity.fail, 0, JSON.stringify(result.findings, null, 2));
  assert.equal(result.failed, false);
});
