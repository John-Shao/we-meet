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
// What this guard pins: the package is a closure over the tree it is built from, ordered before
// SHA256SUMS so everything it adds has provenance, and every path a packaged unit or a rollout step
// reaches for is inside it. What it does NOT pin: whether the host has these files installed -
// packaging is not installing, and the install radius is a separate decision (work-project.md 卡片 W).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagedNames, parsePackager } from '../release-payload.mjs';

const ASSET_DIR = fileURLToPath(new URL('..', import.meta.url));
const WORK_DIR = fileURLToPath(new URL('../../../../../src/work/', import.meta.url));
const ECS = join(WORK_DIR, 'deploy/ecs');
const RELEASE = join(ECS, 'make-release.sh');
const ROLLOUT = join(ECS, 'rollout-r0a-0027.sh');
const DOC = join(ASSET_DIR, '..', '..', 'work-project.md');

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
  assert.ok(
    !inventory.includes('work-content-backup.py'),
    'work-content-backup.py is back in deploy/ecs - 卡片 W ruled it out of the repo, re-open the card before shipping it',
  );
  assert.ok(byClosure.includes('work-health-alert.py'), 'the pager helper must be inside the closure');
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
    .find(([line]) => /sha256sum \.\/\* >SHA256SUMS/.test(line));
  assert.ok(sumLine, 'no SHA256SUMS step found - a packaged file would travel with no checksum at all');
  assert.ok(
    parsed.closureCp[0][1] < sumLine[1],
    `make-release.sh:${parsed.closureCp[0][1]} copies closure files AFTER make-release.sh:${sumLine[1]} writes ` +
      'SHA256SUMS, so those files ship unchecksummed - the #54 provenance hole, one layer down',
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
const HOST_MANAGED_WITHOUT_REPO_CARRIER = [
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

  // 删除的三件：主机在跑、仓库无出处。注册要同时满足三条，任何一条变了都说明这段状态变了，回来重开卡。
  for (const name of HOST_MANAGED_WITHOUT_REPO_CARRIER) {
    assert.ok(!existsSync(join(ECS, name)), `${name} is back in deploy/ecs - 卡片 W ruled it out, re-open the card`);
    assert.ok(reported.has(name), `verify stopped reporting ${name}, which the host still runs with no repo carrier`);
    assert.ok(!installedLiteral.has(name), `rollout installs ${name} again - a new host unit is not this card's radius`);
  }
  assert.match(readFileSync(DOC, 'utf8'), /执行边界（不得读宽）/, 'the deletion has no recorded execution boundary in 卡片 W');
});
