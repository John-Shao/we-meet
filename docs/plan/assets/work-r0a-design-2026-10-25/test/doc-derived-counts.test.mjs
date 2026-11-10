// 2026-11-10 主签裁定 J40＝A（窄）的机制落地（裁定原文见
// docs/plan/work-r0b-security-host-signoff-2026-10-31.md 的"2026-11-10 主签裁定：J40＝A"段）：
// 设计文档里的可穷举计数不再手抄——由本脚本从源头现算，并与散文里"由脚本穷举、当前值＝N
// （截至日期）"的标注值比对，不一致即红。当日复评证据：EV 门区间展开＝29（字面 token 按数法
// 可得 27/28/30，手抄必漂）；§9 null recovery_action＝32（现读 public 60，仍真，靠的是没人
// 新增 null 码而非机制）。本门就是那个机制：
//   1. 架构 §6.1"每片的证据门"行：EV token 按 en-dash（–）区间展开去重，与架构文档的
//      "EV 门数由脚本穷举、当前值＝N"标注比对；
//   2. src/work/contracts/error-codes.json 的 public 集里 recovery_action===null 的码数，
//      与控制面 §9"`none` 在目录里一律写作 null"行的标注比对（控制面文档只读，不在本任务编辑范围）。
// 防空集下限：解析不到任何 EV token／任何 public 码即红——空集合上的"相等"毫无意义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLAN_DIR = join(HERE, '..', '..', '..'); // docs/plan
const ARCH_DOC = join(PLAN_DIR, 'work-r0b-architecture-2026-10-30.md');
const CONTROL_DOC = join(PLAN_DIR, 'work-r0b-control-design-2026-10-30.md');
const CATALOG = join(PLAN_DIR, '..', '..', 'src', 'work', 'contracts', 'error-codes.json');

const archText = readFileSync(ARCH_DOC, 'utf8');
const controlText = readFileSync(CONTROL_DOC, 'utf8');
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));

// --- 源头 1：架构 §6.1 证据门行的 EV 集合（区间展开去重） ---
// 锚定清单本体那个 bullet（行首"- **每片的证据门"），不是任何提到该短语的散文——
// J40=A 的取数法标注里也会引用这个短语，按 includes 找会把标注行误读成清单行。
const gateLines = archText.split(/\r?\n/).filter((line) => /^- \*\*每片的证据门/.test(line));
assert.equal(gateLines.length, 1, `架构文档里"每片的证据门"行应当恰好一条，现读 ${gateLines.length} 条——锚点漂移或重复，先修文档再谈计数`);
const gateLine = gateLines[0];
// EV84–EV86 这类区间用 en-dash（U+2013）；单 token 与区间一并捕获，区间按闭区间展开。
const evTokens = [...gateLine.matchAll(/EV(\d+)(?:–EV(\d+))?/g)];
const evSet = new Set();
for (const match of evTokens) {
  const lo = Number(match[1]);
  const hi = match[2] ? Number(match[2]) : lo;
  assert.ok(hi >= lo, `证据门行出现倒序区间 EV${lo}–EV${hi}`);
  for (let n = lo; n <= hi; n += 1) evSet.add(n);
}
const evCount = evSet.size;

// 散文标注值（J40=A 改写后的规范锚点）："EV 门数由脚本穷举、当前值＝N（截至日期）"
const evProse = archText.match(/EV 门数由脚本穷举、当前值＝(\d+)/);

// --- 源头 2：错误目录 public 集的 null recovery_action 码数 ---
const publicEntries = Object.entries(catalog.public ?? {});
const nullCodes = publicEntries.filter(([, entry]) => entry.recovery_action === null).map(([code]) => code);
const nullCount = nullCodes.length;

// 控制面 §9 散文锚点（只读）：现行写法"`none` 在目录里一律写作 `null`（**N** 个码如此…）"；
// 也接受 J40=A 改写后的"当前值＝N"写法，两种都没有即红（锚点丢失不许静默绿）。
const nullLine = controlText.split(/\r?\n/).find((line) => line.includes('`none` 在目录里一律写作'));
const nullProse = nullLine
  ? (nullLine.match(/当前值＝(\d+)/) ?? nullLine.match(/`null`（\*{0,2}(\d+)/))
  : null;

test('防空集下限：两个源头都真的解析出了东西', () => {
  assert.ok(evTokens.length >= 15, `证据门行只解析到 ${evTokens.length} 个 EV token——正则或行锚点失效，空集上的比对会静默绿`);
  assert.ok(evCount >= 20, `EV 区间展开去重后只有 ${evCount} 个——区间展开或文档结构出了问题`);
  assert.ok(publicEntries.length >= 40, `error-codes.json 的 public 只解析到 ${publicEntries.length} 个码（当日复评现读 60）——目录搬家或解析失效`);
  assert.ok(nullLine, '控制面 §9 找不到"`none` 在目录里一律写作"行——散文锚点丢失');
  assert.ok(nullProse, '控制面 §9 该行解析不出计数（既无"（**N** 个码"也无"当前值＝N"）——锚点格式漂移');
  assert.ok(evProse, '架构文档找不到"EV 门数由脚本穷举、当前值＝N"标注——J40=A 改写锚点丢失');
});

test('架构 §6.1 的 EV 门数标注等于证据门行区间展开去重的现算值', () => {
  assert.ok(evProse, '架构文档的 J40=A 计数标注锚点丢失（见防空集下限）');
  assert.equal(
    Number(evProse[1]),
    evCount,
    `work-r0b-architecture-2026-10-30.md 标注 EV 门数＝${evProse[1]}，而"每片的证据门"行现算（en-dash 区间展开去重）＝${evCount}；改清单须同步改标注与截至日期`,
  );
  console.log(`EV gate enumeration: ${evTokens.length} literal tokens -> ${evCount} unique EVs (prose says ${evProse[1]})`);
});

test('控制面 §9 的 null recovery_action 码数标注等于错误目录 public 集的现算值', () => {
  assert.ok(nullProse, '控制面 §9 的计数锚点丢失（见防空集下限）');
  assert.equal(
    Number(nullProse[1]),
    nullCount,
    `work-r0b-control-design-2026-10-30.md §9 标注 null 码数＝${nullProse[1]}，而 src/work/contracts/error-codes.json public 集现算 recovery_action===null ＝${nullCount}（${nullCodes.join(', ')}）；新增/改码须同步改标注与截至日期`,
  );
  console.log(`null recovery_action enumeration: ${nullCount} of ${publicEntries.length} public codes (prose says ${nullProse[1]})`);
});