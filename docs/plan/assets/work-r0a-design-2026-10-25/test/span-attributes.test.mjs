// C16's trace half, pinned as an invariant instead of an assumption.
//
// C16 requires that logs and traces carry no user content. The log half is executed:
// scripts/work-c16-log-scan.sh runs the repository scanner over real journal output with
// live task titles as canaries. The trace half has been described as "no staging/prod OTel
// pipeline, so span attributes have never been put through the scanner" - which is true but
// easy to read as "there is a span surface and it is unverified". It is not. As of 2026-11-04
// no production Go file in src/work sets a span attribute or imports the OTel trace API at
// all, so a claim like "spans were scanned and were clean" would be vacuous, and the day
// instrumentation lands nothing would have required the payload rule to be settled first.
//
// This test turns that into a ratchet: span-attribute writes are allowed only from files
// named below (none today). Adding instrumentation has to be a visible decision - the file
// is listed here, and the same change has to give the scanner something to scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// POSIX stat() rejects a trailing slash on a regular file, so building child paths by
// appending "/" to a URL silently skipped every file on the Linux runner while working on
// the Windows host. Resolve to a filesystem path instead.
const WORK_DIR = fileURLToPath(new URL('../../../../../src/work/', import.meta.url));

// Files permitted to set span attributes, relative to src/work. Empty on purpose: R0a
// publishes no spans. A new entry is a decision about what may appear in a trace, and the
// allow list in docs/plan/assets/work-r0a-design-2026-10-25/telemetry plus the C16 scanner
// have to say what the values are.
const SPAN_WRITE_ALLOW = [];

// Attribute setters and the OTel trace entry points that would make them reachable.
const SPAN_WRITE = /\.(SetAttributes|SetAttribute)\s*\(/;
const OTEL_TRACE_IMPORT = /"[^"]*go\.opentelemetry\.io\/otel[^"]*"/;

function goFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === 'vendor' || entry.startsWith('.')) continue;
      goFiles(full, out);
      continue;
    }
    if (!entry.endsWith('.go') || entry.endsWith('_test.go')) continue;
    out.push(full);
  }
  return out;
}

const relPath = (file) => relative(WORK_DIR, file).replace(/\\/g, '/');

test('the scan sees the production tree, so an empty result is not a vacuous pass', () => {
  const files = goFiles(WORK_DIR);
  // The path is resolved from this asset's location, exactly like go-surface-drift.test.mjs.
  // If it ever resolves somewhere else, this floor fails instead of the two assertions below
  // silently passing over zero files.
  assert.ok(
    files.length >= 50,
    `expected at least 50 production .go files under src/work, found ${files.length} - the ` +
      'scan is looking at the wrong place',
  );
});

test('no production Go file sets a span attribute outside the allow list', () => {
  const offenders = [];
  for (const file of goFiles(WORK_DIR)) {
    const rel = relPath(file);
    if (SPAN_WRITE_ALLOW.some((allowed) => rel.endsWith(allowed))) continue;
    if (SPAN_WRITE.test(readFileSync(file, 'utf8'))) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    'these files write span attributes without an allow-list entry; C16 asks that trace ' +
      'payload be decided before it exists, not scanned after the fact',
  );
});

test('no production Go file imports the OTel trace API', () => {
  const importers = [];
  for (const file of goFiles(WORK_DIR)) {
    const rel = relPath(file);
    if (OTEL_TRACE_IMPORT.test(readFileSync(file, 'utf8'))) importers.push(rel);
  }
  assert.deepEqual(
    importers,
    [],
    'go.sum carries OpenTelemetry lines transitively, so an import here would be the first ' +
      'direct use - which is the moment the trace half of C16 becomes real and needs the ' +
      'scanner wired to it',
  );
});
