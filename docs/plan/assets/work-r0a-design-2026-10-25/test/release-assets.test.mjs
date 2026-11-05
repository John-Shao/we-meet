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

// #57 and L-C04-06 both came from the same shape of gap: a file that ships in the tarball but is
// never installed, so the operator's "it is right there" reasoning is true of the package and
// false of the host. The C16 re-run channel had exactly that - make-release.sh copied log-scan.mjs
// since ruling A, yet no rollout step installed it, and work-c16-log-scan.sh itself was never in
// the copy list at all, so the wrapper's "next to this script" candidate could not resolve.
// Asserting the whole chain, because any one of the three links being missing produces the same
// silent result.
test('the C16 re-run channel is packaged, installed and verified - not just copied', () => {
  const releaseText = readFileSync(RELEASE, 'utf8');
  const rolloutText = readFileSync(join(WORK_DIR, 'deploy/ecs/rollout-r0a-0027.sh'), 'utf8');
  const verifyText = readFileSync(join(WORK_DIR, 'deploy/ecs/verify-r0a-0027.sh'), 'utf8');

  const problems = [];
  for (const file of ['work-c16-log-scan.sh', 'log-scan.mjs']) {
    if (!new RegExp(`^cp "\\$(ROOT|ASSETS)/[^"]*${file.replace('.', '\\.').replace('\\.', '\\.')}[^"]*" "\\$OUT/"`, 'm')
      .test(releaseText)) {
      problems.push(`make-release.sh does not copy ${file}`);
    }
    if (!new RegExp(`install [^\\n]*\\b${file.replace('.', '\\.')}\\b`, 'm').test(rolloutText)) {
      problems.push(`rollout-r0a-0027.sh never installs ${file} - it would sit in the release dir only`);
    }
    if (!verifyText.includes(file)) {
      problems.push(`verify-r0a-0027.sh does not check ${file} in place`);
    }
  }
  assert.deepEqual(problems, [], 'the C16 scanner pair is not delivered end to end');

  // Non-vacuity: the three files this test reads are real, and the wrapper is in the copy list the
  // other checks parse, so a regex that stopped matching would surface here rather than as a pass.
  assert.ok(shippedNames.has('work-c16-log-scan.sh'), 'the wrapper is not in the parsed copy list at all');
  assert.ok(shippedNames.has('log-scan.mjs'), 'the scanner is not in the parsed shipped set at all');
});

// runbook §5.4 and the 2026-11-05 pilot write-authorization sheet both tell the operator to name the
// age identity as `WORK_BACKUP_IDENTITY=…`. The tree carried two copies of the drill: deploy/ecs
// honours that variable, the host copy (imported on 2026-11-05) hard-codes the 2026-10-29 path - and
// packaging the second one made both instructions silently ineffective on the host. The tie below is
// to the knob the docs command, so packaging a copy that lost it goes red instead of shipping a drill
// that cannot be pointed at a rotated recipient chain.
test('the packaged restore drill honours the identity knob the runbook commands', () => {
  const rel = copySources.find((p) => p.endsWith('work-db-restore-drill.py'));
  assert.ok(rel, 'the release must package work-db-restore-drill.py (#57 第二半)');
  const text = readFileSync(join(WORK_DIR, rel), 'utf8');
  assert.match(
    text,
    /os\.environ\.get\(\s*["']WORK_BACKUP_IDENTITY["']/,
    `${rel} must read WORK_BACKUP_IDENTITY - runbook §5.4 and the authorization sheet command it`,
  );
  assert.match(
    text,
    /work-offsite-20261029\.agekey/,
    `${rel} must keep the 2026-10-29 identity as the unset default, so the current path is unchanged`,
  );
});


// An increment that is in the manifest is applied by `work-migrate apply`, which reads the
// embedded manifest - so a new increment ships with zero attention on the deploy side. The
// verify script kept its hand-written (version, name) list at 0027 while the manifest moved to
// 0028, which is the same gap class as #47 and #57: the release does the thing and nothing on
// the host ever confirms it. Tie the two lists together so landing an increment without a
// verification line goes red here rather than as a clean rollout.
test('every published increment is confirmed by the verify script, not only by the manifest', () => {
  const manifest = JSON.parse(readFileSync(join(WORK_DIR, 'migrations/manifest.json'), 'utf8'));
  const increments = (manifest.increments || []).filter((entry) => entry.version >= 17);
  assert.ok(increments.length >= 12, `parsed ${increments.length} increments from 17 up, list parsing is broken`);

  const verifyText = readFileSync(join(WORK_DIR, 'deploy/ecs/verify-r0a-0027.sh'), 'utf8');
  const normalized = verifyText.replace(/\s+/g, ' ');
  assert.ok(
    normalized.includes('missing in 17..'),
    'verify-r0a-0027.sh no longer carries the expected-ledger block this test reads',
  );

  const missing = increments
    .filter((entry) => !normalized.includes(`(${entry.version}, '${entry.name}')`))
    .map((entry) => `${entry.name}`);
  assert.deepEqual(missing, [], 'these published increments have no verification line in the rollout pair');
});
