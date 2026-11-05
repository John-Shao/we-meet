// L-C04-03's env half. Two things kept drifting apart: the workload binaries read knobs that
// no template mentioned (so an operator had to read Go to configure a service, and runbook
// section 5.3 was already telling duty staff to set WORK_DIRECTORY_MODE / _ALLOW_MASS_ABSENCE),
// and the one timeout knob the DR2 finding actually named - WORK_ADVANCE_TIMEOUT_SECONDS - was
// undocumented while the finding claimed three were unset.
//
// Direction matters: this asserts "read => documented", not the reverse. Templates legitimately
// carry host-local paths and secret file names that other code reads through a different helper,
// so a two-way equality would either fail or force an allow list long enough to mean nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORK_DIR = fileURLToPath(new URL('../../../../src/work/', import.meta.url));
const CMD_DIR = join(WORK_DIR, 'cmd');
const ECS_DIR = join(WORK_DIR, 'deploy/ecs');

// A knob may stay undocumented only with a named reason. Empty means every read name has to be
// in a template, which is the point of the check.
const INTENTIONALLY_UNDOCUMENTED = [];

function goFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...goFiles(abs));
    else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) out.push(abs);
  }
  return out;
}

const READ = /Getenv\("([A-Z0-9_]+)"\)|envString\("([A-Z0-9_]+)"|envInt\("([A-Z0-9_]+)"|envBool\("([A-Z0-9_]+)"/g;
const readByName = new Map();
for (const file of goFiles(CMD_DIR)) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(READ)) {
    const name = match.slice(1).find(Boolean);
    if (!name) continue;
    const owners = readByName.get(name) ?? new Set();
    owners.add(file.replace(WORK_DIR, '').split(/[\\/]/).filter(Boolean)[0]);
    readByName.set(name, owners);
  }
}

const templates = readdirSync(ECS_DIR).filter((f) => f.endsWith('.env.example')).sort();
const documented = new Set();
for (const template of templates) {
  for (const match of readFileSync(join(ECS_DIR, template), 'utf8').matchAll(/^#?\s*([A-Z0-9_]+)=/gm)) {
    documented.add(match[1]);
  }
}

test('the scan itself saw the real surface, so an empty result is not a pass', () => {
  assert.ok(readByName.size >= 25,
    `expected at least 25 env names read under cmd/, found ${readByName.size} - the regex and the ` +
      'Go helpers drifted apart');
  assert.ok(documented.size >= 45,
    `expected at least 45 keys across the env templates, found ${documented.size} in ` +
      `${templates.length} files - the templates or the scan moved`);
});

test('every env knob a workload binary reads is documented in some env template', () => {
  const undocumented = [...readByName.keys()]
    .filter((name) => !documented.has(name))
    .filter((name) => !INTENTIONALLY_UNDOCUMENTED.some((e) => e.name === name));
  const problems = undocumented.map((name) =>
    `${name} is read by ${[...readByName.get(name)].join(', ')} but appears in no deploy/ecs/*.env.example`);
  const bogus = INTENTIONALLY_UNDOCUMENTED.filter((entry) => {
    const documentedElsewhere = documented.has(entry.name);
    return documentedElsewhere || !readByName.has(entry.name);
  }).map((entry) => `${entry.name} is in the exception list but is either documented or not read at all`);
  assert.deepEqual([...problems, ...bogus], [], 'undocumented runtime knobs (operators would have to read Go to set them)');
});

// The invariant that actually bites on a rebuilt host: rollout calls install_env for a unit, and
// install_env exits 1 when the template is not in the release. Templates that are repo
// documentation only (no install_env call) have to say so by name, so a new template cannot
// appear unclassified and quietly stop being delivered.
const DOCUMENTATION_ONLY_TEMPLATES = [
  { template: 'work-worker.env.example', reason: 'the pilot host holds /etc/work/work-worker.env from D-04 provisioning; rollout never calls install_env for it' },
  { template: 'work-export.env.example', reason: 'work-export runs as a one-shot with its own env file written at rollout time, not from this template' },
];
const installedUnits = (() => {
  const text = readFileSync(join(ECS_DIR, 'rollout-r0a-0027.sh'), 'utf8');
  return [...text.matchAll(/^install_env (\S+)$/gm)].map((m) => m[1]).sort();
})();

test('each env template is installed-with-delivery or classified documentation-only', () => {
  const release = readFileSync(join(ECS_DIR, 'make-release.sh'), 'utf8');
  const problems = [];
  for (const unit of installedUnits) {
    const name = `${unit}.env.example`;
    if (!templates.includes(name)) problems.push(`rollout calls install_env ${unit} but no ${name} exists`);
    if (!release.includes(`deploy/ecs/${name}`)) {
      problems.push(`rollout calls install_env ${unit} but make-release.sh does not ship ${name} - a fresh host exits 1 in install_env`);
    }
  }
  const unclassified = templates
    .filter((name) => !release.includes(`deploy/ecs/${name}`))
    .filter((name) => !DOCUMENTATION_ONLY_TEMPLATES.some((entry) => entry.template === name))
    .map((name) => `${name} is neither shipped nor classified`);
  const stale = DOCUMENTATION_ONLY_TEMPLATES
    .filter((entry) => release.includes(`deploy/ecs/${entry.template}`) || !templates.includes(entry.template))
    .map((entry) => `${entry.template} is in the documentation-only list but is shipped or absent`);
  assert.ok(installedUnits.length >= 4,
    `expected several install_env calls, found ${installedUnits.length} - the rollout scan stopped matching`);
  assert.deepEqual([...problems, ...unclassified, ...stale], [], 'env template delivery is unaccounted for');
});

// The other direction: a knob that is documented but read by nothing is worse than an
// undocumented one, because an operator sets it, sees no effect, and reasonably assumes the
// deployment is broken. The probe is deliberately bash-aware - the earlier shell one-liners
// both lied: a pattern that required "${NAME}" missed the "${NAME:-}" form used in the
// wrappers, and a backslash-d-bounded pattern degraded through bash quoting and reported
// every key as unreadable. Assertions live in a file, not in a shell string.
//
// Entries in UNWIRED_KNOBS are a claim about a specific key, so each carries the reason it is
// still worth shipping. The test fails on a stale entry the same way it fails on a new one:
// either the key gets a reader, or it stops being advertised.
const UNWIRED_KNOBS = [];

test('every documented env knob is actually read by something shipped', () => {
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/node_modules|catalogs/.test(abs)) continue;
        walk(abs);
      } else if (/\.(go|mjs|sh|ts|service|timer)$/.test(entry.name) &&
        !/_test\.go$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) {
        sources.push(readFileSync(abs, 'utf8'));
      }
    }
  };
  walk(WORK_DIR);
  const blob = sources.join('\n');

  const unreadable = [];
  for (const key of documented) {
    const patterns = [
      new RegExp(`["']${key}["']`),          // Go/mjs literal
      new RegExp(`\\$\\{?${key}\\b`),         // bash: $KEY, ${KEY}, ${KEY:-default}
      new RegExp(`Environment=?${key}=`),    // systemd unit
    ];
    if (patterns.some((pattern) => pattern.test(blob))) continue;
    const exempt = UNWIRED_KNOBS.find((entry) => entry.key === key);
    if (!exempt || !exempt.reason) {
      unreadable.push(`${key}${exempt ? ' (allow-listed without a working reader)' : ''}`);
    }
  }
  const stale = UNWIRED_KNOBS.filter((entry) => documented.has(entry.key) === false)
    .map((entry) => `${entry.key} is in the unwired list but appears in no template`);
  assert.deepEqual([...unreadable, ...stale], [],
    'knobs advertised in an env template that nothing reads (an operator would set them and see no effect)');
  assert.ok(sources.length >= 150,
    `expected to scan the whole Work subtree, scanned ${sources.length} files - the walker stopped matching`);
});
