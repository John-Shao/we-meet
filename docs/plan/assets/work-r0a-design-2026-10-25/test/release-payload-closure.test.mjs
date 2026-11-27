// 2026-11-13 (batch B2, review finding #3). The release package used to be exactly as good as the
// hand-written `cp` list in make-release.sh. Measured before this change: `deploy/ecs` carried 20
// systemd units and 12 env templates, the list named 14 units and 10 templates, and no gate
// compared the two sets - so work-api/work-worker/work-relay/work-export units and
// work-content-backup.py / work-health-alert.py reached no package at all. The 2026-11-10
// deployment record (_archive/r0b-phase-closure-report-2026-11-10.md §3.3) logs the workaround:
// "补充缺失的文件到 release package，重新打包并上传" - files were hand-copied into one release
// directory, not into the packager, so the next build lost the same set again. That is visible on
// disk: the local work-release-* dirs contain 10 files make-release.sh cannot produce and omit 3
// it does copy.
//
// 【2026-11-13 卡片 W】那句"reached no package at all"点名的 work-content-backup.py 与其
// .service／.timer 两件，已按主签裁定从 deploy/ecs 删除：主机上那条每 6 小时的备份继续跑，仓库不再
// 持有它的出处（后果与执行边界写在 work-project.md 卡片 W 的同日裁定段）。本文件对 `.py` 后缀的正向
// 对照因此只剩 work-health-alert.py，而"删除是一笔决定、不是漂移"由下面那条缺席断言看守。
//
// 【2026-11-22 卡片 W 重开，主签 W1＝甲／W2＝甲／W3＝甲】上面这段的"已按主签裁定删除"照原文留着，但它
// 的前提今天过期：那笔删除当时记的理由是"备份执行体已废弃、仓库不该再持有它"，而现读显示主机那条每 6
// 小时的备份一直在跑、卡片自己的复评窗（2026-11-20）也已到期，所以"删掉出处"换不到任何安全收益，只把
// 一份含远端删除逻辑（RETENTION_DAYS=30）的执行体留在没有 diff 可评审的地方。三件已按 9bb50f94c~1 的
// blob 逐字节回植。于是本文件里对这三件的反向钉（"名字一复活就红"）翻成正向钉：仓库有文件、rollout
// 逐名装、verify 逐名报读数，外加 W2＝甲 的字节哈希钉。W2＝甲 只钉仓库侧——主机那份的哈希要靠现场
// 只读探针（verify 现在会把剥 CR 后的 sha16 一起报出来），没取到读数之前谁也不能声称两侧一致。
//
// What this guard pins: the package is a closure over the tree it is built from, ordered before
// SHA256SUMS so everything it adds has provenance, and every path a packaged unit or a rollout step
// reaches for is inside it. What it does NOT pin: whether the host has these files installed -
// packaging is not installing, and the install radius is a separate decision (work-project.md 卡片 W).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagedNames, parsePackager } from '../release-payload.mjs';

const ASSET_DIR = fileURLToPath(new URL('..', import.meta.url));
const WORK_DIR = fileURLToPath(new URL('../../../../../src/work/', import.meta.url));
const ECS = join(WORK_DIR, 'deploy/ecs');
const RELEASE = join(ECS, 'make-release.sh');
const ROLLOUT = join(ECS, 'rollout-r0a-0027.sh');
const DOC = join(ASSET_DIR, '..', '..', '..', 'work', 'decisions', 'open-rulings.md');

const parsed = parsePackager(readFileSync(RELEASE, 'utf8'));
// Comment lines describe intent; only code lines may satisfy a structural assertion. The sibling
// gate learned this on 2026-11-05 when its own Chinese comment about `migrations/increments`
// satisfied a whole-file substring check after the code stopped doing the work.
const inventory = readdirSync(ECS).filter((f) => /\.(service|timer|env\.example|py)$/.test(f));
const { packaged, byClosure } = packagedNames(inventory, parsed);
const binaries = new Set(readdirSync(join(WORK_DIR, 'cmd')));
const rolloutText = readFileSync(ROLLOUT, 'utf8');

