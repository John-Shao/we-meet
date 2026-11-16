// 2026-11-14 文档重构：docs/work/ 下的短文档是阅读入口，本门防止它们引用不存在的事实。
// 不检查"文档是否完整复制代码"，只检查"文档是否引用了不存在的事实"：
//   1. status.json 可解析、含必需字段、last_verified_at 是有效日期；
//   2. 短文档里的相对链接都解析得到；
//   3. 短文档引用的 migration 版本号在 manifest 里存在；
//   4. 短文档引用的 /work/v1 API 路径在 OpenAPI 里存在；
//   5. 短文档引用的错误码来自 error-codes.json 的 public 集；
//   6. 当前 README 不把归档单篇当作权威引用（只允许 archive/ 索引）。
// 权威来源本身（manifest / OpenAPI / error-codes）从仓库现读，不手抄。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');
const WORK_DOCS = join(REPO, 'docs', 'work');
const ASSET = join(HERE, '..');
const MANIFEST = join(REPO, 'src', 'work', 'migrations', 'manifest.json');
const CATALOG = join(REPO, 'src', 'work', 'contracts', 'error-codes.json');
const OPENAPI = join(ASSET, 'r0a-openapi-v1.yaml');

// 短文档集合：docs/work 顶层 .md ＋ decisions/*.md（不含 design/ 与 archive/，它们另有门禁/属历史）。
function shortDocs() {
  const out = [];
  for (const name of readdirSync(WORK_DOCS)) {
    if (name.endsWith('.md')) out.push(join(WORK_DOCS, name));
  }
  const dec = join(WORK_DOCS, 'decisions');
  if (existsSync(dec)) for (const name of readdirSync(dec)) if (name.endsWith('.md')) out.push(join(dec, name));
  return out;
}
const DOCS = shortDocs();
const read = (f) => readFileSync(f, 'utf8');
const norm = (p) => p.split('\\').join('/');
const rel = (f) => posix.relative(norm(REPO), norm(f));

// GitHub 风格标题 slug（与 telemetry-model.mjs 同形）：小写、去标点、空白转连字符；重名追加 -N。
const slugify = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
function headingSlugs(text) {
  const counts = new Map();
  const slugs = new Set();
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      const base = slugify(h[1]);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      slugs.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const a of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) slugs.add(a[1]);
  }
  return slugs;
}
// 锚点校验语料＝短文档＋实现入口 src/work/README.md（它会带锚点引用 Work 文档）。
const ANCHOR_DOCS = [...DOCS, join(REPO, 'src', 'work', 'README.md')].filter((f) => existsSync(f));
// 代码路径否定语境：文档故意声明"某路径不存在"时不应被存在性校验误报。
const NEGATION = /不存在|尚未建|未建|尚未|未实现|没有|absent|not\s+exist|尚未存在/;

test('the short-doc corpus is non-empty (a broken scan must not pass vacuously)', () => {
  assert.ok(DOCS.length >= 6, `expected at least six short docs under docs/work, found ${DOCS.length}`);
  assert.ok(existsSync(MANIFEST) && existsSync(CATALOG) && existsSync(OPENAPI), 'authoritative sources missing');
});

test('status.json carries the split gate schema and a valid verification date', () => {
  const status = JSON.parse(read(join(WORK_DOCS, 'status.json')));
  for (const key of ['product_stage', 'current_gate', 'implementation_tracks', 'pilot_gate', 'production_prerequisites', 'customer_data_gate', 'migration', 'facts_as_of', 'generated_at', 'rollout_scope_note', 'fact_evidence']) {
    assert.ok(key in status, `status.json missing required field ${key}`);
  }
  assert.match(status.facts_as_of, /^\d{4}-\d{2}-\d{2}$/, 'facts_as_of must be YYYY-MM-DD');
  assert.ok(!Number.isNaN(Date.parse(status.facts_as_of)), 'facts_as_of is not a real date');
  // 生成日期与事实核实日期是两个字段，不得混为一谈（审查意见 6）。
  assert.match(status.generated_at, /^\d{4}-\d{2}-\d{2}$/, 'generated_at must be YYYY-MM-DD');
  assert.ok(!Number.isNaN(Date.parse(status.generated_at)), 'generated_at is not a real date');
  // issue 3：试点门禁 / 生产前置 / 客户数据准入三类分开，不混在一个 blocking 数组。
  assert.ok(Array.isArray(status.pilot_gate.blockers), 'pilot_gate.blockers must be an array');
  assert.ok(Array.isArray(status.production_prerequisites), 'production_prerequisites must be an array');
  assert.ok(Array.isArray(status.customer_data_gate.blockers), 'customer_data_gate.blockers must be an array');
  assert.equal(typeof status.customer_data_gate.allowed, 'boolean', 'customer_data_gate.allowed must be boolean');
  assert.ok(!('blocking' in status), 'the old mixed blocking array must be gone');
  assert.ok(/goNoGo\(c,\s*s\)/.test(status.pilot_gate.command), 'pilot_gate.command must call goNoGo(c, s)');
});

