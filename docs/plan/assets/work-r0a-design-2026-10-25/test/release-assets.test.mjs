// The release package is a hand-written list of `cp` lines in
// src/work/deploy/ecs/make-release.sh - and a missing line is silent: the build succeeds,
// the tarball uploads, and the operator discovers on duty day that a file is not there.
// This happened on 2026-11-04: scripts/run-pilot-metrics.sh (the wrapper that supplies the
// four session settings pilot-metrics.sql needs) existed, was tested, and was simply not in
// the list, so the pilot report had no operator path on the host.
//
// Three narrow checks, chosen to encode that trap without pretending to know why the other
// ops scripts are deliberately not packaged (nine of them are intentionally unpackaged:
// superseded rollout/verify 0015/0016 pairs, make-release.sh itself, R0b provisioning, etc. -
// each is a human choice, so this test does not assert on it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORK_DIR = fileURLToPath(new URL('../../../../../src/work/', import.meta.url));
const RELEASE = join(WORK_DIR, 'deploy/ecs/make-release.sh');

const copySources = (() => {
  const text = readFileSync(RELEASE, 'utf8');
  const list = [...text.matchAll(/^cp "\$ROOT\/([^"]+)" "\$OUT\/"/gm)].map((m) => m[1]);
  return list;
})();

// #47 A delivered the C16 scanner from a second source root (the hardening asset dir), so the
// packager now has two lists. Both count as shipped, and both have to point at real files.
const ASSETS_DIR = fileURLToPath(new URL('../../work-r0a-hardening-2026-10-25/', import.meta.url));
const assetCopySources = (() => {
  const text = readFileSync(RELEASE, 'utf8');
  return [...text.matchAll(/^cp "\$ASSETS\/([^"]+)" "\$OUT\/"/gm)].map((m) => m[1]);
})();
const shippedNames = new Set([...copySources, ...assetCopySources].map((p) => p.split('/').pop()));

test('the second source root ships real files, not just a line in the list', () => {
  const missing = assetCopySources.filter((p) => !existsSync(join(ASSETS_DIR, p)));
  assert.deepEqual(missing, [], `make-release.sh copies ${assetCopySources.join(', ')} but these are absent from the assets dir: ${missing.join(', ')}`);
  assert.ok(
    assetCopySources.length >= 1,
    'the packager is expected to ship the C16 scanner from the assets dir (#47 A)',
  );
});

test('the packager copy list was parsed, so an empty list is not a pass', () => {
  assert.ok(
    copySources.length >= 15,
    `expected at least 15 'cp "$ROOT/…" "$OUT/"' lines in make-release.sh, found ` +
      `${copySources.length} - the regex and the script's quoting drifted apart`,
  );
});

test('every packaged path exists in the repo', () => {
  const missing = copySources.filter((rel) => !existsSync(join(WORK_DIR, rel)));
  assert.deepEqual(
    missing,
    [],
    `make-release.sh copies paths that no longer exist in the repo: ${missing.join(', ')} - ` +
      'the build would die on the release host, partway through, after the binaries are built',
  );
});

test('an operator wrapper is packaged together with the report it runs', () => {
  // run-x.sh and x.sql are one feature: the SQL needs four SET statements, and the wrapper
  // is the only thing that supplies them correctly. Shipping half of the pair is how the
  // "just run psql -f" gap came back.
  const scriptsDir = join(WORK_DIR, 'scripts');
  const present = readdirSync(scriptsDir);
  const problems = [];
  for (const file of present) {
    if (!file.endsWith('.sh') || !file.startsWith('run-')) continue;
    const twin = file.replace(/^run-/, '').replace(/\.sh$/, '') + '.sql';
    if (!present.includes(twin)) continue;
    for (const needed of [file, twin]) {
      if (!copySources.includes(`scripts/${needed}`)) {
        problems.push(`scripts/${file} pairs with scripts/${twin} but only one of them (` +
          `${needed}) is in the release copy list`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

// A packaged script that reads a repo file which the package does not deliver is the same
// bug in a quieter form: it works on a checkout and fails on the host. #47 found exactly one
// (work-c16-log-scan.sh wanted /tmp/work-log-scan.mjs, which nothing copied). Ruling A (2026-11-04,
// John) shipped that scanner and gave the script a candidate sequence, so this list is empty:
// any new referenced-but-unpackaged file now goes red instead of being explainable away.
const REFERENCED_NOT_PACKAGED = [];

test('packaged scripts only reference repo files that ship, or are listed with a reason', () => {
  const assetDirs = [
    new URL('../../', import.meta.url), // sibling asset dirs (hardening, runtime, ...)
  ];
  const findRepoFile = (basename) => {
    for (const dir of assetDirs) {
      for (const sub of readdirSync(dir)) {
        const candidate = new URL(`${sub}/${basename}`, dir);
        if (existsSync(fileURLToPath(candidate))) return fileURLToPath(candidate);
      }
    }
    const inWork = [join(WORK_DIR, 'scripts'), join(WORK_DIR, 'deploy/ecs')];
    for (const dir of inWork) {
      const candidate = join(dir, basename);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };

  const problems = [];
  let inspected = 0;
  let resolved = 0;
  for (const rel of copySources.filter((p) => p.endsWith('.sh'))) {
    const abs = join(WORK_DIR, rel);
    if (!existsSync(abs)) continue;
    inspected++;
    const text = readFileSync(abs, 'utf8');
    for (const match of text.matchAll(/([A-Za-z0-9_./-]+)\.(mjs|sql|json)\b/g)) {
      const basename = match[1].split('/').pop() + '.' + match[2];
      const repoFile = findRepoFile(basename);
      if (!repoFile) continue; // not a repo file (path is host-local by design)
      resolved++;
      const shipped = shippedNames.has(basename);
      const allowed = REFERENCED_NOT_PACKAGED.some(
        (entry) => entry.script === rel && entry.file === basename,
      );
      if (!shipped && !allowed) {
        problems.push(`${rel} reads ${basename}, which ships in neither the package nor the allow list`);
      }
    }
  }
  assert.ok(
    inspected >= 5 && resolved >= 1,
    `expected to inspect several packaged scripts and resolve at least one repo reference, ` +
      `got inspected=${inspected} resolved=${resolved} - the scan is looking at nothing`,
  );
  assert.deepEqual(problems, [], 'unaccounted host dependency in a packaged script');
});

test('packaged shell scripts parse', () => {
  const failures = [];
  for (const rel of copySources.filter((p) => p.endsWith('.sh'))) {
    const abs = join(WORK_DIR, rel);
    if (!existsSync(abs)) continue; // reported by the existence check above
    try {
      execFileSync('bash', ['-n', abs], { stdio: 'pipe' });
    } catch (error) {
      failures.push(`${rel}: ${(error.stderr?.toString() || error.message).trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(failures, [], 'bash -n rejected a script that ships in the release');
});
