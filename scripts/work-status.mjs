// 生成 docs/work/status.json 与 status.md（方案 A 混合生成）。
// 动态部分现算：pilot_gate 来自 ops-model.goNoGo(checklist, slo)；migration.tip_repo 来自 manifest。
// 生产/决策事实来自 docs/work/status.inputs.json（人工记录，脚本无法从仓库推导），每个事实带
// reason/evidence/verified_at；脚本校验证据路径在仓库内存在、日期合法且不晚于 facts_as_of。
// 一致性校验（防手工事实与仓库漂移）：tip_deployed ≤ tip_repo；生产前置 ID 不得内嵌迁移版本号
// （版本会漂，已裁包范围写在 rollout_scope_note）；rollout_scope_note 必填。
// generated_at 是本次生成日期，与 facts_as_of（事实核实日期）不同义；漂移比对忽略 generated_at，
// 否则 CI 在提交日之后复跑会假红。status.md 不渲染 generated_at，保持逐字可复现。
// 用法：node scripts/work-status.mjs [--check]
//   默认：写 status.json/status.md；--check：只校验已提交文件与生成结果一致（CI 用），不写。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OPS = join(REPO, 'docs', 'plan', 'assets', 'work-r0a-ops-2026-10-25');
const WORK = join(REPO, 'docs', 'work');
const MANIFEST = join(REPO, 'src', 'work', 'migrations', 'manifest.json');

export const PILOT_GATE_COMMAND =
  "node --input-type=module -e \"const p='./docs/plan/assets/work-r0a-ops-2026-10-25/',fs=await import('node:fs'),o=await import(p+'ops-model.mjs'),c=JSON.parse(fs.readFileSync(p+'pilot-checklist.json','utf8')),s=JSON.parse(fs.readFileSync(p+'slo-pilot.json','utf8')),g=o.goNoGo(c,s);console.log('go='+g.go,'blocker='+g.blockerCount,'start='+g.startBlockerCount,'pilot='+g.pilotBlockerCount,'scale='+g.scaleBlockerCount,'measurement='+g.measurementBlockerCount,'slo='+g.sloMeasuredCount+'/'+g.sloMetricCount,'residual='+g.residualCount,'unstatedReopen='+g.unstatedReopenCount)\"";

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// 带证据的人工事实键：值在 .value，证据/核实日期随事实走，不再是一句无来源的手工文本。
const EVIDENCED_FACTS = ['runtime_verified', 'external_security_audit_done', 'content_store', 'cloud_kms'];

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

function fail(msg) {
  throw new Error(`status.inputs.json: ${msg}`);
}

// 校验一个事实块：value 必填、evidence 是非空且仓库内现存的路径、verified_at 合法且不晚于 facts_as_of。
function checkEvidence(name, fact, factsAsOf) {
  if (!fact || typeof fact !== 'object') fail(`${name} 必须是带 value/reason/evidence/verified_at 的对象`);
  if (!('value' in fact)) fail(`${name} 缺 value`);
  if (typeof fact.reason !== 'string' || !fact.reason.trim()) fail(`${name} 缺 reason`);
  if (!Array.isArray(fact.evidence) || fact.evidence.length === 0) fail(`${name} 的 evidence 必须是非空数组`);
  for (const p of fact.evidence) {
    if (typeof p !== 'string' || !p.trim()) fail(`${name} 的 evidence 含空路径`);
    if (!existsSync(join(REPO, p))) fail(`${name} 的证据路径不存在：${p}`);
  }
  if (!isDate(fact.verified_at)) fail(`${name}.verified_at 必须是 YYYY-MM-DD`);
  if (fact.verified_at > factsAsOf) fail(`${name}.verified_at（${fact.verified_at}）晚于 facts_as_of（${factsAsOf}）`);
}

