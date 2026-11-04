// 2026-11-04: a markdown row with one cell too many renders fine and reads wrong. In the drill checklist
// P9 carried a sixth cell, which shifted 负责 and 时限 one column right - an executor would have looked at
// the wrong owner and the wrong date. The drill file is now covered by drill-steps.test.mjs, but measuring
// the rest of the corpus found four more such rows (meeting-ai-phase1, org-account-lifecycle,
// implementation-status, temporal-deployment-plan), all fixed in place, so this gate can cover every
// document with zero exemptions instead of widening tolerance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLAN_DIR = join(HERE, '..', '..', '..');

const files = readdirSync(PLAN_DIR)
  .filter((name) => name.endsWith('.md'))
  .map((name) => join(PLAN_DIR, name));
for (const dir of readdirSync(join(PLAN_DIR, 'assets'))) {
  const readme = join(PLAN_DIR, 'assets', dir, 'README.md');
  if (existsSync(readme)) files.push(readme);
}

const splitCells = (line) => {
  const parts = line.trim().split(/(?<!\\)\|/);
  if (parts[0] === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
};

const isDivider = (cells) =>
  cells.length > 0 && cells.every((cell) => /^[\s:|-]+$/.test(cell.replace(/\\\|/g, '')));

const mismatches = [];
let tables = 0;
let scannedFiles = 0;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  scannedFiles += 1;
  let current = null;
  let inFence = false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (inFence) current = null;
      continue;
    }
    if (inFence) continue;
    if (/^\s*\|/.test(line)) {
      if (current === null) {
        current = { cols: null, start: index + 1 };
        tables += 1;
      }
      const cells = splitCells(line);
      if (isDivider(cells)) continue;
      if (current.cols === null) current.cols = cells.length;
      else if (cells.length !== current.cols) {
        mismatches.push(`${file.split(/[\\/]/).pop()}:${index + 1} has ${cells.length} cells, header ${current.cols} (table at ${current.start})`);
      }
      continue;
    }
    current = null;
  }
}

test('the corpus is really scanned, so a broken extractor cannot pass over nothing', () => {
  assert.ok(scannedFiles >= 20, `only ${scannedFiles} markdown files scanned under docs/plan - the corpus moved`);
  assert.ok(tables >= 60, `only ${tables} tables found - a parser regression would make the next assertion vacuous`);
});

test('every table row carries as many cells as its own header', () => {
  assert.deepEqual(
    mismatches,
    [],
    `rows that shift the following columns for whoever reads the document:\n${mismatches.join('\n')}`,
  );
});