test('every manual fact carries evidence that exists in the repo (审查意见 5)', () => {
  const status = JSON.parse(read(join(WORK_DOCS, 'status.json')));
  const inputs = JSON.parse(read(join(WORK_DOCS, 'status.inputs.json')));
  const facts = ['runtime_verified', 'external_security_audit_done', 'content_store', 'cloud_kms', 'migration'];
  for (const name of facts) {
    const f = status.fact_evidence[name];
    assert.ok(f, `fact_evidence missing ${name}`);
    assert.ok(Array.isArray(f.evidence) && f.evidence.length > 0, `${name} has no evidence`);
    assert.ok(typeof f.reason === 'string' && f.reason.trim(), `${name} has no reason`);
    assert.match(f.verified_at, /^\d{4}-\d{2}-\d{2}$/, `${name}.verified_at must be a date`);
    assert.ok(f.verified_at <= status.facts_as_of, `${name}.verified_at is later than facts_as_of`);
    for (const p of f.evidence) assert.ok(existsSync(join(REPO, p)), `${name} evidence path missing: ${p}`);
    // inputs 与生成物不得各说一套：证据/日期逐项一致。
    const src = name === 'migration' ? inputs.migration : inputs[name];
    assert.deepEqual(f.evidence, src.evidence, `${name} evidence drifted from inputs`);
    assert.equal(f.verified_at, src.verified_at, `${name} verified_at drifted from inputs`);
  }
  // 标量字段仍是消费者读的那一份，值必须来自事实块的 value。
  assert.equal(status.runtime_verified, inputs.runtime_verified.value);
  assert.equal(status.external_security_audit_done, inputs.external_security_audit_done.value);
  assert.equal(status.content_store, inputs.content_store.value);
  assert.equal(status.cloud_kms, inputs.cloud_kms.value);
  assert.equal(status.migration.tip_deployed, inputs.migration.tip_deployed);
});

test('the generator refuses drifting manual facts (mutation controls)', async () => {
  const { validateInputs, normalizeForCompare } = await import(pathToFileURL(join(REPO, 'scripts', 'work-status.mjs')).href);
  const inputs = JSON.parse(read(join(WORK_DOCS, 'status.inputs.json')));
  const manifest = JSON.parse(read(MANIFEST));
  const tip = Math.max(...manifest.baseline.map((b) => b.version), ...manifest.increments.map((i) => i.version));
  const clone = () => JSON.parse(JSON.stringify(inputs));
  // 正对照：现 inputs 必须过。
  validateInputs(clone(), tip);
  // 现网 tip 领先仓库＝不可能事实。
  assert.throws(() => { const i = clone(); i.migration.tip_deployed = tip + 1; validateInputs(i, tip); }, /高于仓库 tip/);
  // 前置 ID 内嵌版本号＝会漂移的命名（0040-0045-rollout-authorization 的原病）。
  assert.throws(() => { const i = clone(); i.production_prerequisites.push('0040-0045-rollout-authorization'); validateInputs(i, tip); }, /不得内嵌迁移版本号/);
  // 证据路径不存在＝无来源的手工文本。
  assert.throws(() => { const i = clone(); i.runtime_verified.evidence = ['docs/work/definitely-absent.md']; validateInputs(i, tip); }, /证据路径不存在/);
  // 核实日期晚于 facts_as_of＝时间口径自相矛盾。
  assert.throws(() => { const i = clone(); i.cloud_kms.verified_at = '2099-01-01'; validateInputs(i, tip); }, /晚于 facts_as_of/);
  // 缺 rollout 范围注记＝前置改名后范围无处可查。
  assert.throws(() => { const i = clone(); delete i.rollout_scope_note; validateInputs(i, tip); }, /rollout_scope_note/);
  // generated_at 不参与漂移比对，其余字段参与。
  const a = JSON.stringify({ generated_at: '2026-11-16', facts_as_of: '2026-11-16', x: 1 });
  const b = JSON.stringify({ generated_at: '2026-11-17', facts_as_of: '2026-11-16', x: 1 });
  const c = JSON.stringify({ generated_at: '2026-11-16', facts_as_of: '2026-11-14', x: 1 });
  assert.equal(normalizeForCompare(a), normalizeForCompare(b), 'generated_at must not cause drift');
  assert.notEqual(normalizeForCompare(a), normalizeForCompare(c), 'substantive drift must still be caught');
});

