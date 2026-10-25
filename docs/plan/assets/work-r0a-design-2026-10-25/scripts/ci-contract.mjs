#!/usr/bin/env node
/**
 * R0a contract gate.
 *
 * Fails when:
 *   - the OpenAPI subset drifts from the frozen R0a operation allowlist
 *   - a local $ref points at a missing component
 *   - the generated runtime client is stale
 *   - the generated TypeScript types lack an operation/schema the client uses
 *   - contract, admin adapter or generated-client tests fail
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_PATH,
  SPEC_PATH,
  parseOperations,
  renderClient,
} from '../generate-client.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TYPES_PATH = path.join(HERE, 'r0a-api-types.d.ts');
const TEST_DIR = path.join(HERE, 'test');

const FROZEN_OPERATIONS = Object.freeze([
  'getBootstrap',
  'createInput',
  'listTemplates',
  'createTaskPreview',
  'listTasks',
  'submitTask',
  'getTask',
  'retryTask',
  'getRun',
  'listOperations',
  'cancelRun',
  'streamTaskEvents',
  'listInbox',
  'createArtifactVersion',
  'getArtifactVersion',
  'getArtifactContent',
  'acceptTask',
  'getAdminOverview',
  'listSeats',
  'createAuditExport',
  'getAuditExport',
]);

const FORBIDDEN_PATH_SEGMENTS = Object.freeze([
  '/connectors',
  '/devices',
  '/workspace-grants',
  '/capabilities',
  '/projects',
  '/operator',
  '/approvals',
  '/skills',
  '/schedules',
]);

let failures = 0;

function ok(message) {
  console.log(`ok  ${message}`);
}

function fail(message) {
  failures += 1;
  console.error(`FAIL ${message}`);
}

function check(condition, message) {
  if (condition) ok(message);
  else fail(message);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const spec = read(SPEC_PATH);
const lines = spec.split(/\r?\n/);
const operations = parseOperations(spec);

check(/^openapi: 3\.1/m.test(spec), 'OpenAPI version is 3.1');
check(operations.length === FROZEN_OPERATIONS.length, `operation count ${operations.length}/${FROZEN_OPERATIONS.length}`);

const operationIds = operations.map((operation) => operation.operationId);
check(
  JSON.stringify([...operationIds].sort()) === JSON.stringify([...FROZEN_OPERATIONS].sort()),
  'operation ids match the frozen R0a allowlist',
);

const paths = new Set(operations.map((operation) => operation.path));
check(paths.size === 20, `unique path count ${paths.size}/20`);
check(
  operations.every((operation) => operation.path.startsWith('/work/v1/')),
  'all paths are under /work/v1/',
);
check(
  operations.every((operation) => operation.successStatus >= 200 && operation.successStatus < 300),
  'every operation declares a 2xx success response',
);
check(
  operations.every(
    (operation) =>
      operation.successSchema ||
      operation.successContentType?.startsWith('text/') ||
      operation.stream,
  ),
  'every success response has a JSON schema or text/SSE content',
);

for (const segment of FORBIDDEN_PATH_SEGMENTS) {
  check(
    ![...paths].some((openapiPath) => openapiPath.includes(segment)),
    `R0a subset excludes ${segment}`,
  );
}

const adminPaths = [...paths].filter((openapiPath) => openapiPath.includes('/admin/'));
check(adminPaths.length === 4, `admin read paths 4/4 (${adminPaths.length})`);
check(
  ![...paths].some(
    (openapiPath) =>
      openapiPath.includes('/admin/audit-exports') &&
      openapiPath.endsWith('/download'),
  ),
  'audit downloads are one-time URLs, not a public download path',
);

const localRefs = [...spec.matchAll(/\$ref: "#\/components\/(\w+)\/(\w+)"/g)];
const componentsStart = lines.findIndex((line) => /^components:\s*$/.test(line));
const componentKeys = new Map();
for (let i = componentsStart + 1; i < lines.length; i += 1) {
  const section = lines[i].match(/^  (\w+):\s*$/);
  if (section) {
    componentKeys.set(section[1], new Set());
    continue;
  }
  const key = lines[i].match(/^    (\w+):\s*$/);
  const currentSection = [...componentKeys.keys()].at(-1);
  if (key && currentSection) componentKeys.get(currentSection).add(key[1]);
}
const missingRefs = localRefs.filter(
  ([, section, name]) => !componentKeys.get(section)?.has(name),
);
check(missingRefs.length === 0, `local $ref targets resolve (${localRefs.length} refs)`);
if (missingRefs.length > 0) {
  for (const ref of missingRefs.slice(0, 10)) fail(`unresolved $ref ${ref[1]}/${ref[2]}`);
}

const rendered = renderClient(spec, operations);
const committedClient = fs.existsSync(CLIENT_PATH) ? read(CLIENT_PATH) : '';
check(committedClient === rendered, 'r0a-client.mjs is generated from the current spec');
if (committedClient !== rendered) {
  const committedLines = committedClient.split(/\r?\n/);
  const generatedLines = rendered.split(/\r?\n/);
  const index = committedLines.findIndex((line, i) => line !== generatedLines[i]);
  fail(
    `generated client drift at line ${index + 1}; run: node generate-client.mjs`,
  );
}

const types = fs.existsSync(TYPES_PATH) ? read(TYPES_PATH) : '';
check(types.includes('auto-generated by openapi-typescript'), 'r0a-api-types.d.ts is generated');
const missingOperations = operations
  .map((operation) => operation.operationId)
  .filter((operationId) => !new RegExp(`\\n    ${operationId}: \\{`).test(types));
check(
  missingOperations.length === 0,
  `types contain all ${operations.length} operations`,
);
if (missingOperations.length > 0) {
  fail(`types missing operations: ${missingOperations.join(', ')}`);
}

const referencedSchemas = new Set(
  operations.flatMap((operation) =>
    [operation.requestSchema, operation.successSchema].filter(Boolean),
  ),
);
const missingSchemas = [...referencedSchemas].filter(
  (schema) => !new RegExp(`\\n        ${schema}:`).test(types),
);
check(
  missingSchemas.length === 0,
  `types contain all ${referencedSchemas.size} client-referenced schemas`,
);
if (missingSchemas.length > 0) {
  fail(`types missing schemas: ${missingSchemas.join(', ')}`);
}

const testFiles = fs
  .readdirSync(TEST_DIR)
  .filter((file) => file.endsWith('.test.mjs'))
  .sort()
  .map((file) => path.join(TEST_DIR, file));

check(testFiles.length >= 3, `test files discovered (${testFiles.length})`);
const tests = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: HERE,
  stdio: 'inherit',
});
if (tests.status !== 0) fail('contract tests failed');

if (failures > 0) {
  console.error(`\n${failures} contract gate check(s) failed`);
  process.exit(1);
}
console.log('\nR0a contract gate passed');
