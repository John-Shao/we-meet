// 2026-11-14 (#96, 待裁项实施第九件): since 11-08 the prose blind spot of `content.field` has been
// carried as a sentence - "只匹配 12 个以上非空白字符" - and no machine artifact said how wide the
// hole actually is. This gate measures it against the shipped rule (parsed out of log-scan.mjs, never
// copied) and pins the answer shape by shape. It deliberately does NOT widen the rule: that control
// was accepted by 主签 on 2026-11-08 as a known limitation, so widening is a re-adjudication, not a
// fix. That re-adjudication was asked and answered on 2026-11-14: 甲 - the rule stays as shipped and
// this gate is the deliverable; 乙/丙/丁 stay on the table with their measured costs (see the
// 2026-11-14 row in docs/plan/work-project.md §9). The mechanical reopen trigger is test 5 below: the
// day a content-shaped key=%s log line exists in src/work, the gain stops being prospective. Every row below is a reading, so a future widening turns this gate red and makes whoever does
// it update the table and the ruling row in the same commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const HARD_DIR = join(ROOT, 'docs', 'plan', 'assets', 'work-r0a-hardening-2026-10-25');
const SCANNER = join(HARD_DIR, 'log-scan.mjs');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'work-r0a-gates.yml');
const REOPEN = '复评窗 2026-11-20';

const scannerText = readFileSync(SCANNER, 'utf8');

// Derive the rule from the shipped file. A copied regex would keep passing after the rule changed,
// which is the failure mode this whole batch exists to remove.
function ruleSource(id) {
  const at = scannerText.indexOf(`id: '${id}'`);
  assert.ok(at !== -1, `rule ${id} is gone from ${SCANNER}`);
  const m = /pattern:\s*\n?\s*(\/.*\/[gimsuy]*)/m.exec(scannerText.slice(at));
  assert.ok(m, `pattern for ${id} is not parseable out of the shipped file`);
  return m[1];
}
const CONTENT_RULE = ruleSource('content.field');
const KEYS = /\(\?:([a-z_|]+)\)/.exec(CONTENT_RULE)[1].split('|');
const quantifiers = [...CONTENT_RULE.matchAll(/\{(\d+),\}/g)];
assert.equal(quantifiers.length, 1,
  `#96: the coverage table derives one length floor from the rule; the rule now has ${quantifiers.length} quantifiers`);
const FLOOR = Number(quantifiers[0][1]);
const fieldRe = () => new RegExp(CONTENT_RULE.slice(1, CONTENT_RULE.lastIndexOf('/')), CONTENT_RULE.slice(CONTENT_RULE.lastIndexOf('/') + 1));

// Leak shapes. P1/P2 are what work-api would emit if anyone ever logged a body
// (`s.logger.Printf("... goal=%s", goal)`) - Go's log package prints the value raw, so the value
// starts with a short word and then contains spaces. P3/P4 are the same for Chinese text, which
// only differs in that a long Chinese body has no ASCII spaces at all.
const LEAK_SHAPES = [
  ['P1_bare_en_goal', 'task created goal=Please summarize the quarterly report and list risks', false],
  ['P2_bare_en_completion', 'advance done completion: Sure! Here is a summary of the document.', false],
  ['P3_bare_zh_goal', 'task created goal=请帮我整理这份季度报告', false],
  ['P4_bare_zh_short', 'task created goal=整理一段试点验收说明', false],
  ['P5_quoted_en', 'prompt="Please summarize the quarterly report and list the risks"', false],
  ['P6_quoted_zh', 'background="R0a 预发端到端验收说明，包含三条结论"', false],
  ['P7_json_body', 'messages=[{"role":"user","content":"Hello, can you help me draft an email?"}]', false],
  ['P8_json_artifact', 'artifact_content={"title":"Weekly sync notes","body":"Discuss the roadmap"}', false],
  ['P9_truncated', 'warn truncated goal=Please summarize the quarterly rep…', false],
  // P10 is the shipped suite's own fixture shape (`log-scan.test.mjs`, body-shaped token, no
  // spaces). It is in this table so the gate proves the rule is alive, not dead.
  ['P10_bare_long_token', 'task created goal=invoice-summary-for-acme-corp-2026-q4', true],
];

// Shapes that must stay clean. K5/K6 are read straight out of the committed drill evidence
// (`d4-a-1-suspend-obligations-restore.log:44`, `d5-c27-c30-deletion-transfer-20261108.txt:12`):
// they are row counts of the outbox table, and they are the reason a whitespace-tolerant widening
// is not free - see test 3.
const CLEAN_SHAPES = [
  ['K1_locator_bare', 'content=content://work/org1/abc123def456ghi789?v=1'],
  ['K2_locator_ref', 'ready|0478f98c-a5d4-4b00-af77-29a91150255b|ref=content://work/4a2d3f/48a31a?v=1'],
  ['K3_usage_tokens', 'provider call prompt_tokens=1024 completion_tokens=311'],
  ['K4_content_type', 'GET /v1/work/tasks 200 content_type=application/json duration_ms=17'],
  ['K5_corpus_counts', 'outbox_kinds: content=2, run=186, task=897'],
  ['K6_corpus_padded', 'outbox content     = 153 (pending=0, all delivered)'],
  ['K7_plain_word', 'advance ok messages=3 elapsed_ms=41 org=4a2d3f28-38b9-4d6c'],
];

