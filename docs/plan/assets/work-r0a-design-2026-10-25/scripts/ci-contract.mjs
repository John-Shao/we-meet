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
  'updateTask',
  'deleteTask',
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
  'getUserUsage',
  'getAdminUsage',
  'getProviderConfig',
  'setProviderConfig',
  'revokeProviderConfig',
  'createProviderCredential',
  'rotateProviderCredential',
  'revokeProviderCredential',
  'createAuditExport',
  'getAuditExport',
  'createAuditExportTicket',
  'getAuditExportContent',
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
check(paths.size === 29, `unique path count ${paths.size}/29`);
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
check(adminPaths.length === 12, `admin paths 12/12 (6 read + usage + provider config/credentials)`);
check(
  ![...paths].some(
    (openapiPath) =>
      openapiPath.includes('/admin/audit-exports') &&
      (openapiPath.endsWith('/download') || openapiPath.includes('/public/')),
  ),
  'audit exports expose no public download path',
);
// 方案 B：作业状态与一次性凭证都由 R0a 自己给出，正文兑换必须带 header 凭证。
check(
  operations.some((operation) => operation.operationId === 'createAuditExportTicket') &&
    operations.some((operation) => operation.operationId === 'getAuditExportContent'),
  'audit export exposes ticket issue and single-use redemption operations',
);
const contentPathStart = spec.indexOf('/work/v1/admin/audit-exports/{exportId}/content:');
const contentPathBody = spec.slice(contentPathStart, contentPathStart + 1600);
check(
  contentPathStart > 0 && contentPathBody.includes('"#/components/parameters/DownloadToken"'),
  'export content redemption requires the X-Download-Token header (no credential in URLs)',
);
check(
  !/download_url/.test(spec),
  'AuditExport exposes no pre-baked download URL',
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

const catalog = JSON.parse(read(path.join(HERE, 'error-codes.json')));
const mockSource = read(path.join(HERE, 'mock-server.mjs'));
const mockCodes = [...mockSource.matchAll(/fail\((\d{3}), '([a-z_]+)'/g)].map((m) => ({
  status: Number(m[1]),
  code: m[2],
}));
const badMock = mockCodes.filter(
  ({ status, code }) => !catalog.public[code] || catalog.public[code].status !== status,
);
check(
  badMock.length === 0,
  `mock error codes match the frozen catalog (${new Set(mockCodes.map((c) => c.code)).size} codes)`,
);
if (badMock.length > 0) {
  fail(`mock codes missing/mismatched: ${badMock.map((c) => `${c.code}:${c.status}`).join(', ')}`);
}
// Scan the assembled schema (all source fragments), not one fragment; ':detail' suffixes share the prefix code.
const sqlSource = read(path.join(HERE, 'r0a-schema-draft.sql'));
const sqlCodes = [
  ...new Set(
    [...sqlSource.matchAll(/RAISE\s+EXCEPTION\s+'([a-z][a-z0-9_:]*)/g)].map((m) => m[1].split(':')[0]),
  ),
].sort();
const nonCodeRaises = [...sqlSource.matchAll(/RAISE\s+EXCEPTION\s+'([^']*)'/g)]
  .map((m) => m[1])
  .filter((text) => !/^[a-z][a-z0-9_]*(:[a-z0-9_:%>-]*)?$/.test(text));
check(nonCodeRaises.length === 0, 'every SQL RAISE EXCEPTION message is a snake_case code');
if (nonCodeRaises.length > 0) fail(`SQL raises free text: ${nonCodeRaises.join(' | ')}`);
const unmappedSql = sqlCodes.filter((code) => !catalog.public[catalog.db_exception_map[code]]);
check(
  unmappedSql.length === 0,
  `every SQL exception in r0a-schema-draft.sql maps to a public code (${sqlCodes.length} codes)`,
);
if (unmappedSql.length > 0) fail(`unmapped SQL exceptions: ${unmappedSql.join(', ')}`);
const staleMap = Object.keys(catalog.db_exception_map).filter((code) => !sqlCodes.includes(code));
check(staleMap.length === 0, 'db_exception_map has no entries that SQL no longer raises');
if (staleMap.length > 0) fail(`stale db_exception_map entries: ${staleMap.join(', ')}`);
check(
  Object.values(catalog.public).every(
    (entry) => entry.retryable === (entry.status >= 500 || entry.status === 429),
  ),
  'retryable is true exactly for 5xx/429 (preview_stale needs a new preview, not a resend)',
);

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