test('the packager parses as a closure, not as a list that silently stopped growing', () => {
  // Every structural claim below depends on these four readings existing; checked first so a
  // rewritten packager fails with a reason instead of vacuously passing six later assertions.
  assert.ok(parsed.closureSuffixLine, 'make-release.sh has no `for suffix in …; do` loop - the list is hand-written again');
  assert.ok(
    parsed.closureSuffixes.length >= 4,
    `the closure walks only ${parsed.closureSuffixes.join(' ')} - expected .service .timer .env.example .py`,
  );
  assert.equal(parsed.assetLoop.length, 1, `the closure must walk the suffix glob exactly once, found ${parsed.assetLoop.length}`);
  assert.equal(parsed.closureCp.length, 1, `the closure must copy through exactly one code line, found ${parsed.closureCp.length}`);
  assert.ok(parsed.floor >= 10, `the closure floor is ${parsed.floor}, which an empty scan could clear`);
});

test('every unit, env template and host script in deploy/ecs reaches the package', () => {
  assert.ok(
    inventory.length >= parsed.floor,
    `deploy/ecs exposes ${inventory.length} unit/env/script files, below the packager's own floor ` +
      `${parsed.floor} - one side of this comparison is unreadable`,
  );
  const missing = inventory.filter((f) => !packaged.has(f));
  assert.deepEqual(missing, [], `these files are in deploy/ecs but no package can deliver them: ${missing.join(', ')}`);
  // Positive controls, one per mechanism: work-authz.service is in the hand list, and at least six
  // files must reach the package only through the closure - the set this batch found (four units,
  // two env templates, two host scripts). If the suffix loop ever stops matching, that count drops
  // and this goes red instead of the next build quietly shipping a short package.
  assert.ok(
    byClosure.length >= 6,
    `only ${byClosure.length} files depend on the closure (${byClosure.join(', ')}) - expected at least the ` +
      'six unpackaged units/templates and two host scripts this batch found',
  );
  assert.ok(parsed.explicitNames.has('work-authz.service'), 'expected work-authz.service in the explicit copy list');
  assert.ok(byClosure.includes('work-api.service'), 'work-api.service must be delivered by the closure, not the hand list');
  // 【2026-11-13 卡片 W】本行原为 `byClosure.includes('work-content-backup.py')`，用来断言 `.py`
  // 后缀在闭包内。主签裁定把 content-backup 三件（`.py`／`.service`／`.timer`）从 deploy/ecs 删除
  // （主机那一份继续跑，仓库不再给出处——执行边界见 work-project.md 卡片 W 的"执行边界"段），
  // `.py` 后缀这条机制改由下面 work-health-alert.py 那行负责。这里改钉"删除是一笔已裁的决定"：
  // 名字一复活就红，逼着回来重开卡片，而不是让包悄悄多带一条含远端删除逻辑（RETENTION_DAYS=30）的脚本。
  // 【2026-11-22 卡片 W 重开，W1＝甲】上一段的前因（"删除"是已裁决定、复活要先重开卡）今天走完了它自己的
  // 流程：卡片重开了，三件按历史 blob 逐字节回植。所以本行回到它 2026-11-13 之前的形状——正向钉在闭包里；
  // "含远端删除逻辑的脚本不能悄悄进包"这条担心改由下面的字节哈希钉接手：内容一变就红，比缺席断言更窄。
  assert.ok(
    byClosure.includes('work-content-backup.py'),
    'work-content-backup.py is in deploy/ecs but no package can deliver it - 卡片 W 重开后它靠闭包随包，不该再手抄',
  );
  assert.ok(byClosure.includes('work-health-alert.py'), 'the pager helper must be inside the closure');
});

// W2＝甲（主签 2026-11-22）：卡片 W 重开的三件钉仓库侧字节。为什么是哈希而不是"内容像不像"：这三件
// 里有一支会往对象存储写包并按 RETENTION_DAYS=30 删远端旧对象，一次改动的评审面应该是 diff，而 diff
// 的前提是"仓库里那份就是被执行的那份"。历史上它们被删掉之后再回植，最容易出的错是"回植成另一个样子"，
// 所以钉的是 9bb50f94c~1 那三个 blob 的 sha256，逐字节相等才算回植。
// 行尾口径（同一批现读出来的）：仓库 blob 是 LF（.py 2767 字节／73 行、CR 计数 0），主机手工那份是
// 2840 字节——差值恰为 73，即每行多一个 CR。所以比对主机侧必须先剥 CR：`tr -d '\r' < file | sha256sum`。
// 这三枚钉只覆盖仓库侧；主机那一份是否一致要靠现场只读取数（verify 现在把剥 CR 后的 sha16 一起报出来），
// 没有读数就没有"一致"这句话。
const CONTENT_BACKUP_BYTES = [
  ['work-content-backup.py', '393aae65d1ab82b18a75394c112081ba591cf7a9dc8d39ee37484702494fa31c', 2767],
  ['work-content-backup.service', '10917b2f0e17e3cb71aef29066351b520068a5b3e98b4dfd427abb49e7d6c759', 412],
  ['work-content-backup.timer', '575417c6927a808dfd637dbc7844c4b5361c015e462ec448eb913ac788323083', 230],
];