test('status.json and status.md match the generator (no uncommitted drift)', async () => {
  const { generate, normalizeForCompare } = await import(pathToFileURL(join(REPO, 'scripts', 'work-status.mjs')).href);
  const { json, md } = await generate();
  assert.equal(normalizeForCompare(read(join(WORK_DOCS, 'status.json'))), normalizeForCompare(json), 'status.json drifted from generator; run node scripts/work-status.mjs');
  assert.equal(read(join(WORK_DOCS, 'status.md')), md, 'status.md drifted from generator; run node scripts/work-status.mjs');
});

test('short docs do not hardcode a stale migration inventory or tip (审查意见 1)', () => {
  const manifest = JSON.parse(read(MANIFEST));
  const inputs = JSON.parse(read(join(WORK_DOCS, 'status.inputs.json')));
  const tip = Math.max(...manifest.baseline.map((b) => b.version), ...manifest.increments.map((i) => i.version));
  const pad = (n) => String(n).padStart(4, '0');
  const offenders = [];
  for (const f of DOCS) {
    const text = read(f);
    // 入口 README 一律不写迁移版本号/范围，只指向 status.json（ADR 编号不算迁移版本）。
    if (f.endsWith('README.md') && /(?:增量|迁移)\s*00\d{2}/.test(text)) {
      offenders.push(`${rel(f)}: README 硬编码迁移版本/范围，应指向 status.json`);
    }
    // 任何"增量 0003–NNNN"式的清单范围，上界必须等于现链尾（已裁 rollout 包范围除外）。
    for (const m of text.matchAll(/增量\s*00\d{2}\s*[–-]\s*(00\d{2})/g)) {
      const line = text.split(/\r?\n/).find((l) => l.includes(m[0])) ?? '';
      if (/已裁|rollout 包|裁定/.test(line)) continue;
      if (m[1] !== pad(tip)) offenders.push(`${rel(f)}: 增量清单上界 ${m[1]} ≠ 仓库 tip ${pad(tip)}`);
    }
    // 仓库 tip 与现网 tip 的数字声明必须分别等于 manifest 与 inputs。
    for (const m of text.matchAll(/仓库(?:迁移)?\s*tip\s*[=＝]?\s*(\d+)/g)) {
      if (Number(m[1]) !== tip) offenders.push(`${rel(f)}: 仓库 tip ${m[1]} ≠ manifest ${tip}`);
    }
    for (const m of text.matchAll(/现网(?:迁移)?\s*tip\s*[=＝]?\s*(\d+)/g)) {
      if (Number(m[1]) !== inputs.migration.tip_deployed) offenders.push(`${rel(f)}: 现网 tip ${m[1]} ≠ inputs ${inputs.migration.tip_deployed}`);
    }
  }
  assert.deepEqual(offenders, [], `stale migration claims in short docs:\n${offenders.join('\n')}`);
  // 判别力正/负对照：机器本身有牙，不是空转。
  assert.ok(/status\.json/.test(read(join(WORK_DOCS, 'README.md'))), 'README must point at status.json for the tip');
  assert.ok(tip >= 40, `manifest tip ${tip} too low - derivation broke`);
});

