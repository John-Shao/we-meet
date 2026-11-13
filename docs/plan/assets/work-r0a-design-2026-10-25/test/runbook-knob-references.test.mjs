// 2026-11-06 (#81 deploy preflight): §5.32 tells the person swapping work-worker which command
// to run and which field to read. An instruction that names a knob nobody implemented is worse
// than no instruction - the operator runs it, gets nothing, and moves on. Precedent: I-2's row
// needed two factual corrections of exactly this kind after the fact.
// This gate resolves every command, unit, flag and JSON key that §5.32 names against the tree.
// 【2026-11-13 同日扩】§5.34（卡片 V＝甲 的链尾门值班程序）加入同一张清单：同一条理由不因节号而失效。
// 节号配置在本文件（`procedureSections`），**声明在 runbook 自己那一节**（`<!-- knob-check: §N.M -->`），
// 两边必须互为相等——漏挂、多挂、把节删掉都红；清单被清空另有下限。为什么不让门自己"发现"所有带命令块
// 的节：§5.4／§5.5／§5.29／§5.33 的散文里那些 `work-*` 反引号是主机文件名（age 私钥、pg_dump 归档），
// 不是旋钮，把它们一并纳入要先逐名裁定，那不在本批。
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
const deployFiles = readdirSync(DEPLOY_DIR);
const deployStems = deployFiles
  .map((name) => basename(name, name.endsWith('.example') ? '.example' : ''))
  .map((name) => name.replace(/\.(sh|service|timer|env|sql|py|json|md)$/,''));

// Service accounts are objects too: procedure text legitimately says "run this as work-control",
// and the authority for that name is the unit that runs as it. Resolved from the shipped units
// rather than listed here, so an invented account still goes red.
const unitIdentities = new Set(
  deployFiles
    .filter((name) => /\.(service|timer)$/.test(name))
    .flatMap((name) => readFileSync(join(DEPLOY_DIR, name), 'utf8').split(/\r?\n/))
    .map((line) => line.match(/^(?:User|Group)=(.+)$/))
    .filter(Boolean)
    .flatMap((match) => match[1].replace(/^!/, '').split(/[\s,]+/))
    .filter((value) => value !== '')
);
// Floor, so this category cannot quietly become "nothing is ever allowed" (which would push the
// next reader to hard-code a name list instead): the shipped units really do carry accounts.
assert.ok(unitIdentities.size >= 2,
  `only ${unitIdentities.size} service identities read from the shipped units - the derivation broke`);

// Backticked `work-*` tokens must be a command, a deploy asset, or a systemd unit that exists.
const resolves = (name) => cmdNames.includes(name)
  || unitIdentities.has(name)
  || deployStems.some((stem) => stem === name || stem.startsWith(`${name}.`))
  || existsSync(join(DEPLOY_DIR, `${name}.service`))
  || existsSync(join(DEPLOY_DIR, `${name}.sh`))
  || existsSync(join(DEPLOY_DIR, `${name}.env.example`))
  // A backticked `work-*.md` citation is a document reference, not an executable knob:
  // still resolved against the tree, so a renamed or invented plan doc goes red too.
  || existsSync(join(PLAN_DIR, `${name}.md`));

const namedBinaries = [...new Set([...section.matchAll(/`(work-[a-z0-9-]+)[`.\s]/g)].map((m) => m[1]))];
assert.ok(namedBinaries.length >= 3,
  `§5.32 names only ${namedBinaries.length} work-* objects; expected at least three`);
