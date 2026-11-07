// 2026-11-07 (#94 = G3): the ruling had two halves - narrow `content.field` so a content:// locator
// is not user content, AND put the drill evidence directory into the CI scan set. The first half is
// pinned by log-scan.test.mjs (both directions). This guard pins the second half: the workflow's
// scan step must actually name the evidence directories, because a scan set that silently shrinks
// is the exact defect G3 was raised for - the ops directory had never been scanned at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'work-r0a-gates.yml');
const body = readFileSync(WORKFLOW, 'utf8');

const scanLine = body.split(/\r?\n/).find((line) => /run:\s*node log-scan\.mjs/.test(line));
assert.ok(scanLine, 'the log-scan job no longer has a `node log-scan.mjs` run line');

test('the CI scan set names every evidence directory that exists', () => {
  const targets = scanLine.replace(/^\s*run:\s*node log-scan\.mjs\s*/, '').trim().split(/\s+/);
  assert.ok(targets.length >= 3, `scan set shrank to ${targets.length} targets: ${scanLine}`);
  // every argument must resolve on disk, so a renamed directory cannot pass as a string
  for (const target of targets) {
    const resolved = join(ROOT, 'docs', 'plan', 'assets', 'work-r0a-hardening-2026-10-25', target);
    assert.ok(existsSync(resolved), `scan target ${target} does not exist at ${resolved}`);
  }
  assert.ok(targets.includes('../work-r0a-ops-2026-10-25'),
    `the drill evidence directory is missing from the CI scan set (this is #94 = G3): ${scanLine}`);
  assert.ok(targets.includes('../work-temporal-slice-2026-10-25'),
    `the temporal slice evidence left the scan set: ${scanLine}`);
});

test('the narrowing is documented where the rule lives, not only in a commit message', () => {
  const scanner = readFileSync(join(ROOT, 'docs', 'plan', 'assets', 'work-r0a-hardening-2026-10-25', 'log-scan.mjs'), 'utf8');
  assert.match(scanner, /#94 = G3/, 'the rule change must carry its ruling reference');
  assert.match(scanner, /\(\?!\\\/\\\/\|content:\\\/\\\/\)/,
    'the locator lookahead is gone - either the rule was widened back or rewritten without this guard noticing');
});
