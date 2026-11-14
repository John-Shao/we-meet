// 生成 docs/work/status.json 与 status.md（方案 A 混合生成）。
// 动态部分现算：pilot_gate 来自 ops-model.goNoGo(checklist, slo)；migration.tip_repo 来自 manifest。
// 生产/决策事实来自 docs/work/status.inputs.json（人工记录，脚本无法从仓库推导）。
// 用法：node scripts/work-status.mjs [--check]
//   默认：写 status.json/status.md；--check：只校验已提交文件与生成结果一致（CI 用），不写。
import { readFileSync, writeFileSync } from 'node:fs';
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

  const status = {
    $schema_note: '由 scripts/work-status.mjs 生成，勿手改。生产事实在 status.inputs.json；动态门禁与仓库迁移 tip 现算。',
    generated_by: 'scripts/work-status.mjs',
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
    runtime_verified: inputs.runtime_verified,
    runtime_note: inputs.runtime_note,
    external_security_audit_done: inputs.external_security_audit_done,
    content_store: inputs.content_store,
    cloud_kms: inputs.cloud_kms,
  };

  const json = JSON.stringify(status, null, 2) + '\n';
  return { json, md: renderMd(status), status };
}

function renderMd(s) {
  const pg = s.pilot_gate;
  const tracks = Object.entries(s.implementation_tracks).map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  const prereq = s.production_prerequisites.map((x) => `- ${x}`).join('\n');
  const cdBlockers = s.customer_data_gate.blockers.map((x) => `- ${x}`).join('\n');
  return `# Work 当前状态

> 本文由 \`scripts/work-status.mjs\` 生成，勿手改。生产事实记录在 [status.inputs.json](status.inputs.json)；动态门禁与仓库迁移 tip 由脚本现算。人工改状态请改 inputs 后重跑脚本。最近核实：**${s.facts_as_of}**。

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
    if (curJson !== json || curMd !== md) {
      console.error('status drift: committed status.json/status.md differ from regeneration. Run: node scripts/work-status.mjs');
      process.exit(1);
    }
    console.log('status check: generated output matches committed files');
  } else {
    writeFileSync(jsonPath, json);
    writeFileSync(mdPath, md);
    console.log('wrote docs/work/status.json and docs/work/status.md');
  }
}