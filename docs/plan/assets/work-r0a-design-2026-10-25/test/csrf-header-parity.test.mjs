// #45 offset 7 (signed 2026-11-04, option B): the CSRF header name has three copies -
// the OpenAPI contract parameter, a Go server-side constant, and the generated client's
// header assignment. Two of them were already guarded (the generator refuses to emit unless
// the header matches the contract), but the Go constant could still drift silently: a rename
// there changes what the server accepts while every gate stays green.
//
// The values are read from source rather than restated here, so the gate cannot rot into
// asserting an old literal. Zero matches is a failure, not a pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESIGN = new URL('../', import.meta.url);
const REPO = new URL('../../../../../', import.meta.url);
const CONTRACT = fileURLToPath(new URL('r0a-openapi-v1.yaml', DESIGN));
const WORK_SRC = fileURLToPath(new URL('src/work', REPO));

const contractName = /CsrfToken:\s*\r?\n\s*name:\s*(\S+)/.exec(readFileSync(CONTRACT, 'utf8'))?.[1];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith('.go')) out.push(full);
  }
  return out;
}

test('the contract declares a CSRF header name', () => {
  assert.ok(typeof contractName === 'string' && contractName.length > 0,
    'could not extract CsrfToken.name from the OpenAPI contract - the assertions below would be vacuous');
});

test('the Go control plane names the same header, and no second spelling exists', () => {
  const files = walk(WORK_SRC);
  assert.ok(files.length >= 50, `expected at least 50 Go files under src/work, found ${files.length}`);
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/"(X-[A-Za-z0-9-]*CSRF[A-Za-z0-9-]*)"/gi)) hits.push({ file: file.slice(WORK_SRC.length + 1), name: match[1] });
  }
  assert.ok(hits.length >= 1, 'no Go literal naming a CSRF header exists - either the constant was renamed away or the scan is looking at the wrong tree');
  const offNames = [...new Set(hits.map((h) => h.name))].filter((name) => name.toLowerCase() !== contractName.toLowerCase());
  assert.deepEqual(offNames, [], `Go names the CSRF header ${offNames.join(', ')} while the contract says ${contractName}`);
});

// The client side is deliberately NOT asserted here: gen-work-api.mjs:242-246 already reads
// the header name back out of what it renders and refuses to emit the artifact when it
// differs from the contract's CsrfToken parameter (that guard was mutation-checked when it
// landed). Duplicating it here with a looser pattern would only add a second, weaker check.
