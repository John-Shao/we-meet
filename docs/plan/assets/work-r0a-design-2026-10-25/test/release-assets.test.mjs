// The release package is a hand-written list of `cp` lines in
// src/work/deploy/ecs/make-release.sh - and a missing line is silent: the build succeeds,
// the tarball uploads, and the operator discovers on duty day that a file is not there.
// This happened on 2026-11-04: scripts/run-pilot-metrics.sh (the wrapper that supplies the
// four session settings pilot-metrics.sql needs) existed, was tested, and was simply not in
// the list, so the pilot report had no operator path on the host.
//
// Three narrow checks, chosen to encode that trap without pretending to know why the other
// ops scripts are deliberately not packaged (nine of them are intentionally unpackaged:
// superseded rollout/verify 0015/0016 pairs, make-release.sh itself, R0b provisioning, etc. -
// each is a human choice, so this test does not assert on it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORK_DIR = fileURLToPath(new URL('../../../../../src/work/', import.meta.url));
const RELEASE = join(WORK_DIR, 'deploy/ecs/make-release.sh');

const copySources = (() => {
  const text = readFileSync(RELEASE, 'utf8');
  const list = [...text.matchAll(/^cp "\$ROOT\/([^"]+)" "\$OUT\/"/gm)].map((m) => m[1]);
  return list;
})();

// #47 A delivered the C16 scanner from a second source root (the hardening asset dir), so the
// packager now has two lists. Both count as shipped, and both have to point at real files.
const ASSETS_DIR = fileURLToPath(new URL('../../work-r0a-hardening-2026-10-25/', import.meta.url));
const assetCopySources = (() => {
  const text = readFileSync(RELEASE, 'utf8');
  return [...text.matchAll(/^cp "\$ASSETS\/([^"]+)" "\$OUT\/"/gm)].map((m) => m[1]);
})();
const shippedNames = new Set([...copySources, ...assetCopySources].map((p) => p.split('/').pop()));

test('the second source root ships real files, not just a line in the list', () => {
  const missing = assetCopySources.filter((p) => !existsSync(join(ASSETS_DIR, p)));
  assert.deepEqual(missing, [], `make-release.sh copies ${assetCopySources.join(', ')} but these are absent from the assets dir: ${missing.join(', ')}`);
  assert.ok(
    assetCopySources.length >= 1,
    'the packager is expected to ship the C16 scanner from the assets dir (#47 A)',
  );
});

test('the packager copy list was parsed, so an empty list is not a pass', () => {
  assert.ok(
    copySources.length >= 15,
    `expected at least 15 'cp "$ROOT/…" "$OUT/"' lines in make-release.sh, found ` +
      `${copySources.length} - the regex and the script's quoting drifted apart`,
  );
});

test('every packaged path exists in the repo', () => {
  const missing = copySources.filter((rel) => !existsSync(join(WORK_DIR, rel)));
  assert.deepEqual(
    missing,
    [],
    `make-release.sh copies paths that no longer exist in the repo: ${missing.join(', ')} - ` +
      'the build would die on the release host, partway through, after the binaries are built',
  );
});