// The CI scan step, read out of the workflow so this gate cannot drift from what CI runs. Parsing
// failure is deferred into the test that uses it: a missing run line must red that one test with a
// named reason, not turn the whole file into an import-time throw.
function parseScanTargets() {
  const line = readFileSync(WORKFLOW, 'utf8').split(/\r?\n/).find((l) => /run:\s*node log-scan\.mjs/.test(l));
  assert.ok(line, 'no `node log-scan.mjs` run line in the workflow - this gate would be scanning nothing');
  return line.replace(/^\s*run:\s*node log-scan\.mjs\s*/, '').trim().split(/\s+/);
}
const SCAN_TARGETS = parseScanTargets();

const { scanText } = await import(pathToFileURL(SCANNER).href);

test(`the shipped rule covers ${LEAK_SHAPES.filter((s) => s[2]).length} of ${LEAK_SHAPES.length} leak shapes, and the table says which`, () => {
  const wrong = [];
  for (const [id, line, expected] of LEAK_SHAPES) {
    const got = fieldRe().test(line);
    if (got !== expected) wrong.push(`${id}: table says ${expected}, rule says ${got}`);
  }
  assert.deepEqual(wrong, [],
    `#96 coverage table no longer matches the shipped content.field rule. ${REOPEN}. ` +
    `If the rule was widened, update this table AND the ruling row in docs/plan/work-project.md in the same commit - ` +
    `a security control must not change on a silent green. Mismatched rows: ${wrong.join('; ')}`);
});

test('locator and metadata shapes stay clean, including the two count lines living in the evidence set', () => {
  const fired = CLEAN_SHAPES.filter(([, line]) => fieldRe().test(line)).map(([id]) => id);
  assert.deepEqual(fired, [],
    `#96: shapes that are not user content now fire content.field (${fired.join(', ')}). ` +
    `K5/K6 come verbatim from committed drill evidence, so this is the false-positive cost of a widening ` +
    `being paid by the CI scan set and by the daily work-c16-log-scan.timer on the host. ${REOPEN}`);
});

test('relaxing only the whitespace requirement would fire on the evidence set, which is why this is a ruling and not a fix', () => {
  // The measured single-variable counterfactual: keep the key list, the separator, the locator
  // lookahead and the length floor, but let the value contain spaces once it has reached 12
  // characters. It catches 5 of the 10 leak shapes and fires on exactly the two count lines above
  // - i.e. the widening is paid for in red gates and paged on-call, not in prose. The alternation
  // is wrapped so the shipped `(?!//|content://)` guard, which sits in front of this tail, keeps
  // covering both arms: `A|B` would leave B unguarded and turn a locator back into a finding.
  const widenedSource = CONTENT_RULE.slice(1, CONTENT_RULE.lastIndexOf('/')).replace(
    `[^\\s"']{${FLOOR},}`,
    `(?:[^\\s"']{2,}(?:[ ,;]+[^\\s"']+){2,}|[^\\s"']{${FLOOR},})`,
  );
  assert.notEqual(widenedSource, CONTENT_RULE.slice(1, CONTENT_RULE.lastIndexOf('/')),
    `#96: the counterfactual found no \`[^\\s"']{${FLOOR},}\` tail to relax, so it silently measured the shipped rule`);
  // A /g regex carries lastIndex between test() calls and answers alternately, so every probe gets a
  // fresh instance - the same reason fieldRe() above is a factory.
  const widenedRe = () => new RegExp(widenedSource, 'gi');
  const caught = LEAK_SHAPES.filter(([, line]) => widenedRe().test(line)).length;
  const evidenceFired = CLEAN_SHAPES.filter(([, line]) => widenedRe().test(line)).map(([id]) => id);
  assert.equal(caught, 5, `the measured widening caught ${caught}/10 leak shapes; the recorded cost table is now stale`);
  assert.deepEqual(evidenceFired, ['K5_corpus_counts', 'K6_corpus_padded'],
    'the recorded false-positive pair for a whitespace-tolerant value changed');
});