export function validateInputs(inputs, tipRepo) {
  if (!isDate(inputs.facts_as_of)) fail('facts_as_of 必须是 YYYY-MM-DD');
  for (const name of EVIDENCED_FACTS) checkEvidence(name, inputs[name], inputs.facts_as_of);

  const mig = inputs.migration;
  if (!mig || typeof mig !== 'object') fail('migration 必须是对象');
  if (!Number.isInteger(mig.tip_deployed)) fail('migration.tip_deployed 必须是整数');
  if (mig.tip_deployed > tipRepo) {
    fail(`migration.tip_deployed（${mig.tip_deployed}）高于仓库 tip（${tipRepo}）——现网不可能领先仓库`);
  }
  if (typeof mig.deployed_release !== 'string' || !mig.deployed_release.trim()) fail('migration.deployed_release 必填');
  checkEvidence('migration', { value: mig.tip_deployed, ...mig }, inputs.facts_as_of);

  if (!Array.isArray(inputs.production_prerequisites) || inputs.production_prerequisites.length === 0) {
    fail('production_prerequisites 必须是非空数组');
  }
  for (const id of inputs.production_prerequisites) {
    if (typeof id !== 'string' || !id.trim()) fail('production_prerequisites 含空项');
    // 前置 ID 内嵌迁移版本号会随链尾漂移（0040-0045-rollout-authorization 就是这么过期的）。
    if (/\d{4}/.test(id)) fail(`生产前置 ID 不得内嵌迁移版本号：${id}（范围写进 rollout_scope_note）`);
  }
  if (typeof inputs.rollout_scope_note !== 'string' || !inputs.rollout_scope_note.trim()) {
    fail('rollout_scope_note 必填：写明已裁 rollout 包范围与未裁部分');
  }
  if (!Array.isArray(inputs.customer_data_blockers)) fail('customer_data_blockers 必须是数组');
}

export async function generate() {
  const inputs = readJson(join(WORK, 'status.inputs.json'));
  const checklist = readJson(join(OPS, 'pilot-checklist.json'));
  const slo = readJson(join(OPS, 'slo-pilot.json'));
  const manifest = readJson(MANIFEST);
  const ops = await import(pathToFileURL(join(OPS, 'ops-model.mjs')).href);
  const g = ops.goNoGo(checklist, slo);

  const tipRepo = Math.max(
    ...(manifest.baseline ?? []).map((b) => b.version),
    ...(manifest.increments ?? []).map((i) => i.version),
  );
  validateInputs(inputs, tipRepo);

  const factEvidence = {};
  for (const name of EVIDENCED_FACTS) {
    const f = inputs[name];
    factEvidence[name] = { value: f.value, reason: f.reason, evidence: f.evidence, verified_at: f.verified_at };
  }
  factEvidence.migration = {
    value: inputs.migration.tip_deployed,
    deployed_release: inputs.migration.deployed_release,
    reason: inputs.migration.reason,
    evidence: inputs.migration.evidence,
    verified_at: inputs.migration.verified_at,
  };

  const status = {
    $schema_note: '由 scripts/work-status.mjs 生成，勿手改。生产事实在 status.inputs.json（带证据引用）；动态门禁与仓库迁移 tip 现算。generated_at 是生成日期，facts_as_of 是事实核实日期，两者不同义。',
    generated_by: 'scripts/work-status.mjs',
    generated_at: new Date().toISOString().slice(0, 10),
    facts_as_of: inputs.facts_as_of,
    product_stage: inputs.product_stage,
    current_gate: inputs.current_gate,
    implementation_tracks: inputs.implementation_tracks,
    pilot_gate: {
      go: g.go,
      blockers: g.blockers.map((b) => `${b.id}:${b.reason ?? 'blocking'}`),
      start: g.startBlockerCount,
      pilot: g.pilotBlockerCount,
      scale: g.scaleBlockerCount,
      measurement: g.measurementBlockerCount,
      slo_measured: g.sloMeasuredCount,
      slo_total: g.sloMetricCount,
      residual: g.residualCount,
      unstated_reopen: g.unstatedReopenCount,
      command: PILOT_GATE_COMMAND,
    },
    production_prerequisites: inputs.production_prerequisites,
    rollout_scope_note: inputs.rollout_scope_note,
    customer_data_gate: {
      allowed: inputs.customer_data_blockers.length === 0,
      blockers: inputs.customer_data_blockers,
      note: inputs.customer_data_note,
    },
    migration: {
      tip_repo: tipRepo,
      tip_deployed: inputs.migration.tip_deployed,
      deployed_release: inputs.migration.deployed_release,
    },
    runtime_verified: inputs.runtime_verified.value,
    runtime_note: inputs.runtime_verified.reason,
    external_security_audit_done: inputs.external_security_audit_done.value,
    content_store: inputs.content_store.value,
    cloud_kms: inputs.cloud_kms.value,
    fact_evidence: factEvidence,
  };

  const json = JSON.stringify(status, null, 2) + '\n';
  return { json, md: renderMd(status), status };
}