test('the re-opened content-backup trio is byte-identical to the deleted blobs', () => {
  for (const [name, sha, bytes] of CONTENT_BACKUP_BYTES) {
    const path = join(ECS, name);
    assert.ok(existsSync(path), `${name} is missing from deploy/ecs - 卡片 W 重开（W1＝甲）把它回植到这里`);
    const body = readFileSync(path);
    assert.equal(
      createHash('sha256').update(body).digest('hex'),
      sha,
      `${name} is not the 9bb50f94c~1 blob it was restored from - 回植要逐字节，改动请写明理由并换钉`,
    );
    assert.equal(body.length, bytes, `${name} is ${body.length} bytes, expected ${bytes}`);
    // CRLF 混进仓库就等于主机比对永远不一致（钉在 LF 上，主机那份是 CRLF 版）。
    assert.ok(!body.includes('\r'), `${name} carries CR bytes - the pin is on the LF blob, keep it LF`);
  }
});

test('a deliberate exclusion names a real file and carries a reason', () => {
  // The skip list is where a future "don't ship this one" has to be written down. An entry with no
  // reason, or for a file that no longer exists, is the same rot as the hand list in a nicer hat.
  for (const [name, reason] of Object.entries(parsed.skipReasons)) {
    assert.ok(existsSync(join(ECS, name)), `UNPACKAGED_DEPLOY_ASSETS names ${name}, which is not in deploy/ecs`);
    assert.ok(reason.trim().length >= 10, `${name} is excluded without a reason worth reading: "${reason}"`);
    assert.ok(
      !parsed.codeText.includes(`"$ROOT/deploy/ecs/${name}" "$OUT/"`),
      `${name} is both copied explicitly and listed as deliberately unpackaged`,
    );
  }
  // rollout installs a unit the moment it names one; an exclusion that rollout contradicts is a lie
  // in the packager, so this cross-check runs even while the list is empty.
  const installed = new Set(
    [...rolloutText.matchAll(/"\$RELEASE\/([A-Za-z0-9_.-]+)"\s+"\/etc\/systemd\/system\//g)].map((m) => m[1]),
  );
  const contradicted = Object.keys(parsed.skipReasons).filter((name) => installed.has(name));
  assert.deepEqual(
    contradicted,
    [],
    `rollout installs from $RELEASE files the packager claims not to ship: ${contradicted.join(', ')}`,
  );
});

test('the closure runs before SHA256SUMS, so everything it adds has provenance', () => {
  const sumLine = parsed.codeText && readFileSync(RELEASE, 'utf8')
    .split(/\r?\n/)
    .map((line, index) => [line, index + 1])
    .filter(([line]) => !/^\s*#/.test(line))
    .find(([line]) => /sha256sum/.test(line) && />SHA256SUMS/.test(line));
  assert.ok(sumLine, 'no SHA256SUMS step found - a packaged file would travel with no checksum at all');
  assert.ok(
    parsed.closureCp[0][1] < sumLine[1],
    `make-release.sh:${parsed.closureCp[0][1]} copies closure files AFTER make-release.sh:${sumLine[1]} writes ` +
      'SHA256SUMS, so those files ship unchecksummed - the #54 provenance hole, one layer down',
  );
});

test('SHA256SUMS covers hidden provenance metadata as well as visible payload files', () => {
  const checksumCode = readFileSync(RELEASE, 'utf8')
    .split(/\r?\n/)
    .map((line, index) => [line, index + 1])
    .filter(([line]) => !/^\s*#/.test(line))
    .find(([line]) => /sha256sum/.test(line) && />SHA256SUMS/.test(line));
  assert.ok(checksumCode, 'no SHA256SUMS writer found');
  assert.match(
    checksumCode[0],
    /find \. -maxdepth 1 -type f ! -name SHA256SUMS/,
    'checksum generation must include dotfiles such as .increments-in-tree while excluding SHA256SUMS itself',
  );
  assert.ok(
    checksumCode[1] > parsed.closureCp[0][1],
    'checksum generation must run after the deploy-asset closure',
  );
});

test('every script a packaged unit starts is delivered by the package', () => {
  // ExecStart is a host path, so a unit can be perfectly packaged while the thing it runs is not.
  // The example this batch found was work-content-backup.service naming
  // /opt/meet-db-backup/work-content-backup.py, which no release carried (that trio was deleted from
  // the tree the same day - 卡片 W). The live ones are work-healthcheck.service → work-health-alert.py
  // and, since the boot gate of 卡片 V, work-chain-check.service → /usr/local/bin/ecs-migrate.sh.
  const repoScriptNames = new Set([
    ...readdirSync(ECS),
    ...readdirSync(join(WORK_DIR, 'scripts')),
    ...readdirSync(join(WORK_DIR, 'node/bin')),
  ]);
  const unitFiles = readdirSync(ECS).filter((f) => /\.(service|timer)$/.test(f) && packaged.has(f));
  assert.ok(unitFiles.length >= 15, `only ${unitFiles.length} units count as packaged - the scan is looking at nothing`);
  const problems = [];
  let inspected = 0;
  for (const unit of unitFiles) {
    for (const line of readFileSync(join(ECS, unit), 'utf8').split(/\r?\n/)) {
      const exec = /^\s*Exec(?:Start|StartPre|StartPost|Stop|Reload)?=(.*)$/.exec(line);
      if (!exec) continue;
      for (const token of exec[1].trim().split(/\s+/)) {
        if (!/^\/(usr\/local\/bin|opt\/meet-db-backup)\//.test(token)) continue;
        const name = token.split('/').pop();
        inspected++;
        // Go binaries are accounted for by name in the sibling gate that enumerates cmd/, and
        // /usr/local/bin/node is a host interpreter with no repo file of that name.
        if (binaries.has(name) || !repoScriptNames.has(name)) continue;
        if (!packaged.has(name)) problems.push(`${unit} starts ${token}, which no package delivers`);
      }
    }
  }
  assert.ok(inspected >= 10, `expected to inspect a dozen ExecStart paths, got ${inspected} - the units were not read`);
  assert.deepEqual(problems, []);
  // The runtime server lives under /opt/work/runtime and arrives inside the Node tarball, not as a
  // loose file - checked here because ExecStart would otherwise look unsatisfied.
  assert.match(
    parsed.codeText,
    /tar -czf "\$OUT\/work-runtime\.tar\.gz" -C "\$ROOT\/node"[^\n]*\bbin\b/,
    'the Node bundle must still carry bin/ (work-runtime-server.mjs is ExecStart of work-runtime.service)',
  );
});

test('files rollout reads from the package are written by the packager', () => {
  // The 2026-11-10 failure direction: rollout asks for a path, the build never produced it, and the
  // operator fixes it by hand inside one release directory. Nothing in the repo noticed.
  const meta = new Set([
    'BINARIES', 'RELEASE_COMMIT', 'RELEASE_DIRTY', 'MIGRATION_TAIL', 'SHA256SUMS', 'UNSTAMPED_MIGRATIONS',
  ]);
  const referenced = [...new Set([...rolloutText.matchAll(/\$RELEASE\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]))]
    .filter((f) => !meta.has(f));
  assert.ok(referenced.length >= 15, `rollout references only ${referenced.length} payload files - the read is broken`);
  const missing = referenced.filter((f) => !packaged.has(f) && !binaries.has(f));
  assert.deepEqual(
    missing,
    [],
    `rollout reads $RELEASE/<file> that make-release.sh does not deliver: ${missing.join(', ')}`,
  );
});

test('the units with no repo carrier are exactly the registered list', () => {
  // work-directory-sync.service/.timer/-full.timer are started by rollout and enabled on the host,
  // yet no file in this repository describes them. That is a registered decision, not an oversight,
  // and it stays visible: adding such a file must go through this list, and the card that owns it.
  const NO_REPO_CARRIER = ['work-directory-sync.service', 'work-directory-sync.timer', 'work-directory-sync-full.timer'];
  const touched = new Set();
  for (const match of rolloutText.matchAll(/systemctl (?:start|enable|restart|stop)\s+([^\n|]+)/g)) {
    for (const token of match[1].split(/\s+/)) if (/^work-/.test(token)) touched.add(token);
  }
  assert.ok(touched.size >= 8, `rollout touches ${touched.size} named units - the systemctl scan is not reading`);
  for (const name of NO_REPO_CARRIER) {
    assert.ok(
      [...touched].some((t) => t === name || `${t}.timer` === name || `${t}.service` === name),
      `${name} is registered as no-carrier but rollout never asks systemd about it - drop it from the list`,
    );
    assert.ok(
      !existsSync(join(ECS, name)),
      `${name} now has a file in deploy/ecs, so a package can carry it - re-open 卡片 W and shrink this list`,
    );
  }
  const drift = [...touched].filter(
    (t) => /\./.test(t) && !NO_REPO_CARRIER.includes(t) && !packaged.has(t) && !existsSync(join(ECS, t)),
  );
  assert.deepEqual(drift, [], `units rollout asks about with neither a repo file nor a registration: ${drift.join(', ')}`);
  assert.match(readFileSync(DOC, 'utf8'), /\*\*卡片 W｜/, 'the no-carrier list has no card in work-project.md §5.0 to decide it');
});

// 卡片 W 的第二段（2026-11-13 分组裁定）：打包段闭合之后，安装段只补了 work-api.service 一支，
// 其余名字按裁定走 verify 的 present/MISSING 读数。这条守卫把"每个闭包名都得有一条可见性说法"钉成
// 机器断言：要么 rollout 逐名 install（字面名，不是 `$unit` 循环），要么 verify 逐名报读数。两头都
// 没有＝这个名字在包里静默旅行——那正是本卡登记的那段半径，"包里有"这句话从来覆盖不到它。
// 【2026-11-22 卡片 W 重开，主签 W1＝甲】下面这组名字当时的注册是"主机在跑、仓库无出处"，配的是三条
// 反向钉（文件不许回植、rollout 不许装、verify 必须报）。今天 W1＝甲 要的正是安装路径，所以注册翻成
// 正向：仓库有文件＋rollout 逐名装＋verify 逐名报读数，三条同时成立才算数。名单本身留着而不是删掉，
// 因为这条守卫的机制对这三件照旧适用，只是答案从"只有读数"变成"既装也报"；名字一被删，这段扫描就对
// 它们失去视野，那才是真的把状态变更藏起来。
const CONTENT_BACKUP_REINSTATED = [
  'work-content-backup.service', 'work-content-backup.timer', 'work-content-backup.py',
];

test('every file the closure delivers is installed by name or reported by verify', () => {
  const verifyText = readFileSync(join(ECS, 'verify-r0a-0027.sh'), 'utf8');
  // 安装侧只认字面名：`install … "$RELEASE/$unit" …` 那四条循环对本扫描不可见，所以这里数出来的
  // 就是"rollout 真的逐名装了"，不是"rollout 在某条循环里可能装"。
  const installedLiteral = new Set(
    [...rolloutText.matchAll(/install[^\n]*"\$RELEASE\/([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]),
  );
  assert.ok(
    installedLiteral.size >= 8,
    `rollout installs only ${installedLiteral.size} files by literal name - the scan is not reading`,
  );

  const lines = verifyText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('== deploy/ecs closure files'));
  assert.ok(start >= 0, 'verify-r0a-0027.sh no longer carries the 卡片 W closure section - the readings went away');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^echo "== /.test(lines[i])) { end = i; break; }
  }
  // 只与代码比较：这一段自己的中文注释里就写着 FAILURES 与 .example，留着注释断言就永远为真。
  const section = lines.slice(start, end).filter((line) => !/^\s*#/.test(line)).join('\n');
  const entries = [...section.matchAll(/"([A-Za-z0-9_.-]+):(\/[^"]+)"/g)].map((m) => ({ name: m[1], host: m[2] }));
  assert.ok(entries.length >= 8, `verify reports ${entries.length} closure names, expected at least 8 - the list is unreadable`);
  assert.match(section, /present \|\| echo MISSING/, 'the closure section does not print a present/MISSING verdict');
  // 报数不判负：这一段是部署状态。进了退出码就等于把"还没装"变成验收失败，而脚本末尾那条注释写的
  // 正是"未部署的打包件不进 FAILURES"（#54 的 drill 二进制同口径）。
  assert.doesNotMatch(section, /FAILURES/, 'the closure readings started moving the exit code - 卡片 W ruled report-only');
  // 读的必须是主机上的安装态路径：拿 `.example` 模板去 test -e 永远 present，是一条自我满足的读数。
  const selfFulfilling = entries.filter((e) => e.host.endsWith('.example')).map((e) => e.name);
  assert.deepEqual(selfFulfilling, [], `verify checks a template instead of the installed file: ${selfFulfilling.join(', ')}`);

  const reported = new Set(entries.map((e) => e.name));
  const unaccounted = byClosure.filter((n) => !installedLiteral.has(n) && !reported.has(n));
  assert.deepEqual(unaccounted, [], `closure files with neither an install line nor a verify reading: ${unaccounted.join(', ')}`);
  // 正向对照：卡片 V 的启动核对要有安装路径才到得了现网。只靠"全靠读数"也能让上面那条自洽通过，
  // 所以这三条逐名钉住（work-chain-check.service 与 ecs-migrate.sh 是它的前提，缺一个就起不来）。
  for (const name of ['work-api.service', 'work-chain-check.service', 'ecs-migrate.sh']) {
    assert.ok(
      installedLiteral.has(name),
      `rollout no longer installs ${name} by name - 卡片 V 的启动核对又只剩仓库里那一份`,
    );
  }

  // 回植的三件：仓库有出处、rollout 逐名装、verify 逐名报读数。缺任何一条就是"安装路径"这件事又回到
  // 手工放置那一格——W1＝甲 要的不是把文件放回目录，是让它有包、有装、有读数。
  for (const name of CONTENT_BACKUP_REINSTATED) {
    assert.ok(existsSync(join(ECS, name)), `${name} is gone from deploy/ecs again - 卡片 W 重开（W1＝甲）把它回植在这里`);
    assert.ok(
      installedLiteral.has(name),
      `rollout no longer installs ${name} by name - 三件又变成主机上那份没有 diff 可评审的手工件`,
    );
    assert.ok(reported.has(name), `verify stopped reporting ${name}, which the host runs on a six-hour timer`);
  }
  // 装的模式也要钉：这支 .py 读的是 OSS 存储凭据路径与收件人公钥，现网既有 0700 root:root（#57 的 drill
  // 同口径）。installedLiteral 只把名字从 install 行里抽出来，所以 0700 改成 0644 它看不见——这里补一条。
  assert.match(
    rolloutText,
    /^run install -m 0700 -o root -g root "\$RELEASE\/work-content-backup\.py" \/opt\/meet-db-backup\/work-content-backup\.py$/m,
    'the content-backup .py is no longer installed 0700 root:root - 现网既有模式，别在无人注意时放宽',
  );
  // "安装路径"包含这条 timer 真的被立起来：只装 unit 不 enable/start，按本包重建的主机上它是死的，而
  // 上面的逐名装、下面的 verify 读数与闭包门全都照样绿（2026-11-22 突变实测到的缺口，就地补上）。
  // 逐名钉而不是靠本文件那条 systemctl 扫描：扫描只把名字收进 touched，然后只对 NO_REPO_CARRIER 里
  // 登记过的名字提问，对"有仓库出处却没人 enable"这一类不作判断。
  for (const verb of ['enable', 'start']) {
    assert.ok(
      new RegExp(`^run systemctl ${verb} work-content-backup\\.timer$`, 'm').test(rolloutText),
      `rollout no longer runs \`systemctl ${verb} work-content-backup.timer\` - 三件装上了但那条 6 小时备份在新机上不会跑`,
    );
  }
  // W2＝甲 的取数口径：主机那份是 CRLF 版（.py 2840 字节 vs 仓库 2767，差值＝行数），所以 verify 报的
  // 哈希必须先剥 CR，否则和上面的字节钉、和仓库 blob 永远不可比。取不到文件时报短横而不是空输入的哈希，
  // 免得"MISSING"旁边跟着一串十六进制被读成一致。
  assert.match(section, /tr -d '\\r'/, "verify's content-backup readings no longer strip CR before hashing");
  assert.match(section, /sha256sum/, 'verify no longer hashes the host copies of the trio - 主机侧读数没了，一致性只能靠嘴说');
  // 还开着的那一格要能被机器看见，而不是只写在卡片的中文里：这支 .py 的执行体依赖仍在仓库外。
  const contentBackupPy = readFileSync(join(ECS, 'work-content-backup.py'), 'utf8');
  assert.match(contentBackupPy, /^import backup\b/m, 'the restored script no longer imports the host-only backup module');
  assert.ok(
    !existsSync(join(ECS, 'backup.py')),
    'deploy/ecs now carries backup.py - the out-of-repo dependency 卡片 W 重开时登记的那一格已闭合，改这条断言并更新卡片',
  );
  assert.match(readFileSync(DOC, 'utf8'), /执行边界（不得读宽）/, 'the deletion has no recorded execution boundary in 卡片 W');
});