test('an operator wrapper is packaged together with the report it runs', () => {
  // run-x.sh and x.sql are one feature: the SQL needs four SET statements, and the wrapper
  // is the only thing that supplies them correctly. Shipping half of the pair is how the
  // "just run psql -f" gap came back.
  const scriptsDir = join(WORK_DIR, 'scripts');
  const present = readdirSync(scriptsDir);
  const problems = [];
  for (const file of present) {
    if (!file.endsWith('.sh') || !file.startsWith('run-')) continue;
    const twin = file.replace(/^run-/, '').replace(/\.sh$/, '') + '.sql';
    if (!present.includes(twin)) continue;
    for (const needed of [file, twin]) {
      if (!copySources.includes(`scripts/${needed}`)) {
        problems.push(`scripts/${file} pairs with scripts/${twin} but only one of them (` +
          `${needed}) is in the release copy list`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

// A packaged script that reads a repo file which the package does not deliver is the same
// bug in a quieter form: it works on a checkout and fails on the host. #47 found exactly one
// (work-c16-log-scan.sh wanted /tmp/work-log-scan.mjs, which nothing copied). Ruling A (2026-11-04,
// John) shipped that scanner and gave the script a candidate sequence, so this list is empty:
// any new referenced-but-unpackaged file now goes red instead of being explainable away.
const REFERENCED_NOT_PACKAGED = [];

test('packaged scripts only reference repo files that ship, or are listed with a reason', () => {
  const assetDirs = [
    new URL('../../', import.meta.url), // sibling asset dirs (hardening, runtime, ...)
  ];
  const findRepoFile = (basename) => {
    for (const dir of assetDirs) {
      for (const sub of readdirSync(dir)) {
        const candidate = new URL(`${sub}/${basename}`, dir);
        if (existsSync(fileURLToPath(candidate))) return fileURLToPath(candidate);
      }
    }
    const inWork = [join(WORK_DIR, 'scripts'), join(WORK_DIR, 'deploy/ecs')];
    for (const dir of inWork) {
      const candidate = join(dir, basename);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };

  const problems = [];
  let inspected = 0;
  let resolved = 0;
  for (const rel of copySources.filter((p) => p.endsWith('.sh'))) {
    const abs = join(WORK_DIR, rel);
    if (!existsSync(abs)) continue;
    inspected++;
    const text = readFileSync(abs, 'utf8');
    for (const match of text.matchAll(/([A-Za-z0-9_./-]+)\.(mjs|sql|json)\b/g)) {
      const basename = match[1].split('/').pop() + '.' + match[2];
      const repoFile = findRepoFile(basename);
      if (!repoFile) continue; // not a repo file (path is host-local by design)
      resolved++;
      const shipped = shippedNames.has(basename);
      const allowed = REFERENCED_NOT_PACKAGED.some(
        (entry) => entry.script === rel && entry.file === basename,
      );
      if (!shipped && !allowed) {
        problems.push(`${rel} reads ${basename}, which ships in neither the package nor the allow list`);
      }
    }
  }
  assert.ok(
    inspected >= 5 && resolved >= 1,
    `expected to inspect several packaged scripts and resolve at least one repo reference, ` +
      `got inspected=${inspected} resolved=${resolved} - the scan is looking at nothing`,
  );
  assert.deepEqual(problems, [], 'unaccounted host dependency in a packaged script');
});

test('packaged shell scripts parse', () => {
  const failures = [];
  for (const rel of copySources.filter((p) => p.endsWith('.sh'))) {
    const abs = join(WORK_DIR, rel);
    if (!existsSync(abs)) continue; // reported by the existence check above
    try {
      execFileSync('bash', ['-n', abs], { stdio: 'pipe' });
    } catch (error) {
      failures.push(`${rel}: ${(error.stderr?.toString() || error.message).trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(failures, [], 'bash -n rejected a script that ships in the release');
});

// #57 and L-C04-06 both came from the same shape of gap: a file that ships in the tarball but is
// never installed, so the operator's "it is right there" reasoning is true of the package and
// false of the host. The C16 re-run channel had exactly that - make-release.sh copied log-scan.mjs
// since ruling A, yet no rollout step installed it, and work-c16-log-scan.sh itself was never in
// the copy list at all, so the wrapper's "next to this script" candidate could not resolve.
// Asserting the whole chain, because any one of the three links being missing produces the same
// silent result.
test('the C16 re-run channel is packaged, installed and verified - not just copied', () => {
  const releaseText = readFileSync(RELEASE, 'utf8');
  const rolloutText = readFileSync(join(WORK_DIR, 'deploy/ecs/rollout-r0a-0027.sh'), 'utf8');
  const verifyText = readFileSync(join(WORK_DIR, 'deploy/ecs/verify-r0a-0027.sh'), 'utf8');

  const problems = [];
  for (const file of ['work-c16-log-scan.sh', 'log-scan.mjs']) {
    if (!new RegExp(`^cp "\\$(ROOT|ASSETS)/[^"]*${file.replace('.', '\\.').replace('\\.', '\\.')}[^"]*" "\\$OUT/"`, 'm')
      .test(releaseText)) {
      problems.push(`make-release.sh does not copy ${file}`);
    }
    if (!new RegExp(`install [^\\n]*\\b${file.replace('.', '\\.')}\\b`, 'm').test(rolloutText)) {
      problems.push(`rollout-r0a-0027.sh never installs ${file} - it would sit in the release dir only`);
    }
    if (!verifyText.includes(file)) {
      problems.push(`verify-r0a-0027.sh does not check ${file} in place`);
    }
  }
  assert.deepEqual(problems, [], 'the C16 scanner pair is not delivered end to end');

  // Non-vacuity: the three files this test reads are real, and the wrapper is in the copy list the
  // other checks parse, so a regex that stopped matching would surface here rather than as a pass.
  assert.ok(shippedNames.has('work-c16-log-scan.sh'), 'the wrapper is not in the parsed copy list at all');
  assert.ok(shippedNames.has('log-scan.mjs'), 'the scanner is not in the parsed shipped set at all');
});

// runbook §5.4 and the 2026-11-05 pilot write-authorization sheet both tell the operator to name the
// age identity as `WORK_BACKUP_IDENTITY=…`. The tree carried two copies of the drill: deploy/ecs
// honours that variable, the host copy (imported on 2026-11-05) hard-codes the 2026-10-29 path - and
// packaging the second one made both instructions silently ineffective on the host. The tie below is
// to the knob the docs command, so packaging a copy that lost it goes red instead of shipping a drill
// that cannot be pointed at a rotated recipient chain.
test('the packaged restore drill honours the identity knob the runbook commands', () => {
  const rel = copySources.find((p) => p.endsWith('work-db-restore-drill.py'));
  assert.ok(rel, 'the release must package work-db-restore-drill.py (#57 第二半)');
  const text = readFileSync(join(WORK_DIR, rel), 'utf8');
  assert.match(
    text,
    /os\.environ\.get\(\s*["']WORK_BACKUP_IDENTITY["']/,
    `${rel} must read WORK_BACKUP_IDENTITY - runbook §5.4 and the authorization sheet command it`,
  );
  assert.match(
    text,
    /work-offsite-20261029\.agekey/,
    `${rel} must keep the 2026-10-29 identity as the unset default, so the current path is unchanged`,
  );
});


// An increment that is in the manifest is applied by `work-migrate apply`, which reads the
// embedded manifest - so a new increment ships with zero attention on the deploy side. The
// verify script kept its hand-written (version, name) list at 0027 while the manifest moved to
// 0028, which is the same gap class as #47 and #57: the release does the thing and nothing on
// the host ever confirms it. Tie the two lists together so landing an increment without a
// verification line goes red here rather than as a clean rollout.
test('every published increment is confirmed by the verify script, not only by the manifest', () => {
  const manifest = JSON.parse(readFileSync(join(WORK_DIR, 'migrations/manifest.json'), 'utf8'));
  const increments = (manifest.increments || []).filter((entry) => entry.version >= 17);
  assert.ok(increments.length >= 12, `parsed ${increments.length} increments from 17 up, list parsing is broken`);

  const verifyText = readFileSync(join(WORK_DIR, 'deploy/ecs/verify-r0a-0027.sh'), 'utf8');
  const normalized = verifyText.replace(/\s+/g, ' ');
  // 锚在 SQL 的别名上，不锚在"missing in 17.."这种读数标签上：标签里带编号区间就会随链增长而过期，
  // 而过期的标签会让这条守卫认错块（2026-11-05 加 0029 时它就是这么红的）。
  assert.ok(
    normalized.includes('expected(version, name)'),
    'verify-r0a-0027.sh no longer carries the expected-ledger block this test reads',
  );

  const missing = increments
    .filter((entry) => !normalized.includes(`(${entry.version}, '${entry.name}')`))
    .map((entry) => `${entry.name}`);
  assert.deepEqual(missing, [], 'these published increments have no verification line in the rollout pair');
});

test('the rollout learns its chain tail from the package, not from a number copied into the script', () => {
  // 2026-11-05 (#78)：rollout-r0a-0027.sh 原先写死 `if ledger > 27 → abort`。0028 落地那天没人改它，
  // 于是现网（ledger=28）上这笔发布一进 preflight 就自杀，真实变更只能绕开发布脚本手工装 ——
  // 与 #47／#54 同一类缺口：发布链"打包／安装／校验"里"安装"那段停在旧编号上。
  // 现在链尾由 make-release 在构建期从 migrations/increments 算出、写成包内 MIGRATION_TAIL，
  // rollout 读它。这里把这个形状钉住：谁再退回字面量，或者打包时算不出链尾，都红。
  const releaseText = readFileSync(RELEASE, 'utf8');
  const rolloutText = readFileSync(join(WORK_DIR, 'deploy/ecs/rollout-r0a-0027.sh'), 'utf8');

  const increments = readdirSync(join(WORK_DIR, 'migrations/increments'))
    .map((name) => /^0*(\d+)_/.exec(name))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  assert.ok(increments.length >= 20, `只认出 ${increments.length} 个增量文件，这条断言在空转`);
  const realTail = Math.max(...increments);

  assert.match(releaseText, /MIGRATION_TAIL/, 'make-release 不再写 MIGRATION_TAIL，rollout 就无从判断这一包带到第几号');
  assert.match(releaseText, /exit 1/, '算不出链尾时 make-release 必须早失败，而不是产出没有链尾的包');
  // 锚在代码行上，不锚在整篇文本上：`migrations/increments` 出现在注释里不算数。
  // 2026-11-05 变异实测——把那行换成 `echo 27 > "$OUT/MIGRATION_TAIL"` 后，原来的整篇子串断言仍绿，
  // 因为我自己写的中文注释里就有这个路径。看守"链尾是从目录算出来的"这件事，必须由写它的那行代码满足。
  const writerLines = releaseText
    .split(/\r?\n/)
    .map((line, index) => [line.replace(/(^|[^"\\])#.*$/, '$1'), index + 1])
    .filter(([line]) => />[\s]*"\$OUT\/MIGRATION_TAIL/.test(line));
  assert.ok(writerLines.length >= 1, 'make-release 里没有写出 MIGRATION_TAIL 的代码行，这条断言在空转');
  for (const [line, number] of writerLines) {
    assert.match(
      line,
      /migrations\/increments/,
      `make-release.sh:${number} 写 MIGRATION_TAIL 的那行没从增量目录算链尾 - 链尾又退回抄来的常数了：${line.trim()}`,
    );
  }

  assert.match(rolloutText, /\$RELEASE\/MIGRATION_TAIL/, 'rollout 的 preflight 必须从包里读链尾');
  // 读取必须容忍"文件不存在"：脚本是 set -euo pipefail，`x="$(cat 缺失文件 2>/dev/null)"` 的退出码
  // 就是这条赋值行的退出码，会当场静默带走脚本 —— 2026-11-05 现网 dry-run 实测到就是这个形状，
  // 拒绝本身对了，但操作员只看到两行输出，看不到"包里没有链尾"这句话。
  const tailReads = rolloutText
    .split(/\r?\n/)
    .filter((line) => line.includes('cat') && line.includes('MIGRATION_TAIL'));
  assert.ok(tailReads.length >= 1, 'rollout 里没有读 MIGRATION_TAIL 的代码行，这条断言在空转');
  for (const line of tailReads) {
    assert.match(
      line,
      /\|\|\s*true/,
      `rollout 读链尾的那行不容忍缺失，缺文件时会静默退出而不是说明原因：${line.trim()}`,
    );
  }
  assert.match(rolloutText, /-gt\s+"\$chain_tail"/, 'ledger 比较的右边必须是包里的链尾变量');
  // 逐行核，不按整篇正则：`-gt 27` 与 `-gt "27"` 都得红，而一条拼错的整体正则会对两种形状都沉默
  // （2026-11-05 变异实测：写死 27 加引号后，原先那条 doesNotMatch 原地变绿）。
  const tailComparisons = rolloutText
    .split(/\r?\n/)
    .map((line, index) => [line, index + 1])
    .filter(([line]) => /-gt\s+\S/.test(line) && line.includes('current'));
  assert.ok(tailComparisons.length >= 1, 'rollout 里找不到 ledger 与链尾的那次比较，这条断言在空转');
  for (const [line, number] of tailComparisons) {
    assert.doesNotMatch(
      line,
      /-gt\s+"?\d+/,
      `rollout-r0a-0027.sh:${number} 又出现了写死的编号比较 - 这正是 0028 那天让发布脚本自杀的形状：${line.trim()}`,
    );
  }
  assert.match(rolloutText, /is missing or not a number/, '包里缺 MIGRATION_TAIL 时必须拒绝，而不是回落到旧编号');
  // 正向对照：脚本引用的那个文件名，必须就是 make-release 写出来的那个（拼错的路径只会静默中止）。
  const written = [...releaseText.matchAll(/>\s*"\$OUT\/([A-Z_]+)"/g)].map((m) => m[1]);
  assert.ok(written.includes('MIGRATION_TAIL'), `make-release 实际写出的清单里没有 MIGRATION_TAIL：${written.join(', ')}`);
  assert.ok(realTail >= 28, `链尾读数 ${realTail} 比已知发布（0028）还旧，读数不可信`);
});

// #78 的另一半：rollout 的编号闸改成从包里推之后，"校验"那一段还留着同一类字面量。
// verify-r0a-0027.sh 用一张 (version, name) 的 values 清单核账本，停在 17..28 —— 0029 落地那天
// 没人改它，现网就会"账本 max=29、清单里没有 29"，而 verify 照样报 none missing。
// 正向（manifest → verify）已由上面那条守卫钉住；这条补它没有的两半：清单里多出来的名字，
// 以及读数标签里再出现编号区间。
test('the verify script carries no stale increment list of its own', () => {
  const verifyText = readFileSync(join(WORK_DIR, 'deploy/ecs/verify-r0a-0027.sh'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(WORK_DIR, 'migrations/manifest.json'), 'utf8'));
  const published = manifest.increments
    .filter((entry) => entry.version >= 17)
    .map((entry) => `${entry.version}:${entry.name}`);

  const listed = [...verifyText.matchAll(/\((\d+),\s*'([A-Za-z0-9_]+)'\)/g)]
    .map((m) => `${Number(m[1])}:${m[2]}`)
    .sort();
  assert.ok(listed.length >= 10, `verify 里只认出 ${listed.length} 组 (version, name)，解析器在空转`);

  const extra = listed.filter((entry) => !published.includes(entry));
  assert.deepEqual(extra, [], `verify 里核了 manifest 没发布的增量名（会永远报 missing）：${extra.join(', ')}`);
  assert.doesNotMatch(verifyText, /missing in \d+\.\.\d+/, 'verify 的读数标签里又写死了编号区间');
});

// #79=B 的静态镜像守卫。真语义在 internal/authz/terminal_reservation_release_pg_test.go 的活库用例里，
// 那些用例在 CI 确实会跑（work-r0a-gates.yml:198-226 的 go-migrate job 设了 WORK_TEST_PG_URL 并跑
// go test ./... -p 1 -count=1）。这条仍然要有，理由是实在的两点：它在没有数据库的 ci-contract 路径上
// 几十毫秒就红，不必等一次带 PG 的 job；并且它把"范围只到 unknown"写成一句可引用的规则，而不是只藏在
// 增量文件的注释里——注释会被改写，断言不会。
// （本段原写的是"CI 不跑活库用例"，那是没取证的定性，11-05 23:1x 按 workflow 原文更正。）
// 只与代码比较：注释里出现同样的字符串不算满足——上一轮我自己就被"中文注释里有那个路径"骗过一次。
test('the release chain accounts for every binary in cmd once, by name', () => {
  // #54 的形状：cmd/ 有 13 个二进制，手抄的打包名单停在 11 个，于是演练前置 work-e2e-seed 从来没进过
  // 包（主机上只有一份 Oct 30 手工件，没有源提交、没有 checksum）。名单现在由构建期从 cmd/ 推，
  // 这条断言把"每个二进制恰好在运行时安装集或演练安装集里出现一次"钉成穷举：
  // 漏一个＝它进不了现网；重复一个＝安装路径有两处说法。
  const cmdNames = readdirSync(join(WORK_DIR, 'cmd'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(cmdNames.length >= 12, `只从 cmd/ 认出 ${cmdNames.length} 个二进制，枚举在空转`);

  const releaseText = readFileSync(RELEASE, 'utf8');
  const rolloutText = readFileSync(join(WORK_DIR, 'deploy/ecs/rollout-r0a-0027.sh'), 'utf8');
  const verifyText = readFileSync(join(WORK_DIR, 'deploy/ecs/verify-r0a-0027.sh'), 'utf8');

  // 打包侧必须从树里推，不许再手抄
  assert.match(releaseText, /ls "\$ROOT\/cmd"/, 'make-release 不再从 cmd/ 推二进制清单，名单会重新过期');
  assert.match(releaseText, />\s*"\$OUT\/BINARIES"/, 'make-release 必须把清单写进包里，rollout 才有可核对的声明');
  assert.match(rolloutText, /\$RELEASE\/BINARIES/, 'rollout 必须按包里的声明核文件，而不是按自己抄的名字');
  assert.match(verifyText, /work-e2e-seed/, 'verify 不报演练二进制，"装了没有"就又只剩口述');

  // 安装侧：rollout 里每一个 `for bin in …; do` 都算一条覆盖路径（常驻服务一条、演练工具一条）。
  // 按循环体形状去匹配会漏掉演练那条（它的下一行是 if 守卫），所以只看循环头。
  const loops = [...rolloutText.matchAll(/for bin in ([^;]+); do/g)].map((m) => m[1].trim().split(/\s+/).filter(Boolean));
  assert.ok(loops.length >= 2, '解析不到 rollout 的两条安装循环（常驻＋演练），这条断言在空转');
  const flattened = loops.flat();
  const installed = [...new Set(flattened)];
  const dupes = flattened.filter((n, i) => flattened.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `同一个二进制被两条安装循环覆盖：${dupes.join(', ')}`);
  // work-migrate 由第 4 步按名字单独装，不属于任何 for 循环
  const unaccounted = cmdNames.filter((n) => n !== 'work-migrate' && !installed.includes(n));
  assert.deepEqual(unaccounted, [], `cmd/ 里有二进制没有安装路径（进不了现网）：${unaccounted.join(', ')}`);
  assert.ok(installed.includes('work-e2e-seed'), '演练前置 work-e2e-seed 必须有自己的安装路径（#54 的那份手工件就是这么来的）');

  // 半径由脚本自己数并打印：文档里的"装 N 个二进制"活该过期（#54 之后 10→13，而那串数字当时正被
  // 拿去请授权）。这条断言要的是"计数与报数"这两个动作都还在，不是要它等于某个值。
  assert.match(rolloutText, /INSTALLED_BINARIES\+=\("\$name"\)/, 'install_binary 不再累加计数，收尾那行就会报零');
  assert.match(rolloutText, /INSTALLED_BINARIES\+=\("\$name"\)/, 'install_binary 不再累加计数，收尾那行就会报零');
  assert.match(rolloutText, /binaries this rollout \$RADIUS_MODE/, 'rollout 收尾不再自报半径，值班就只剩一个会过期的文档数字');

  // 现网侧的正反判别已用两个真库做过：装过 B 前一版的库报 FALSE、装过 B 版的报 true。
  // 这条断言守的是那个判别能力本身——探针要是缩回成"只认触发器在不在"，它就会给未裁的
  // blanket-release 版报绿，而那一版在这仓库的历史里真存在过（0029 的第一版）。
  const verifyProbe = readFileSync(join(WORK_DIR, 'deploy/ecs/verify-r0a-0027.sh'), 'utf8');
  assert.match(
    verifyProbe,
    /o\.state = ''unknown''/,
    "verify 的 0029 探针不再核 #79=B 的谓词 - 那它会给 B 前那一版报绿，判别力就没了",
  );
  assert.match(
    verifyProbe,
    /gate_state = ''receipt_recorded''/,
    'verify 探针缩回成模糊字符串就会被供应商注释喂饱 - 要核的是谓词原文',
  );
  assert.doesNotMatch(
    verifyProbe,
    /pg_get_functiondef\(h\.oid\) like '%unknown%'/,
    "探针里别再用 '%unknown%' 这种模糊匹配：prosrc 含注释，注释里出现过 'unknown' 就会误判为已收窄",
  );
});

test('increment 0029 keeps the #79=B scope and its privilege narrowing', () => {

  const sql = readFileSync(join(WORK_DIR, 'migrations/increments/0029_terminal_reservation_release.sql'), 'utf8');
  const code = sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  assert.ok(
    code.includes('CREATE OR REPLACE FUNCTION work.release_unreceipted_reservations'),
    '增量里没有那个 helper，这条断言在空转',
  );

  const helper = /CREATE OR REPLACE FUNCTION work\.release_unreceipted_reservations[\s\S]*?\n\$\$;/.exec(code);
  assert.ok(helper, '解析不到 release_unreceipted_reservations 的函数体');
  const body = helper[0];
  assert.match(body, /r\.state = 'held'/, '预留状态谓词不见了 - 不看 held 就等于对所有预留动手');
  assert.match(
    body,
    /o\.state = 'unknown'/,
    "#79=B 的收窄谓词不见了：0029 只回收 operation.state='unknown' 那一单，摘掉它＝退回 blanket release",
  );
  assert.match(body, /d\.gate_state = 'receipt_recorded'/, '回执反向豁免不见了 - 已记回执的用量是真发生过的，不能被自动撤');
  assert.doesNotMatch(body, /o\.state\s+IN\s*\(/, 'helper 用状态集合替掉了单值 unknown - 范围被放宽，要重裁 #79');

  const revokes = code
    .split(/\r?\n/)
    .filter((line) => /REVOKE ALL ON FUNCTION work\.(release_unreceipted_reservations|run_terminal_reservation_release)/.test(line));
  assert.equal(
    revokes.length,
    2,
    `新函数的 PUBLIC 撤权只剩 ${revokes.length} 行（应为 2）- 活库穷举守卫 function_privilege_sweep 会红，别把它当测试噪音`,
  );

  const trigger = /CREATE TRIGGER run_terminal_reservation_release[\s\S]*?EXECUTE FUNCTION/.exec(code);
  assert.ok(trigger, '解析不到那枚触发器');
  // 终态集合从 schema 枚举现读推导，不抄三个词：集合随枚举漂移是同一类错（演练清单那 5 行刚修过一次）
  const baseline = readFileSync(join(WORK_DIR, 'migrations/baseline/0002_initial_r0a_schema.sql'), 'utf8');
  const runTable = /CREATE TABLE work\.run \([\s\S]*?\n\);/.exec(baseline);
  assert.ok(runTable, '解析不到 work.run 的建表原文');
  const stateCheck = runTable[0].match(/state\s+text NOT NULL CHECK \(state IN \(([^)]*)\)\)/);
  assert.ok(stateCheck, '找不到 work.run.state 的 CHECK 约束原文 - 这条守卫就没有依据了');
  const enumVals = stateCheck[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.ok(enumVals.length >= 6, `只解析到 ${enumVals.length} 个 run.state 取值，解析器大概看错了行`);
  const nonTerminal = ['queued', 'active', 'waiting', 'cancel_requested'];
  assert.deepEqual(
    nonTerminal.filter((v) => !enumVals.includes(v)),
    [],
    '非终态集合与枚举不再一致 - 推导终态的前提变了，这条守卫要一起改',
  );
  const terminal = enumVals.filter((v) => !nonTerminal.includes(v)).sort();
  assert.equal(terminal.length, 3, `从枚举推出的终态有 ${terminal.length} 个（${terminal.join('/')}），与触发器的固定三值不符`);
  const whenStates = [...trigger[0].matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1])
    .filter((v) => enumVals.includes(v))
    .sort();
  assert.deepEqual(whenStates, terminal, `触发器 WHEN 集合 ${whenStates.join('/')} 不等于枚举推出的终态集合 ${terminal.join('/')}`);
});

// 发布包的两个自述过去各说各话：MIGRATION_TAIL 是工作树算出来的，RELEASE_COMMIT 是 HEAD 印出来的，
// 没人比过。2026-11-06 实测复现：包打印"chain ends at increment 32"，而同包的 commit 里没有
// 0030/0031/0032（0029 在）。rollout 于是按一个自己产不出来的数字决定装不装——
// 部署完回溯不到源码，正是 #54/#78 那一族缺口的又一面。这条守卫要的是"比较动作在场且不可空转"。
test('make-release refuses a chain tail its own stamped commit cannot produce', () => {
  const text = readFileSync(join(WORK_DIR, 'deploy/ecs/make-release.sh'), 'utf8');
  const code = text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  const headList = code.indexOf('ls-tree -r --name-only HEAD');
  const treeList = code.indexOf('.increments-in-tree');
  const refusal = code.indexOf('WORK_ALLOW_UNSTAMPED_MIGRATIONS');
  const build = code.indexOf('building binaries');
  assert.ok(headList > 0 && treeList > 0 && refusal > 0,
    'make-release 不再比对 HEAD 与工作树的增量清单 - 包可以声明一个自己产不出来的链尾');
  assert.ok(build > 0 && refusal < build && headList < build,
    '拒绝必须发生在构建二进制之前，否则脏树包照样被建出来，标记也就没人看');
  // 空转下限：comm 的两个输入必须是那两个列表文件；少一个就永远"无差异"地绿。
  assert.ok(code.includes('comm -13') && code.includes('.increments-in-commit'),
    'comm 必须同时吃 HEAD 列表与工作树列表 - 否则比较是装饰性的');
  // 判别力（2026-11-06 实测：只钉"三个标记在场"时，把 HEAD 侧的增量文件过滤条件删掉守卫仍绿）：
  // 两侧列表都必须**只收增量的 .sql**，否则一侧是全树、另一侧是目录名，比较恒不等或恒不等空。
  const lines = code.split('\n');
  const headAt = lines.findIndex((line) => line.includes('ls-tree -r --name-only HEAD'));
  const treeLine = lines.find((line) => line.includes('.increments-in-tree'));
  // shell 那行是折行的（续行符 \），所以 HEAD 侧要把它和后两行拼起来看，
  // 否则守卫会因为找不到"同一行里的过滤条件"而红——2026-11-06 我就被这个自造错过了一次。
  const headStatement = headAt >= 0 ? lines.slice(headAt, headAt + 3).join(' ') : '';
  const filter = String.raw`migrations/increments/.*\.sql$`;
  assert.ok(headStatement.includes(filter),
    'HEAD 侧列表没有过滤到增量的 .sql - 它会吃进整棵树，比较就此失真');
  assert.ok(treeLine && treeLine.includes('increments') && treeLine.includes(String.raw`\.sql$`),
    '工作树侧列表没有过滤到 .sql - 目录里的非增量文件会被当成缺失的增量');
});

// 上一条只证明"比较动作在场"。这一条把脚本真跑一次：造一个"包里有、stamped commit 里没有"的增量，
// 看它是否真的拒绝。做法是把 make-release.sh 复制进一个临时 git 仓库骨架里执行（脚本按自身位置推 ROOT），
// 因此既不碰真工作树，也不给并行测试留临时增量文件；GO_CONTAINER 显式给出，跳过容器匹配那一段，
// 让流程必须走到要测的对账上。2026-11-06 这一形状在本工作树真实发生过（链尾数到 32，而 commit 里没有 0030-0032）。
test('make-release really refuses an increment missing from its stamped commit', (t) => {
  const script = (dir, out) => {
    try {
      const stdout = execFileSync('bash', [join(dir, 'make-release.sh'), out], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GO_CONTAINER: 'stamp-gate-none', GO_WORKDIR: '/nowhere' },
      });
      return { rc: 0, stdout, stderr: '' };
    } catch (err) {
      return { rc: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
    }
  };
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });

  const root = mkdtempSync(join(tmpdir(), 'stampgate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deployDir = join(root, 'src', 'work', 'deploy', 'ecs');
  const incDir = join(root, 'src', 'work', 'migrations', 'increments');
  mkdirSync(deployDir, { recursive: true });
  mkdirSync(incDir, { recursive: true });
  copyFileSync(RELEASE, join(deployDir, 'make-release.sh'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'gate@example.invalid']);
  git(root, ['config', 'user.name', 'stamp gate']);
  writeFileSync(join(incDir, '0001_alpha.sql'), '-- one\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'one']);

  writeFileSync(join(incDir, '0002_beta.sql'), '-- two, deliberately uncommitted\n');
  const dirty = script(deployDir, join(root, 'out-dirty'));
  assert.notEqual(dirty.rc, 0,
    '脏树必须被拒绝；放过去就等于包可以声明一个自己 commit 产不出的链尾');
  assert.match(dirty.stderr, /NOT in the stamped commit/,
    '失败原因必须是那条对账，而不是 docker 或后面的步骤 - 否则这条红是环境红');
  assert.ok(dirty.stderr.includes('0002_beta.sql'), '必须点名那个未提交的增量');
  assert.ok(!/building binaries/.test(dirty.stdout + dirty.stderr),
    '拒绝必须发生在构建二进制之前，否则照样把包建出来');

  // 判别力的另一半：提交之后再跑，同一关必须放行（之后死在 docker 步骤是另一件事）。
  // 少了这一半，这条测试就只是"永远为真"的装饰。
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'two']);
  const clean = script(deployDir, join(root, 'out-clean'));
  assert.ok(!/NOT in the stamped commit/.test(clean.stdout + clean.stderr),
    '增量提交之后仍然拒绝 ⇒ 这条检查与 git 状态无关，是个假门');
});