// 漂移比对忽略 generated_at：它是生成日期，不是事实，跨日复跑不得判红。
export function normalizeForCompare(json) {
  const obj = JSON.parse(json);
  delete obj.generated_at;
  return JSON.stringify(obj, null, 2) + '\n';
}

function renderMd(s) {
  const pg = s.pilot_gate;
  const tracks = Object.entries(s.implementation_tracks).map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  const prereq = s.production_prerequisites.map((x) => `- ${x}`).join('\n');
  const cdBlockers = s.customer_data_gate.blockers.map((x) => `- ${x}`).join('\n');
  const evidence = Object.entries(s.fact_evidence)
    .map(([k, f]) => `| ${k} | ${f.verified_at} | ${f.evidence.map((p) => `\`${p}\``).join('、')} |`)
    .join('\n');
  return `# Work 当前状态

> 本文由 \`scripts/work-status.mjs\` 生成，勿手改。生产事实记录在 [status.inputs.json](status.inputs.json)（每项带证据引用）；动态门禁与仓库迁移 tip 由脚本现算。人工改状态请改 inputs 后重跑脚本。最近核实：**${s.facts_as_of}**（生成日期另见 status.json 的 \`generated_at\`，两者不同义）。

## 阶段

| 项 | 值 |
|---|---|
| 产品阶段 | ${s.product_stage} |
| 当前闸门 | ${s.current_gate} |
${tracks}

## 试点门禁（动态，现算）

\`go=${pg.go}\`，blockers：${pg.blockers.length ? pg.blockers.join(', ') : '无'}。

| start | pilot | scale | measurement | SLO | residual | unstatedReopen |
|---|---|---|---|---|---|---|
| ${pg.start} | ${pg.pilot} | ${pg.scale} | ${pg.measurement} | ${pg.slo_measured}/${pg.slo_total} | ${pg.residual} | ${pg.unstated_reopen} |

现取命令（仓库根）：

\`\`\`bash
${pg.command}
\`\`\`

读法：三档桶（start/pilot/scale）与测量面分开看；红可能只来自测量面（SLO 未实测）。**闸门绿≠已试点**，也≠残口为零。

## 生产前置条件

${prereq}

rollout 范围：${s.rollout_scope_note}

## 真实客户数据准入

**允许：${s.customer_data_gate.allowed ? '是' : '否'}**。阻断：

${cdBlockers}

${s.customer_data_gate.note}

## 迁移与部署

| 项 | 值 |
|---|---|
| 仓库迁移 tip | ${s.migration.tip_repo} |
| 现网迁移 tip | ${s.migration.tip_deployed} |
| 现网发布包 | ${s.migration.deployed_release} |

Runtime 已验证：${s.runtime_verified ? '是' : '否'}。${s.runtime_note}

Content Store：${s.content_store}。云 KMS：${s.cloud_kms}。外部安全审计已执行：${s.external_security_audit_done ? '是' : '否'}。

## 人工事实的证据引用

每项事实的核实日期与证据路径（脚本校验路径存在；完整 reason 见 status.json 的 \`fact_evidence\`）。

| 事实 | 核实日期 | 证据 |
|---|---|---|
${evidence}

## 入口

- 架构：[architecture.md](architecture.md) ｜ 安全：[security.md](security.md) ｜ 运维：[operations.md](operations.md)
- 决策：[decisions/](decisions/README.md) ｜ 项目索引：[work-project.md](work-project.md)
`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1]);
if (isMain) {
  const check = process.argv.includes('--check');
  const { json, md } = await generate();
  const jsonPath = join(WORK, 'status.json');
  const mdPath = join(WORK, 'status.md');
  if (check) {
    const curJson = readFileSync(jsonPath, 'utf8');
    const curMd = readFileSync(mdPath, 'utf8');
    if (normalizeForCompare(curJson) !== normalizeForCompare(json) || curMd !== md) {
      console.error('status drift: committed status.json/status.md differ from regeneration. Run: node scripts/work-status.mjs');
      process.exit(1);
    }
    console.log('status check: generated output matches committed files (generated_at ignored)');
  } else {
    writeFileSync(jsonPath, json);
    writeFileSync(mdPath, md);
    console.log('wrote docs/work/status.json and docs/work/status.md');
  }
}