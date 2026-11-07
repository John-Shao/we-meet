// 2026-11-07 (#92): a release package carries RELEASE_COMMIT, but every ops script in it is copied
// with `cp "$ROOT/..."` - i.e. from the working tree. So a dirty tree ships files that are newer than
// the commit the package names, and `git show $(cat RELEASE_COMMIT):file` silently disagrees with
// what got installed. That is the fourth face of the "the package's two self-descriptions never met"
// family (#78, #47, #54), and it is exactly how this session twice ended up with a host file that was
// in no commit. make-release now records the dirty-path count and rollout prints it; this guard keeps
// the plumbing honest without needing a git checkout or a container.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const DEPLOY_DIR = join(ASSET_DIR, '..', '..', 'src', 'work', 'deploy', 'ecs');
const maker = readFileSync(join(DEPLOY_DIR, 'make-release.sh'), 'utf8');
const rollout = readFileSync(join(DEPLOY_DIR, 'rollout-r0a-0027.sh'), 'utf8');

test('the package declares its own provenance, and the rollout says it out loud', () => {
  assert.match(maker, /git -C [^\n]*status --porcelain/, 'make-release must ask git about the tree');
  assert.match(maker, /\$OUT\/RELEASE_DIRTY/, 'the dirty count must be written into the package');
  assert.match(maker, /NOT reproducible against the stamped commit/, 'a dirty build must be announced, not silent');
  // wording note: the shipped strings deliberately avoid `from <word>`, because doc-schema-refs reads
  // that shape as a SQL FROM table name - both scripts and this expectation carry the same phrase.
  assert.doesNotMatch(maker, /reproducible from that/, 'the operator-facing string must stay parseable');
  assert.doesNotMatch(rollout, /reproducible from that/, 'the operator-facing string must stay parseable');
  assert.match(rollout, /\$RELEASE\/RELEASE_DIRTY/, 'rollout must read the file rather than assume clean');
  assert.match(rollout, /is missing; cannot tell whether packaged files match/,
    'a package without the record must be treated as unattributable, not as zero');
  assert.match(rollout, /is not a number/, 'a corrupt record must not be read as clean');
});

test('the dirty check covers every directory the package actually copies from', () => {
  // derive, do not transcribe: the pathspec list has to span whatever the `cp` sources resolve to.
  const pathspecLine = maker.slice(maker.indexOf('status --porcelain'), maker.indexOf('| wc -l'));
  assert.ok(pathspecLine.length > 0 && pathspecLine.length < 400,
    `could not locate the status pathspec list (slice length ${pathspecLine.length})`);
  const covered = [...new Set([...pathspecLine.matchAll(/(?:^|\s)"?([A-Za-z0-9_./-]*(?:src\/work|docs\/plan[^"\s]*))/g)].map((m) => m[1]))];
  assert.ok(covered.some((p) => p.startsWith('src/work')),
    `pathspec list must include src/work, got ${JSON.stringify(covered)}`);

  // every variable a `cp` source starts with, excluding the release output dir
  const vars = [...new Set([...maker.matchAll(/(?:^|\n)\s*cp\s+"[^\n"]*\$\{?([A-Z_]+)\//g)].map((m) => m[1]))];
  assert.ok(vars.length >= 1, 'no `cp "$VAR/` sources parsed - this check would be vacuous');
  assert.deepEqual(vars.filter((v) => !['ROOT', 'ASSETS'].includes(v)), [],
    `package now copies from $${vars.join('/$')}; widen the RELEASE_DIRTY pathspec list or the dirty count will lie`);
  assert.match(maker, /ASSETS=.*work-r0a-hardening-2026-10-25/,
    'the pathspec list names the hardening asset dir; if that variable moved, the list must move with it');
});

test('the two scripts disagree with neither file about who prints what', () => {
  // make-release must not also print the operator-facing warning path that rollout owns, and rollout
  // must not compute the count itself - one number, produced once, consumed once.
  assert.doesNotMatch(rollout, /status --porcelain/,
    'rollout computes a dirty count; the number belongs to the build, not the install');
  assert.ok((maker.match(/RELEASE_DIRTY/g) || []).length >= 1,
    'make-release must write the record into the package');
  assert.equal((maker.match(/status --porcelain/g) || []).length, 1,
    'the dirty count must be computed exactly once, in the build');
});