test('every relative link in the short docs resolves to a real file or directory', () => {
  const broken = [];
  for (const f of DOCS) {
    const text = read(f);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const t = m[1];
      if (/^(https?:|mailto:|#|\/)/.test(t)) continue;
      const p = t.split('#')[0];
      if (!p) continue;
      let dec; try { dec = decodeURIComponent(p); } catch { dec = p; }
      if (!existsSync(resolve(dirname(f), dec))) broken.push(`${rel(f)} -> ${t}`);
    }
  }
  assert.deepEqual(broken, [], `broken links in short docs:\n${broken.join('\n')}`);
});

test('migration versions cited in the short docs exist in the manifest', () => {
  const manifest = JSON.parse(read(MANIFEST));
  const versions = new Set();
  const pad = (n) => String(n).padStart(4, '0');
  for (const b of manifest.baseline ?? []) versions.add(pad(b.version));
  for (const inc of manifest.increments ?? []) versions.add(pad(inc.version));
  assert.ok(versions.size >= 40, `manifest only yielded ${versions.size} versions - derivation broke`);
  const cited = new Set();
  for (const f of DOCS) for (const m of read(f).matchAll(/\b(00\d{2})\b/g)) cited.add(m[1]);
  const unknown = [...cited].filter((v) => !versions.has(v));
  assert.deepEqual(unknown, [], `short docs cite migration versions absent from manifest: ${unknown.join(', ')}`);
});

test('/work/v1 API paths cited in the short docs exist in the OpenAPI', () => {
  const yaml = read(OPENAPI);
  const templates = [...yaml.matchAll(/^ {2}(\/work\/v1\/[^:\s]*):/gm)].map((m) => m[1]);
  assert.ok(templates.length >= 20, `OpenAPI only yielded ${templates.length} v1 paths - derivation broke`);
  // 把模板的参数段归一成 {}，便于与文档里可能不同名的参数比对。
  const norm = (p) => p.replace(/\{[^}]+\}/g, '{}').replace(/\/$/, '');
  const known = new Set(templates.map(norm));
  const cited = new Set();
  for (const f of DOCS) for (const m of read(f).matchAll(/\/work\/v1\/[A-Za-z0-9{}/_*-]+/g)) cited.add(m[0]);
  const unknown = [...cited].filter((p) => {
    const n = norm(p);
    if (known.has(n)) return false;
    // 路径族/通配引用（如 /work/v1/admin/*）：只要 OpenAPI 有该前缀下的路径即合法。
    if (p.endsWith('/') || p.endsWith('*')) {
      const prefix = n.replace(/\/?\*$/, '').replace(/\/$/, '');
      return ![...known].some((k) => k === prefix || k.startsWith(prefix + '/'));
    }
    return true;
  });
  assert.deepEqual(unknown, [], `short docs cite v1 API paths absent from OpenAPI: ${unknown.join(', ')}`);
});

test('error codes cited as codes in the short docs come from error-codes.json public set', () => {
  const catalog = JSON.parse(read(CATALOG));
  const publicCodes = new Set(Object.keys(catalog.public ?? {}));
  assert.ok(publicCodes.size >= 40, `error-codes public only yielded ${publicCodes.size} codes - derivation broke`);
  const unknown = [];
  for (const f of DOCS) {
    for (const line of read(f).split(/\r?\n/)) {
      if (!/错误码|error code|错误码表/i.test(line)) continue;
      for (const m of line.matchAll(/`([a-z][a-z0-9_]+)`/g)) {
        const code = m[1];
        if (!publicCodes.has(code)) unknown.push(`${rel(f)}: ${code}`);
      }
    }
  }
  assert.deepEqual(unknown, [], `short docs cite error codes absent from error-codes.json: ${unknown.join(', ')}`);
});

test('the current README does not cite archived single docs as authority', () => {
  const readme = read(join(WORK_DOCS, 'README.md'));
  const offenders = [];
  for (const m of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
    const t = m[1].split('#')[0];
    if (!t.startsWith('archive/')) continue;
    // 允许归档目录索引（以 / 结尾）与各级 README；不允许把归档单篇 .md 当权威。
    if (t.endsWith('.md') && !t.endsWith('README.md')) offenders.push(t);
  }
  assert.deepEqual(offenders, [], `README cites archived single docs as authority: ${offenders.join(', ')}`);
});

