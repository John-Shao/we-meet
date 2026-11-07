import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCanaryFile, scanPaths, scanText } from './log-scan.mjs';

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
  const logsOf = (directory) => fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.log'))
    .map((file) => path.join(directory, file));
  const result = scanPaths([
    path.join(HERE, 'provider-smoke.log'),
    path.join(HERE, 'sandbox-smoke.log'),
    ...logsOf(path.join(HERE, '..', 'work-temporal-slice-2026-10-25')),
    // 并发证据日志：下载令牌、租约与投影竞态的原始输出也在扫描范围内。
    ...logsOf(path.join(HERE, '..', 'work-r0a-design-2026-10-25')),
  ]);
  assert.ok(result.files >= 8, `expected the evidence logs to be scanned, got ${result.files}`);
  assert.equal(result.bySeverity.fail, 0, JSON.stringify(result.findings, null, 2));
  assert.equal(result.failed, false);
});

// Runtime verification needs real user content as the canary - a task title read
// out of the database is the only thing that proves the running services do not
// log what D5 forbids. Passing that through --canary would write it into argv,
// visible to `ps`, a shell history file and journald's exec record: the scanner
// exists to keep content out of logs, so it cannot put content into a process
// listing. This is the reason --canary-file exists rather than being a convenience.
test('canary file feeds the scan without putting content in argv', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-canary-'));
  const file = path.join(directory, 'canaries.txt');
  const title = '上线计划：第三季度复盘会议';
  fs.writeFileSync(file, `${title}\n\n   \nCANARY-9d41-77aa\n`, 'utf8');
  try {
    const canaries = readCanaryFile(file);
    assert.deepEqual(canaries, [title, 'CANARY-9d41-77aa']);

    const result = scanText(`task state=open title="${title}"`, { canaries });
    assert.equal(result.failed, true);
    assert.ok(
      result.findings.some((finding) => finding.rule === 'content.canary'),
      JSON.stringify(result.findings, null, 2)
    );
    // The report carries a redacted preview only.
    assert.ok(!JSON.stringify(result).includes(title));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a missing canary file is reported by path, never by content', () => {
  const target = path.join(os.tmpdir(), 'work-canary-missing', 'canaries.txt');
  assert.throws(
    () => readCanaryFile(target),
    (error) =>
      error.message.includes('cannot read canary file') &&
      error.message.includes('work-canary-missing')
  );
});

// #94 = G3: the drill evidence carries content:// locators, and the ruling is that a locator is
// not user content. Both directions are pinned so the narrowing cannot quietly become a blanket
// exemption: the locator passes, and the same fields carrying a body still fail.
test('a content:// reference URI is a locator, not user content', () => {
  const line = 'ready|0478f98c-a5d4-4b00-af77-29a91150255b|ref=content://work/4a2d3f28-38b9-4d6c-8614-70ef9a83960d/2f7a0e4e65a0a67693fe7?v=1';
  const result = scanText(line, { source: 'unit.log' });
  assert.equal(result.failed, false);
  assert.equal(result.byRule['content.field'] || 0, 0);
});

test('a quoted content:// locator stays a locator', () => {
  const result = scanText('usage={"receipt_ref": "content://work/org1/abc123def456ghi789?v=1"}', { source: 'unit.log' });
  assert.equal(result.failed, false);
});

test('body-shaped values in the same fields still fail after the narrowing', () => {
  for (const field of ['content', 'prompt', 'messages', 'artifact_content', 'goal', 'background', 'completion']) {
    // The rule matches an unbroken run of 12+ non-space characters, so the fixture is a body-shaped
    // token, not prose. Prose with spaces is NOT caught by this rule - that limitation is registered
    // separately rather than fixed by quietly widening a security control.
    const result = scanText(`${field}="invoice-summary-for-acme-corp-2026-q4"`, { source: 'unit.log' });
    assert.equal(result.failed, true, `${field} carrying a body must still be caught`);
    assert.equal(result.byRule['content.field'], 1, `${field} must be attributed to content.field`);
  }
});

