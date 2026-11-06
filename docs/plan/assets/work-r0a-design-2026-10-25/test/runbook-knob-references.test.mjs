// 2026-11-06 (#81 deploy preflight): §5.32 tells the person swapping work-worker which command
// to run and which field to read. An instruction that names a knob nobody implemented is worse
// than no instruction - the operator runs it, gets nothing, and moves on. Precedent: I-2's row
// needed two factual corrections of exactly this kind after the fact.
// This gate resolves every command, unit, flag and JSON key that §5.32 names against the tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLAN_DIR = join(HERE, '..', '..', '..');
const WORK_ROOT = join(PLAN_DIR, '..', '..', 'src', 'work');
const RUNBOOK = join(PLAN_DIR, 'work-operations-runbook-2026-10-25.md');
const DEPLOY_DIR = join(WORK_ROOT, 'deploy', 'ecs');
const CMD_DIR = join(WORK_ROOT, 'cmd');

const runbook = readFileSync(RUNBOOK, 'utf8');
const lines = runbook.split(/\r?\n/);
const start = lines.findIndex((line) => /^### 5\.32 /.test(line));
assert.ok(start >= 0, 'runbook must keep the §5.32 worker-swap replay preflight');
let end = lines.length;
for (let index = start + 1; index < lines.length; index += 1) {
  if (/^#{2,4} /.test(lines[index])) {
    end = index;
    break;
  }
}
const section = lines.slice(start, end).join('\n');

// A gutted section must not pass vacuously: it has to still carry the shape of a procedure.
const sectionLines = section.split(/\r?\n/).filter((line) => line.trim() !== '');
assert.ok(sectionLines.length >= 12,
  `§5.32 shrank to ${sectionLines.length} lines; the preflight steps were expected`);
assert.match(section, /GetVersion/, '§5.32 must keep the reason the replay is needed');

const cmdNames = readdirSync(CMD_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const deployStems = readdirSync(DEPLOY_DIR)
  .map((name) => basename(name, name.endsWith('.example') ? '.example' : ''))
  .map((name) => name.replace(/\.(sh|service|timer|env|sql|py|json|md)$/,''));

// Backticked `work-*` tokens must be a command, a deploy asset, or a systemd unit that exists.
const namedBinaries = [...new Set([...section.matchAll(/`(work-[a-z0-9-]+)[`.\s]/g)].map((m) => m[1]))];
assert.ok(namedBinaries.length >= 3,
  `§5.32 names only ${namedBinaries.length} work-* objects; expected at least three`);
for (const name of namedBinaries) {
  const resolved = cmdNames.includes(name)
    || deployStems.some((stem) => stem === name || stem.startsWith(`${name}.`))
    || existsSync(join(DEPLOY_DIR, `${name}.service`))
    || existsSync(join(DEPLOY_DIR, `${name}.sh`))
    || existsSync(join(DEPLOY_DIR, `${name}.env.example`))
    // A backticked `work-*.md` citation is a document reference, not an executable knob:
    // still resolved against the tree, so a renamed or invented plan doc goes red too.
    || existsSync(join(PLAN_DIR, `${name}.md`));
  assert.ok(resolved, `§5.32 names ${name}, which is not a command, script, unit or plan doc in the tree`);
}

// Flags must be declared where the SDK would read them, not invented prose.
const flagSources = readdirSync(CMD_DIR)
  .flatMap((name) => {
    const dir = join(CMD_DIR, name);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.go'))
        .map((f) => readFileSync(join(dir, f), 'utf8'));
    } catch {
      return [];
    }
  })
  .join('\n');
const namedFlags = [...new Set([...section.matchAll(/`-([a-z][a-z0-9-]+)`/g)].map((m) => m[1]))];
assert.ok(namedFlags.length >= 2,
  `§5.32 names only ${namedFlags.length} flags; the command shapes must stay pinned`);
for (const flag of namedFlags) {
  assert.ok(flagSources.includes(`"${flag}"`),
    `§5.32 tells operators to pass -${flag}, but no command declares that flag`);
}

// The field an operator is told to read has to be the field the code actually prints - pinned
// from both sides, because a check written as "only if the doc mentions it" stops meaning
// anything the moment the doc stops mentioning it.
const scanSource = readFileSync(join(CMD_DIR, 'work-reconcile', 'scan.go'), 'utf8');
for (const key of ['workflow_status', 'run_state']) {
  assert.ok(section.includes(`\`${key}\``),
    `§5.32 must keep naming ${key}; without it the operator has no field to read`);
  assert.ok(scanSource.includes(`json:"${key}"`),
    `work-reconcile -scan no longer emits ${key}; §5.32 points at a field that is not printed`);
}
