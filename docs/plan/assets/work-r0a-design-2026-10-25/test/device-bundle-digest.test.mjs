// 2026-11-19 (批2-5, execution-face §6.4/§6.5, 主签单选甲). The two digest placeholders are转实:
// runtime_digest = sha256(JCS(ordered signed-file manifest)) covering the vendored pi dist + adapter;
// tool_manifest_hash = sha256(JCS(four tool schemas)); the dev fixture profile declares a non-empty
// listener_requirement. THIS gate pins the manifest infrastructure and the cross-language seam:
//   ① the Node build script's JCS and the Rust digest module reproduce the SAME hashes (the Rust lib
//     test digest::jcs_hash_matches_the_node_build_script_for_the_shipped_fixtures is the byte-level
//     proof; here we pin the algorithm + recompute node-side self-consistency);
//   ② the four tool schemas are additionalProperties=false and their field sets match tools.rs;
//   ③ the Broker re-verifies the bundle digest BEFORE spawn (DD:113 single designated-digest sidecar);
//   ④ the dev fixture profile is publishable (§5.4 step 5: not three-empty) and the pi dist is vendored.
// Deliberately NOT asserted: the real ExecutionProfile publish face + binding verified (M4/M5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const BUNDLE = join(ROOT, 'src', 'work', 'node', 'device-bundle');
const DEVICE = join(ROOT, 'src', 'device');
const read = (p) => readFileSync(p, 'utf8');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const jcsHash = (v) => sha256(Buffer.from(canonicalize(v), 'utf8'));

const BUILD = join(BUNDLE, 'build-manifest.mjs');
const SCHEMAS = join(BUNDLE, 'tool-schemas.json');
const MANIFEST = join(BUNDLE, 'bundle-manifest.json');
const PROFILE = join(BUNDLE, 'dev-fixture-profile.json');
const DIGEST_RS = join(DEVICE, 'src', 'digest.rs');
const SYNCCORE = join(DEVICE, 'src', 'synccore.rs');
const TOOLS_RS = join(DEVICE, 'src', 'tools.rs');
for (const p of [BUILD, SCHEMAS, MANIFEST, PROFILE, DIGEST_RS, SYNCCORE, TOOLS_RS]) {
  assert.ok(existsSync(p), `missing ${p}`);
}

test('the build script defines the two hashes as sha256(JCS(...)) over the signed bundle bytes', () => {
  const src = read(BUILD);
  assert.ok(src.includes("createHash('sha256')"), 'sha256 is the hash');
  assert.ok(src.includes('function canonicalize'), 'an RFC 8785 canonicalizer is present');
  assert.ok(src.includes('Object.keys(value).sort()'), 'JCS sorts object keys');
  assert.ok(src.includes('runtime_digest') && src.includes('tool_manifest_hash'));
  // The manifest excludes the tests, the generator and its own two outputs (no self-reference).
  for (const ex of ['test', 'build-manifest.mjs', 'bundle-manifest.json', 'dev-fixture-profile.json']) {
    assert.ok(src.includes(`'${ex}'`), `exclusion ${ex} missing`);
  }
});

