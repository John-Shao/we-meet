// Generates the device bundle's signed-file manifest + dev fixture profile (execution-face §6.4/§6.5,
// 批2-5 主签单选甲). runtime_digest = sha256(JCS(ordered signed-file manifest)); tool_manifest_hash =
// sha256(JCS(four tool schemas)). The JCS here is RFC 8785 for the data shapes used (strings, integers,
// booleans, arrays, null): recursively sort object keys, compact JSON, UTF-8. The Rust side
// (src/device/src/digest.rs) recomputes the SAME hashes with frame::jcs and the gate cross-checks them,
// so a divergence between this canonicalizer and Rust's is caught, not silently shipped.
//
// Run: node build-manifest.mjs   (from the device-bundle directory). No install-time npm (ARCH:126):
// the vendored node_modules bytes are committed; this script only hashes what is already present.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
// Files that are NOT shipped runtime bundle bytes: the tests, this generator, and the two outputs
// (self-referential). Everything else under the bundle dir — adapter + vendored pi dist — is pinned.
const EXCLUDE_TOP = new Set(['test', 'build-manifest.mjs', 'bundle-manifest.json', 'dev-fixture-profile.json']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// RFC 8785 JCS for our shapes: sort keys recursively, then compact stringify. Integers serialize as
// plain digits (no floats appear in the manifest or schemas), matching Rust frame::jcs byte-for-byte.
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const jcsHash = (value) => sha256(Buffer.from(canonicalize(value), 'utf8'));

function walk(dir, base) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (base === '' && EXCLUDE_TOP.has(name)) continue;
    const abs = path.join(dir, name);
    const rel = base === '' ? name : `${base}/${name}`;
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs, rel));
    else if (st.isFile()) out.push({ path: rel, sha256: sha256(readFileSync(abs)) });
  }
  return out;
}

const files = walk(root, '').sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const runtimeDigest = jcsHash(files);
const schemas = JSON.parse(readFileSync(path.join(root, 'tool-schemas.json'), 'utf8'));
const toolManifestHash = jcsHash(schemas);

const manifest = { files, runtime_digest: runtimeDigest, tool_manifest_hash: toolManifestHash };
writeFileSync(path.join(root, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// The dev fixture profile (E3 乙, §6.5): a fixed dev profile whose two hashes are computed from the
// fixture bytes above (NOT placeholders). listener_requirement is non-empty (§5.4 step 5: a
// three-empty device_local profile cannot publish; allow_user_pinned_hash=true is the dev fixture's
// pin). The real ExecutionProfile publish face + binding verified path stay M4/M5.
const profile = {
  profile_id: 'profile-dev-fixture-v1',
  compat_profile_version: 1,
  canonical_schema: 'device-tool-schemas-v1',
  node_version: '>=22',
  model_route: { provider: 'device-local', model: 'fixture-model', config_revision: 1 },
  tool_manifest_hash: toolManifestHash,
  runtime_digest: runtimeDigest,
  listener_requirement: { allowed_signers: [], allow_user_pinned_hash: true, allowed_service_sids: [] },
};
writeFileSync(path.join(root, 'dev-fixture-profile.json'), `${JSON.stringify(profile, null, 2)}\n`);

console.log(`runtime_digest    = ${runtimeDigest}`);
console.log(`tool_manifest_hash = ${toolManifestHash}`);
console.log(`signed files      = ${files.length}`);