for (const name of namedBinaries) {
  assert.ok(resolves(name), `§5.32 names ${name}, which is not a command, script, unit or plan doc in the tree`);
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

// 2026-11-13 (卡片 V＝甲 implemented in the repo): §5.34 is the on-call procedure for the new boot
// gate, so it names binaries, flags and error codes exactly the way §5.32 does. The rule above was
// written because "an instruction that names a knob nobody implemented is worse than no
// instruction", and that reason is not specific to §5.32 - so the same resolution now covers every
// procedure section listed here, rather than the new one getting a weaker check by accident.
const procedureSections = [
  { label: '§5.32', heading: /^### 5\.32 /, minLines: 12, minBinaries: 3, minFlags: 2 },
  { label: '§5.34', heading: /^### 5\.34 /, minLines: 18, minBinaries: 3, minFlags: 1 },
];

function body(label, heading) {
  const start = lines.findIndex((line) => heading.test(line));
  assert.ok(start >= 0, `runbook must keep ${label}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,4} /.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

// Registering a section here is what makes it checked, so the pairing needs a producer on the doc
// side too: a procedure section declares itself with `<!-- knob-check: §N.M -->`, and this gate
// requires the two sets to be equal in both directions. Un-register §5.34 and it goes red; add a
// new marked procedure section and forget the list entry, same.
// Honest limit: a section nobody marked is not covered. The runbook already carries command blocks
// in §5.4, §5.5, §5.29 and §5.33 whose prose names host artifacts (`work-backup`, `work-offsite-20261029`,
// `work-pre-0027-20261106-221004`) that are filenames rather than knobs, so widening the rule to
// every command-bearing section needs those names adjudicated first - not this batch.
const markedLabels = [...runbook.matchAll(/<!--\s*knob-check:\s*(§\d+\.\d+)\s*-->/g)].map((m) => m[1]);
assert.ok(markedLabels.length >= 1,
  'no runbook section declares knob-check any more - either the markers went or the convention did');

test('every marked procedure section is registered for knob resolution, and only those', () => {
  assert.ok(procedureSections.length >= 2,
    `only ${procedureSections.length} procedure sections are registered; §5.32 and §5.34 both belong`);
  const registered = procedureSections.map((entry) => entry.label).sort();
  const marked = [...new Set(markedLabels)].sort();
  assert.deepEqual(registered, marked,
    'the runbook marks procedure sections and this gate registers them; the two lists have to say the same thing');
});

test('every runbook procedure section resolves the objects and flags it names', () => {
  for (const entry of procedureSections) {
    const text = body(entry.label, entry.heading);
    const nonEmpty = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    assert.ok(nonEmpty.length >= entry.minLines,
      `${entry.label} shrank to ${nonEmpty.length} lines; the procedure steps were expected`);
    const objects = [...new Set([...text.matchAll(/`(work-[a-z0-9-]+)[`.\s]/g)].map((m) => m[1]))];
    assert.ok(objects.length >= entry.minBinaries,
      `${entry.label} names only ${objects.length} work-* objects; expected at least ${entry.minBinaries}`);
    for (const name of objects) {
      assert.ok(resolves(name),
        `${entry.label} names ${name}, which is not a command, script, unit or plan doc in the tree`);
    }
    const flags = [...new Set([...text.matchAll(/`-([a-z][a-z0-9-]+)`/g)].map((m) => m[1]))];
    assert.ok(flags.length >= entry.minFlags,
      `${entry.label} names only ${flags.length} flags; the command shapes must stay pinned`);
    for (const flag of flags) {
      assert.ok(flagSources.includes(`"${flag}"`),
        `${entry.label} tells operators to pass -${flag}, but no command declares that flag`);
    }
  }
});

// §5.34 tells the on-call reader which two codes to tell apart and which field to read. Both sides
// are pinned: the codes have to still be produced by the binary, and the flag the procedure quotes
// has to be the flag the shipped gate unit actually passes - otherwise a renamed code or a retuned
// ExecStart turns this page into a lookup table pointing at nothing.
test('the boot-gate section names codes the binary produces and the flag the gate unit passes', () => {
  const text = body('§5.34', /^### 5\.34 /);
  const migrateMain = readFileSync(join(CMD_DIR, 'work-migrate', 'main.go'), 'utf8');
  const ledgerSource = readFileSync(join(WORK_ROOT, 'internal', 'migrate', 'ledger.go'), 'utf8');
  const runnerSource = readFileSync(join(WORK_ROOT, 'internal', 'migrate', 'runner.go'), 'utf8');
  const gateUnit = readFileSync(join(DEPLOY_DIR, 'work-chain-check.service'), 'utf8');
  for (const code of ['ledger_pending_increments', 'ledger_version_unknown']) {
    assert.ok(text.includes(code), `§5.34 must keep naming ${code}; without it the two directions merge`);
    const produced = migrateMain.includes(`"${code}"`) || ledgerSource.includes(`"${code}"`);
    assert.ok(produced, `no command produces ${code} any more; §5.34 diagnoses a code that is not emitted`);
  }
  for (const state of ['empty', 'pending', 'up_to_date']) {
    assert.ok(runnerSource.includes(`"${state}"`),
      `work-migrate no longer reports state ${state}; §5.34 lists a value that is never printed`);
    assert.ok(text.includes(`\`${state}\``), `§5.34 must keep naming state ${state}`);
  }
  assert.match(gateUnit, /^ExecStart=\/usr\/local\/bin\/ecs-migrate\.sh status -require-up-to-date$/m,
    'the shipped gate unit no longer passes the flag §5.34 tells operators to run by hand');
  assert.match(text, /work-chain-check\.service/, '§5.34 must keep naming the gate unit by its real name');
});