test('the other leg is exact-match only: a verbatim title fires, truncated or different content does not', () => {
  const TITLE = '整理一段试点验收说明';
  const cases = [
    ['verbatim title leaked', `task created title=${TITLE} org=4a2d3f28`, [TITLE], true],
    ['some other prose body', 'advance done completion: Sure! Here is a summary of the document.', [TITLE], false],
    ['title truncated in the line', `task created title=${TITLE.slice(0, 6)}…`, [TITLE], false],
    // What widening the canary to a prefix would buy, and what it would cost: a benign line that
    // happens to start with the same six characters becomes a finding.
    ['prefix canary catches the truncation', `task created title=${TITLE.slice(0, 6)}…`, [TITLE.slice(0, 6)], true],
    ['prefix canary also fires on a near-phrase', 'info note=整理一段试点验收 说明 elsewhere', [TITLE.slice(0, 6)], true],
  ];
  const wrong = [];
  for (const [id, line, canaries, expected] of cases) {
    const result = scanText(line, { source: 'coverage-probe.log', canaries });
    const onlyCanary = Object.keys(result.byRule).every((rule) => rule === 'content.canary');
    if (result.failed !== expected || !onlyCanary) {
      wrong.push(`${id}: expected failed=${expected} via content.canary only, got failed=${result.failed} rules=${Object.keys(result.byRule).join(',')}`);
    }
  }
  assert.deepEqual(wrong, [],
    `#96: the canary leg's measured semantics changed. It is a substring test against values read ` +
    `from work.task titles (up to 40, newest first - see src/work/scripts/work-c16-log-scan.sh:84), ` +
    `so it cannot see content that is not one of those titles. ${REOPEN} ${wrong.join('; ')}`);
});

test('no production log line carries a content-shaped key today, so this rule is prospective', () => {
  const goFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(child);
      } else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) goFiles.push(child);
    }
  };
  walk(join(ROOT, 'src', 'work'));
  assert.ok(goFiles.length >= 100, `only found ${goFiles.length} Go files under src/work - the walk is broken, so the zero below means nothing`);
  const keyPat = new RegExp(`(?:${KEYS.join('|')})=`);
  let contentShaped = 0;
  let keyValueShaped = 0;
  const hits = [];
  for (const file of goFiles) {
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const m = /Printf\(\s*"([^"]*)"/.exec(line);
      if (!m) return;
      const fmt = m[1];
      if (/[a-z_]+=%/.test(fmt)) keyValueShaped += 1;
      if (keyPat.test(fmt)) {
        contentShaped += 1;
        hits.push(`${file}:${i + 1}`);
      }
    });
  }
  assert.ok(keyValueShaped >= 30, `only ${keyValueShaped} key=%s log sites found - the floor that keeps this reading meaningful has gone`);
  assert.equal(contentShaped, 0,
    `#96: production code now logs a content-shaped key (${hits.join(', ')}). The prose blind spot stopped ` +
    `being theoretical: a body logged in this shape is invisible to content.field unless the value is a single ` +
    `${FLOOR}+ character run. ${REOPEN}`);
});

test('the CI scan set is still clean under the rule this table describes', () => {
  const run = spawnSync(process.execPath, [SCANNER, ...SCAN_TARGETS], { cwd: HARD_DIR, encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, `the scanner exits ${run.status}: ${run.stdout}${run.stderr}`);
  const m = /scanned (\d+) files\/(\d+) lines; fail=(\d+) warn=(\d+)/.exec(run.stdout);
  assert.ok(m, `scanner did not print its own reading: ${run.stdout}`);
  assert.ok(Number(m[1]) >= 43, `scan set shrank to ${m[1]} files - c16-scan-scope.test.mjs owns the membership, this floor owns the trend`);
  assert.equal(m[3], '0', `the committed evidence set now fails content.field: ${run.stdout}`);
});

test('the limitation is stated in the docs with the number the rule actually uses and the gate that owns it', () => {
  // The floor has to appear as a standalone number AND in the same clause as the wording that states
  // the limitation (`非空白` / `下限`). `includes('4')` would be satisfied by "43 files"; a bare
  // standalone-number test is satisfied by the runbook's own evidence citation `…txt:12`, which is a
  // file:line reference and says nothing about the floor. Binding the number to the limitation wording
  // is what keeps a mutation that deletes the clause red.
  const bindingRe = new RegExp(`(?<![\\d.])${FLOOR}(?![\\d])[^。\\n]{0,16}(?:非空白|下限)`);
  const docs = [
    join(ROOT, 'docs', 'plan', 'work-glossary.md'),
    join(ROOT, 'docs', 'plan', 'work-project.md'),
    join(ROOT, 'docs', 'plan', 'work-operations-runbook-2026-10-25.md'),
  ];
  for (const doc of docs) {
    const lines = readFileSync(doc, 'utf8').split(/\r?\n/);
    const carriers = lines.filter((l) => l.includes('c16-content-coverage.test.mjs'));
    assert.ok(carriers.length >= 1, `${doc} never names c16-content-coverage.test.mjs - the reading has no live instruction pointing at its source`);
    assert.ok(carriers.some((l) => bindingRe.test(l)),
      `${doc} names the gate but no longer states the floor ${FLOOR} inside the limitation clause ` +
      `(a citation like \`…txt:12\` does not count) - if the rule moved, re-state the ` +
      `limitation here in the same commit (${REOPEN})`);
  }
});
