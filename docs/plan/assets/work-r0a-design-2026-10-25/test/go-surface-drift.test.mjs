// Contract-to-implementation drift gate for the flat /work/v1 surface.
// The OpenAPI asset and the Go router are written independently; without this
// check a new route or a retired operation changes one side silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const API_DIR = new URL('../../../../../src/work/internal/api/', import.meta.url);
const OPENAPI = new URL('../r0a-openapi-v1.yaml', import.meta.url);

// Declared in the contract, no Go handler. Pinned so that adding a route or
// retiring an operation has to be a deliberate edit here as well. Their R0a
// disposition (implement, or trim from the contract when D2' re-signs the
// surface) is tracked in docs/plan/work-project.md. Note: the provider write
// operations left here are IN R0a scope (D-08a signed "org owners may write the
// access config"); revokeProviderConfig shipped on 2026-11-01 and the three
// credential writes -- create, rotate and revoke -- shipped on 2026-11-02, so all
// four were removed from this list. Only setProviderConfig remains, blocked on the
// connectivity probe the contract requires before a config takes effect -- see
// docs/plan/work-r0a-provider-write-surface-2026-11-01.md. The two read
// projections (inbox, run operations) additionally lack SQL read functions.
const CONTRACT_ONLY = [
  'GET /work/v1/inbox',
  'GET /work/v1/runs/{runId}/operations',
  'POST /work/v1/artifacts/{artifactId}/versions',
  'PUT /work/v1/admin/provider-config',
];

// Served by the Go control plane but absent from the contract: the task-scoped
// artifact deep-link routes shipped for the standalone artifact workspace.
const IMPLEMENTED_ONLY = [
  'GET /work/v1/tasks/{taskId}/artifacts/{artifactId}',
  'GET /work/v1/tasks/{taskId}/artifacts/{artifactId}/versions/{versionNo}',
  'GET /work/v1/tasks/{taskId}/artifacts/{artifactId}/versions/{versionNo}/content',
  // R0b's registered faces live under /work/v2: §1.4 declares every relative path in
  // its table beneath that prefix, and this asset is the R0a v1 contract, so v2 routes
  // are "implemented but not in this contract" by construction. They are listed here
  // rather than filtered out of the comparison, so a future v2 route still has to be a
  // deliberate edit - and when the v2 contract is published, these entries leave.
  'GET /work/v2/admin/local-policy',
  'PATCH /work/v2/admin/local-policy',
  'POST /work/v2/admin/governance-event-cursor',
  'GET /work/v2/runs/{runId}/reconciliations',
];

function readGoSurface() {
  const consts = new Map();
  const routes = [];
  for (const file of readdirSync(API_DIR)) {
    if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
    const source = readFileSync(new URL(file, API_DIR), 'utf8').replace(/\r\n/g, '\n');
    for (const match of source.matchAll(/^(?:\t|const\s+)([A-Z][A-Za-z0-9]*)\s*=\s*(.+)$/gm)) {
      consts.set(match[1], match[2].trim());
    }
    for (const match of source.matchAll(/HandleFunc\("([A-Z]+) "\+([A-Za-z0-9_.]+)/g)) {
      routes.push({ method: match[1], name: match[2].split('.').pop() });
    }
  }
  const resolve = (name, depth = 0) => {
    const raw = consts.get(name);
    if (raw === undefined) throw new Error(`unresolved path constant: ${name}`);
    if (depth > 8) throw new Error(`path constant cycle: ${name}`);
    if (raw.startsWith('"')) return raw.slice(1, -1);
    return raw
      .split('+')
      .map((part) => {
        const value = part.trim();
        return value.startsWith('"') ? value.slice(1, -1) : resolve(value, depth + 1);
      })
      .join('');
  };
  return new Set(routes.map((route) => `${route.method} ${resolve(route.name)}`));
}

function readContractSurface() {
  const text = readFileSync(OPENAPI, 'utf8').replace(/\r\n/g, '\n');
  const operations = new Set();
  let path = null;
  for (const line of text.split('\n')) {
    const pathMatch = line.match(/^  (\/[^:]+):$/);
    if (pathMatch) {
      path = pathMatch[1];
      continue;
    }
    const methodMatch = line.match(/^    (get|post|patch|put|delete):$/);
    if (methodMatch && path) operations.add(`${methodMatch[1].toUpperCase()} ${path}`);
  }
  return operations;
}

test('the Go router and the contract describe the same /work/v1 surface', () => {
  const go = readGoSurface();
  const contract = readContractSurface();
  assert.ok(go.size >= 20, `expected the Go router to expose the flat surface, saw ${go.size}`);
  assert.equal(contract.size, 33);
  assert.deepEqual(
    [...contract].filter((op) => !go.has(op)).sort(),
    [...CONTRACT_ONLY].sort(),
  );
  assert.deepEqual(
    [...go].filter((op) => !contract.has(op)).sort(),
    [...IMPLEMENTED_ONLY].sort(),
  );
});

test('the drift allowlists name real routes on both sides', () => {
  const go = readGoSurface();
  const contract = readContractSurface();
  for (const op of CONTRACT_ONLY) {
    assert.ok(contract.has(op), `allowlisted as contract-only but not declared: ${op}`);
    assert.ok(!go.has(op), `allowlisted as contract-only but implemented: ${op}`);
  }
  for (const op of IMPLEMENTED_ONLY) {
    assert.ok(go.has(op), `allowlisted as implemented-only but missing from the router: ${op}`);
    assert.ok(!contract.has(op), `allowlisted as implemented-only but declared: ${op}`);
  }
});