test('anchor links in the Work doc surface resolve to real headings', () => {
  // 正/负对照：证明 slug＋匹配机器本身有牙——即使语料当前没有锚点链接，本条也不空转。
  const statusText = read(join(WORK_DOCS, 'status.md'));
  const control = headingSlugs(statusText);
  const firstHeading = statusText.split(/\r?\n/).find((l) => /^#{1,6}\s+/.test(l));
  const controlSlug = slugify(firstHeading.replace(/^#{1,6}\s+/, ''));
  assert.ok(control.has(controlSlug), 'positive control failed: slugify does not reproduce a real heading');
  assert.ok(!control.has('definitely-not-a-real-anchor-xyz'), 'negative control failed: slug set matches nonsense');
  assert.ok(ANCHOR_DOCS.length >= 7, `anchor corpus too small: ${ANCHOR_DOCS.length}`);
  const broken = [];
  for (const f of ANCHOR_DOCS) {
    for (const m of read(f).matchAll(/\]\(([^)\s]+)\)/g)) {
      const t = m[1];
      if (/^(https?:|mailto:)/.test(t)) continue;
      const [p, ...rest] = t.split('#');
      const anchor = rest.join('#');
      if (!p || !anchor) continue;
      let dec; try { dec = decodeURIComponent(p); } catch { dec = p; }
      const target = resolve(dirname(f), dec);
      if (!existsSync(target) || !target.endsWith('.md')) continue; // 文件存在性由链接那条管
      if (!headingSlugs(read(target)).has(anchor)) broken.push(`${rel(f)} -> ${t}`);
    }
  }
  assert.deepEqual(broken, [], `dangling anchors in Work doc surface:\n${broken.join('\n')}`);
});

test('backticked repo paths in the short docs exist (unless explicitly declared absent)', () => {
  const missing = [];
  let checked = 0;
  for (const f of DOCS) {
    for (const line of read(f).split(/\r?\n/)) {
      for (const m of line.matchAll(/`((?:src|docs|deploy|scripts|\.github)\/[^`]+)`/g)) {
        let p = m[1];
        if (/[*{]/.test(p)) continue; // glob / 模板
        if (/[–—]/.test(p) || /\d+[–-]\d+/.test(p)) continue; // 编号范围引用，非字面路径
        if (NEGATION.test(line)) continue; // 文档故意声明该路径不存在
        p = p.replace(/[:#].*$/, '').replace(/\/$/, '').replace(/[。，、）)]$/, '');
        checked++;
        if (!existsSync(join(REPO, p))) missing.push(`${rel(f)} -> ${p}`);
      }
    }
  }
  assert.ok(checked >= 50, `only ${checked} code paths checked - scan broke or corpus shrank`);
  assert.deepEqual(missing, [], `short docs cite repo paths that do not exist:\n${missing.join('\n')}`);
});

test('long design/ops docs keep valid relative links (light check, no prose pinning)', () => {
  // 长文不做 prose 钉扎，但至少链接必须有效——这是评审要求的"长文轻检查"。
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.md')) files.push(p);
    }
  };
  for (const sub of ['design', 'ops']) {
    const r = join(WORK_DOCS, sub);
    if (existsSync(r)) walk(r);
  }
  assert.ok(files.length >= 10, `long-doc corpus too small: ${files.length}`);
  const broken = [];
  let checked = 0;
  for (const f of files) {
    for (const m of read(f).matchAll(/\]\(([^)\s]+)\)/g)) {
      const t = m[1];
      if (/^(https?:|mailto:|#|\/)/.test(t)) continue;
      const p = t.split('#')[0];
      if (!p) continue;
      let dec; try { dec = decodeURIComponent(p); } catch { dec = p; }
      checked++;
      if (!existsSync(resolve(dirname(f), dec))) broken.push(`${rel(f)} -> ${t}`);
    }
  }
  assert.ok(checked >= 100, `only ${checked} long-doc links checked - scan broke`);
  assert.deepEqual(broken, [], `broken links in long design/ops docs:\n${broken.join('\n')}`);
});