test('the shipped manifest and profile are node-side self-consistent (recomputed hashes match)', () => {
  const manifest = JSON.parse(read(MANIFEST));
  const profile = JSON.parse(read(PROFILE));
  const schemas = JSON.parse(read(SCHEMAS));
  // files are sorted by path and each entry is {path, sha256}.
  const paths = manifest.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort(), 'manifest files must be ordered');
  for (const f of manifest.files) {
    assert.deepEqual(Object.keys(f).sort(), ['path', 'sha256']);
    assert.match(f.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(jcsHash(manifest.files), manifest.runtime_digest);
  assert.equal(jcsHash(schemas), manifest.tool_manifest_hash);
  assert.equal(profile.runtime_digest, manifest.runtime_digest);
  assert.equal(profile.tool_manifest_hash, manifest.tool_manifest_hash);
  // The vendored pi dist is actually covered (甲 ruling: manifest covers the full bundle).
  assert.ok(paths.some((p) => p.startsWith('node_modules/@earendil-works/pi-agent-core/')));
  assert.ok(paths.some((p) => p.startsWith('node_modules/@earendil-works/pi-ai/')));
  assert.ok(paths.some((p) => p.startsWith('node_modules/typebox/')));
  assert.ok(paths.includes('main.js') && paths.includes('tool-schemas.json'));
});

test('the four tool schemas are closed and their field sets match tools.rs', () => {
  const schemas = JSON.parse(read(SCHEMAS));
  assert.deepEqual(Object.keys(schemas).sort(), ['artifact.write', 'workspace.list', 'workspace.read', 'workspace.search']);
  const tools = read(TOOLS_RS);
  const allowed = (name) => {
    const arm = tools.split(`${name} => &[`)[1].split(']')[0];
    return [...arm.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  };
  const rustConst = { 'workspace.list': 'WORKSPACE_LIST', 'workspace.read': 'WORKSPACE_READ', 'workspace.search': 'WORKSPACE_SEARCH', 'artifact.write': 'ARTIFACT_WRITE' };
  for (const [name, schema] of Object.entries(schemas)) {
    assert.equal(schema.additionalProperties, false, `${name} must be additionalProperties=false`);
    assert.equal(schema.type, 'object');
    assert.deepEqual(Object.keys(schema.properties).sort(), allowed(rustConst[name]), `${name} field set drifted from tools.rs`);
    assert.ok(schema.required.includes('grant_id'), `${name} requires grant_id`);
  }
});

test('the dev fixture profile is publishable and carries bare sha256-hex pins', () => {
  const profile = JSON.parse(read(PROFILE));
  assert.equal(profile.profile_id, 'profile-dev-fixture-v1');
  assert.match(profile.runtime_digest, /^[a-f0-9]{64}$/);
  assert.match(profile.tool_manifest_hash, /^[a-f0-9]{64}$/);
  const req = profile.listener_requirement;
  assert.deepEqual(Object.keys(req).sort(), ['allow_user_pinned_hash', 'allowed_service_sids', 'allowed_signers']);
  const publishable = req.allowed_signers.length > 0 || req.allow_user_pinned_hash === true || req.allowed_service_sids.length > 0;
  assert.ok(publishable, '§5.4 step 5: a three-empty device_local profile cannot publish');
  assert.equal(profile.model_route.provider, 'device-local');
});

test('the Rust digest module re-hashes from disk and guards manifest path escape', () => {
  const src = read(DIGEST_RS);
  assert.ok(src.includes('crate::frame::jcs::canonicalize'), 'uses the device RFC 8785 JCS, not a hand-roll');
  assert.ok(src.includes('pub fn verify_bundle'));
  assert.ok(src.includes('std::fs::read(bundle_dir.join(rel))'), 're-hashes each listed file from disk');
  assert.ok(src.includes('DigestError::Mismatch'));
  assert.ok(src.includes('rel.split(\'/\').any'), 'rejects parent/absolute path escape in manifest entries');
});

test('the sync core verifies the bundle digest BEFORE spawning the sidecar (DD:113)', () => {
  const src = read(SYNCCORE);
  const start = src.indexOf('fn consume_start(');
  const body = src.slice(start, src.indexOf('fn ', start + 10));
  const verify = body.indexOf('crate::digest::verify_bundle');
  const spawn = body.indexOf('spawn_sidecar(&config');
  assert.ok(verify >= 0, 'consume_start must call verify_bundle');
  assert.ok(spawn > verify, 'verify_bundle must precede spawn_sidecar');
  assert.ok(body.includes('bundle digest refused'), 'a refused digest leaves no run_started');
});

test('the pi runtime closure is vendored into the bundle (E2 甲, self-contained)', () => {
  for (const pkg of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'typebox', 'partial-json']) {
    assert.ok(existsSync(join(BUNDLE, 'node_modules', pkg, 'package.json')), `vendored ${pkg} missing`);
  }
  // The provider SDKs are NOT vendored (the device constructs no provider transport; they are lazy).
  assert.ok(!existsSync(join(BUNDLE, 'node_modules', '@anthropic-ai')), 'provider SDKs must not be vendored');
  assert.ok(!existsSync(join(BUNDLE, 'node_modules', '@aws-sdk')), 'provider SDKs must not be vendored');
});