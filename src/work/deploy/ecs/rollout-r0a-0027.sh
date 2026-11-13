#!/usr/bin/env bash
# Roll out Work R0a on the pilot host. The chain this package carries is not written here:
# it is read from MIGRATION_TAIL, which make-release.sh derives from the increments at build
# time (#78), so a hand-copied version number in this header would be a claim, not a reading.
#
# Non-additive changes inside this range, so they are not a surprise mid-window:
#   0017:164 drops NOT NULL on work.artifact_version.content_ref, because a
#          local_only version legitimately carries no cloud reference, and
#   0027:461 swaps work_audit_event_gap_skip_request from a plain index to a
#          UNIQUE one inside the same transaction that reads the existing rows.
# Step 1 asks about the duplicate case before anything is touched.
#
# Run as root. Every step is idempotent and every destructive step is preceded
# by a database dump. Use --dry-run first: it prints the exact commands.
#
# --migrations-only is the I-4a radius: it dumps, installs work-migrate (the chain is embedded
# in that binary), applies and reads back status, and installs the retention-scan pair so 0032's
# read-only orphan reading exists on the host. It stops nothing, restarts nothing, installs no
# other binary and touches no unit, so an in-flight workflow is never replayed under new code -
# which is why #81's bounded parks do NOT become live in this mode (that is I-4b).
#
#   MIGRATOR_DATABASE_URL='postgresql://work_migrator_login:...@127.0.0.1:5432/work' \
#   ./rollout-r0a-0027.sh --release /root/work-release-0027 \
#     [--enable-advance] [--migrations-only] [--runtime-bundle /root/work-runtime-0027.tar.gz] [--dry-run]
#
# The migrator URL is read from MIGRATOR_DATABASE_URL and nowhere else. It carries the migrator
# role's password, and a command-line flag would write that password into the host's process table
# (visible to every local user via ps), the shell history of whoever typed it, and any log that
# records argv - which is exactly how it was invoked before this script dropped --migrator-url.
#
# Rollback: restore the dump taken in step 2 and reinstall the .bak-<stamp>
# binaries. No increment in this range deletes a row, but the two relaxations and the
# index swap above are what to re-read before deciding rollback is cheaper than
# fixing forward.
set -euo pipefail

RELEASE=""
MIGRATOR_URL="${MIGRATOR_DATABASE_URL:-}"
ENABLE_ADVANCE=0
RUNTIME_BUNDLE=""
DRY_RUN=0
MIGRATIONS_ONLY=0
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR=/var/backups/work

usage() {
  sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      [[ $# -ge 2 ]] || { echo "missing value for --release" >&2; usage; }
      RELEASE="$2"; shift 2 ;;
    --migrator-url)
      # Kept as a named case so the old invocation fails with an instruction instead of the
      # generic "unknown flag", which would leave an operator guessing which spelling is current.
      echo "--migrator-url was removed: export MIGRATOR_DATABASE_URL instead" >&2
      echo "  (a URL on the command line is visible in ps to every local user for the whole run)" >&2
      usage ;;
    --runtime-bundle)
      [[ $# -ge 2 ]] || { echo "missing value for --runtime-bundle" >&2; usage; }
      RUNTIME_BUNDLE="$2"; shift 2 ;;
    --enable-advance) ENABLE_ADVANCE=1; shift ;;
    --migrations-only) MIGRATIONS_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown flag: $1" >&2; usage ;;
  esac
done

if [[ "$MIGRATIONS_ONLY" -eq 1 && "$ENABLE_ADVANCE" -eq 1 ]]; then
  echo "--migrations-only cannot be combined with --enable-advance: that flag's work lives after" >&2
  echo "   this mode's early exit, so accepting both would report an intent nothing performed." >&2
  exit 1
fi
if [[ "$MIGRATIONS_ONLY" -eq 1 && -n "$RUNTIME_BUNDLE" ]]; then
  echo "--migrations-only cannot be combined with --runtime-bundle: the Node runtime install also" >&2
  echo "   lives past the early exit. Pass it on the full rollout (I-4b)." >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
if [[ -z "$RELEASE" || ! -d "$RELEASE" ]]; then
  echo "--release <dir> is required" >&2
  exit 1
fi
if [[ -z "$MIGRATOR_URL" ]]; then
  echo "MIGRATOR_DATABASE_URL is not set, so there is no migrator URL to apply the chain with." >&2
  echo "It is read only as an environment variable (a command-line flag would land in ps," >&2
  echo "the shell history and any log of the invocation). Usage:" >&2
  echo "  export MIGRATOR_DATABASE_URL='postgresql://work_migrator_login:<password>@127.0.0.1:5432/work'" >&2
  echo "  ./rollout-r0a-0027.sh --release <release-dir> [--enable-advance] [--migrations-only] [--runtime-bundle <tar.gz>] [--dry-run]" >&2
  exit 1
fi
# Which binaries the package must carry is the package's own declaration (#54: a hand-copied list
# here froze at 11 while cmd/ has 13, so the drill's own seed binary was never shipped and never
# checked). A package that cannot state its contents is refused rather than silently half-installed.
if [[ ! -f "$RELEASE/BINARIES" ]]; then
  echo "aborting: $RELEASE/BINARIES is missing - rebuild the release with make-release.sh, which derives that list at build time" >&2
  exit 1
fi
pack_bin_count=0
while read -r bin; do
  [[ -n "$bin" ]] || continue
  # The name is used to build "$RELEASE/$bin" and later an install target under /usr/local/bin,
  # so a list entry like "../../etc/passwd" or "x y" would make the package decide what gets
  # written where. Refuse anything that is not a plain binary name before touching either path.
  if [[ ! "$bin" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "aborting: $RELEASE/BINARIES declares '$bin', which is not a plain binary name ([A-Za-z0-9_-]+)" >&2
    exit 1
  fi
  pack_bin_count=$((pack_bin_count + 1))
  [[ -f "$RELEASE/$bin" ]] || { echo "missing $RELEASE/$bin (declared by $RELEASE/BINARIES)" >&2; exit 1; }
done < "$RELEASE/BINARIES"
(( pack_bin_count >= 12 )) || { echo "aborting: $RELEASE/BINARIES declares $pack_bin_count binaries, expected at least 12" >&2; exit 1; }
echo "package declares $pack_bin_count binaries"
# If the package carries checksums (make-release.sh writes SHA256SUMS over the finished
# payload), verify them before anything is installed: a corrupted or tampered copy must
# fail here in preflight, not halfway through step 5. A missing file means an old package
# and is tolerated, the same policy as RELEASE_COMMIT below.
if [[ -f "$RELEASE/SHA256SUMS" ]]; then
  (cd "$RELEASE" && sha256sum -c SHA256SUMS) || { echo "ERROR: SHA256SUMS verification failed" >&2; exit 1; }
fi

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    # The migrator URL is passed in the environment; echoing it verbatim would
    # write the password into CI logs and terminal scrollback.
    printf 'DRY-RUN: %s\n' "${*//"$MIGRATOR_URL"/<redacted>}"
  else
    "$@"
  fi
}

ensure_group() {
  getent group work-control >/dev/null || run groupadd --system work-control
  id work-control >/dev/null 2>&1 || run useradd --system --gid work-control --home /var/lib/work --shell /usr/sbin/nologin work-control
}

ledger_max() {
  # A failed read used to be laundered into "0" by `|| echo 0`, which reads as "nothing has ever
  # been applied" - and every later comparison is then against a number this script invented. On
  # 2026-11-05 the probe could not answer at all and the rollout still walked on. No answer is now
  # a stop: the whole point of preflight is to know the starting ledger, so an unknown start is a
  # reason not to begin.
  local value
  if ! value="$(runuser -u postgres -- psql -d work -Atc "select coalesce(max(version),0) from work.schema_migration" 2>/dev/null)"; then
    echo "aborting: the ledger probe failed (psql as postgres could not read work.schema_migration);" >&2
    echo "  preflight cannot tell which chain is applied, so it will not guess" >&2
    return 1
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "aborting: the ledger probe returned '$value', which is not a version number" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

install_binary() {
  local name="$1"
  # The rollout radius is counted here, not copied into a document. Duty text said "装 10 二进制"
  # for weeks and it was still being quoted in an authorization request after #54 added the drill
  # binaries (13 now) - a number someone approves against a stale sentence is worse than no number.
  declare -ga INSTALLED_BINARIES
  INSTALLED_BINARIES+=("$name")
  if [[ -f "/usr/local/bin/$name" ]]; then
    run cp -p "/usr/local/bin/$name" "/usr/local/bin/$name.bak-$STAMP"
  fi
  run install -m 0755 -o root -g root "$RELEASE/$name" "/usr/local/bin/$name"
}

render_env() {
  local name="$1"
  local target="/etc/work/$name.env"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY-RUN: render $target from work-worker.env/work-api.env"
    return
  fi
  local worker_url content_key
  worker_url="$(sed -n 's/^WORK_DATABASE_URL=//p' /etc/work/work-worker.env | head -1)"
  content_key="$(sed -n 's/^WORK_CONTENT_MASTER_KEY=//p' /etc/work/work-api.env | head -1)"
  # Both values go to python3 through the environment, not argv: argv of a running process is
  # world-readable in /proc/<pid>/cmdline and in ps, so a dump of the process table during this
  # install would hand out the worker's database password and the content master key. The
  # environment of a root-owned process is readable by root only, which is who runs this.
  WORK_RENDER_DB_URL="$worker_url" \
  WORK_RENDER_CONTENT_KEY="$content_key" \
    python3 - "$target" "$name" <<'PYEOF'
import os, pathlib, re, sys
target, name = sys.argv[1:3]
worker_url = os.environ.get('WORK_RENDER_DB_URL', '')
content_key = os.environ.get('WORK_RENDER_CONTENT_KEY', '')
path = pathlib.Path(target)
text = path.read_text()
if name != 'work-runtime' and worker_url:
    text = re.sub(r'(?m)^WORK_DATABASE_URL=.*$', 'WORK_DATABASE_URL=' + worker_url, text)
if name in ('work-content-proxy', 'work-egress') and content_key:
    text = re.sub(r'(?m)^WORK_CONTENT_MASTER_KEY=.*$', 'WORK_CONTENT_MASTER_KEY=' + content_key, text)
path.write_text(text)
PYEOF
  if grep -q 'REPLACE_WITH' "$target"; then
    echo "unresolved placeholders in $target" >&2
    exit 1
  fi
  chown root:work-control "$target"
  chmod 640 "$target"
}

install_env() {
  local name="$1"
  local template="$RELEASE/$name.env.example"
  local target="/etc/work/$name.env"
  if [[ -f "$target" ]]; then
    echo "keep existing $target"
    return
  fi
  if [[ ! -f "$template" ]]; then
    echo "missing template $template" >&2
    exit 1
  fi
  run install -m 0640 -o root -g work-control "$template" "$target"
  echo "installed $target from template; review placeholders before starting"
}

echo "== 1. preflight =="
# ledger_max reports its own reason and returns non-zero; `set -e` would end the script there
# anyway, but this stays explicit so a future `set +e` around here cannot turn "unknown" into a
# silent pass with an empty $current.
if ! current="$(ledger_max)"; then
  exit 1
fi
echo "ledger currently at ${current:-0}"
# #78：这一包带到的链尾从包里读（make-release 构建期算好写进 MIGRATION_TAIL），不在此处抄数字。
# 先前这里是写死的 `> 27`：0028 落地那天没人改它，于是在 ledger=28 的现网上这笔发布
# 一进 preflight 就中止，真实变更只能绕开发布脚本手工装——保护语义没错，错在它不知道自己在跟谁比。
# 读不到不能让它把脚本带走：这里是 set -euo pipefail，`x="$(cat 缺失文件)"` 的退出码就是赋值行的
# 退出码，会在此处静默 exit 1 —— 操作员只看到两行输出，看不到"为什么拒绝"（2026-11-05 现网 dry-run 实测）。
# 所以先吞掉读失败，把判断交给下面那条显式的数字校验，让它把话说完再退出。
chain_tail="$( { cat "$RELEASE/MIGRATION_TAIL" 2>/dev/null || true; } | tr -d '[:space:]')"
if [[ ! "$chain_tail" =~ ^[0-9]+$ ]]; then
  echo "aborting: $RELEASE/MIGRATION_TAIL is missing or not a number - this package cannot prove which chain it carries" >&2
  echo "  rebuild it with make-release.sh (it derives the tail from the migration chain embedded in this package)" >&2
  exit 1
fi
echo "package chain ends at increment $chain_tail"
if [[ "${current:-0}" -gt "$chain_tail" ]]; then
  echo "database is ahead of this release (ledger $current, package chain ends at $chain_tail); aborting" >&2
  exit 1
fi
if [[ -f "$RELEASE/RELEASE_COMMIT" ]]; then
  echo "release built from commit $(cat "$RELEASE/RELEASE_COMMIT")"
else
  echo "WARN: $RELEASE/RELEASE_COMMIT is missing; these binaries have no recorded source commit" >&2
fi
# 出处要在这一步就被看见，而不是等人事后 `git show` 发现对不上：make-release 把打包时工作树的
# 脏路径数写进 RELEASE_DIRTY（统计范围＝包真正拷走的那些路径），这里原样打印。缺这个文件＝旧包，
# 按"不可归因"处理而不是当 0，因为沉默正是这次要修的那类缺陷。
if [[ -f "$RELEASE/RELEASE_DIRTY" ]]; then
  release_dirty="$(tr -d '[:space:]' < "$RELEASE/RELEASE_DIRTY")"
  if [[ "$release_dirty" =~ ^[0-9]+$ ]] && [[ "$release_dirty" != "0" ]]; then
    echo "WARN: $release_dirty packaged source path(s) were modified relative to $(cat "$RELEASE/RELEASE_COMMIT") - installed files may not match the stamped commit" >&2
  elif [[ "$release_dirty" =~ ^[0-9]+$ ]]; then
    echo "release tree clean against its recorded commit; packaged files reproducible"
  else
    echo "WARN: $RELEASE/RELEASE_DIRTY is not a number ('$release_dirty'); provenance of the packaged files is unknown" >&2
  fi
else
  echo "WARN: $RELEASE/RELEASE_DIRTY is missing; cannot tell whether packaged files match $(cat "$RELEASE/RELEASE_COMMIT" 2>/dev/null || echo 'the recorded commit')" >&2
fi
# 0027 builds a UNIQUE index over (org_id, metadata->>'request_id') for the
# governance_gap_skipped receipts, in the transaction that reads what is already there.
# Two receipts for one request id would fail the increment inside the window, so the
# question is asked before the dump is taken rather than after it.
# `|| echo probe-unavailable` used to stand here, and the next test only stopped on a number that
# was neither 0 nor that literal - so a probe that could not run printed its reason and the rollout
# carried on into the dump and the migration it was supposed to gate. A probe with no answer is a
# failed preflight, not an empty one.
if ! dupes="$(runuser -u postgres -- psql -d work -Atc "select count(*) from (
  select org_id, metadata ->> 'request_id' as rid from work.audit_event
  where action = 'governance_gap_skipped' group by 1, 2 having count(*) > 1) d" 2>/dev/null)"; then
  echo "aborting: the duplicate governance receipt probe failed (psql error); 0027 builds a UNIQUE" >&2
  echo "  index over this shape, so a probe that cannot answer must stop the rollout, not pass it" >&2
  exit 1
fi
echo "duplicate governance receipts: ${dupes}"
if [[ ! "$dupes" =~ ^[0-9]+$ ]]; then
  echo "aborting: the duplicate probe returned '$dupes', not a count" >&2
  exit 1
fi
if [[ "$dupes" != "0" ]]; then
  echo "aborting: 0027 would fail on ${dupes} duplicate request id(s); resolve them first" >&2
  exit 1
fi
# 卡片 V（#117，2026-11-13 裁定＝甲）＋卡片 W 的那一条安装步骤，从第 7 步起让 work-api 的每一次
# 启动（含人工 restart）都先跑一次链尾核对。核对要凭据，而凭据文件不是本轮装的——包里没有这支 unit
# ＝本行不生效；包里有了＝缺它就会让第 9 步 restart 直接把 API 打进 CrashLoop。所以"会砸 API 的
# 缺失"必须在动手之前拒绝，而不是在第 9 步之后被发现。判据按包自己声明的东西取，不抄路径常量。
if [[ -f "$RELEASE/work-chain-check.service" ]] && [[ ! -r /root/work-secrets.env ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "WARN: /root/work-secrets.env is missing or unreadable; a real run would abort here, because"
    echo "      this package carries work-chain-check.service and work-api would CrashLoop on restart"
  else
    echo "aborting: this package installs work-chain-check.service, which gates every work-api start," >&2
    echo "  but /root/work-secrets.env is missing or unreadable - the API would CrashLoop at step 9." >&2
    echo "  provision that file first; scripts/ecs-migrate.sh names the variables it reads." >&2
    exit 1
  fi
fi
df -h / | tail -1
systemctl is-active work-api work-relay work-worker || true

echo "== 2. database dump =="
run mkdir -p "$BACKUP_DIR"
DUMP="$BACKUP_DIR/work-pre-0027-$STAMP.dump"
TMP_DUMP="/tmp/work-pre-0027-$STAMP.dump"
# umask 077 is set on the writer, before pg_dump creates the file, so the dump is never briefly
# world-readable under /tmp. A chmod after the fact leaves a window (and a crash between the two
# leaves the whole database in a readable file indefinitely). The postgres-owned dump keeps 0600
# through the mv below because mv preserves the mode.
run sh -c 'umask 077; exec runuser -u postgres -- pg_dump -Fc -f "$1" work' sh "$TMP_DUMP"
run mv "$TMP_DUMP" "$DUMP"
run chmod 600 "$DUMP"
echo "dump: $DUMP"

echo "== 2b. in-flight runs =="
runuser -u postgres -- psql -d work -Atc "select state, count(*) from work.run where state in ('queued','active','waiting','cancel_requested') group by state" || true
echo "the new worker cannot resume legacy in-flight runs; drain or accept their loss before --enable-advance"

if [[ "$MIGRATIONS_ONLY" -eq 1 ]]; then
  # I-4a. Why this branch exists at all: before it, "apply the chain without restarting the worker"
  # had no entry point in the release chain, so doing it meant hand-running work-migrate on the
  # host - the #47/#54/#78 hole again, just moved from packaging to installation. The chain travels
  # inside work-migrate (migrations/embed.go), so exactly one binary must be installed here.
  echo "== 3m. migrations-only: apply the chain, touch no running unit =="
  install_binary work-migrate
  run env WORK_DATABASE_URL="$MIGRATOR_URL" /usr/local/bin/work-migrate apply --legacy-migrator-disabled
  run env WORK_DATABASE_URL="$MIGRATOR_URL" /usr/local/bin/work-migrate status
  # 0032's read-only orphan reading needs the wrapper AND the SQL, installed as a pair into the same
  # directory: the wrapper looks for the SQL by dirname $0, and only one of them is a silent no-op.
  run install -m 0755 -o root -g root "$RELEASE/run-retention-scan.sh" /usr/local/bin/run-retention-scan.sh
  run install -m 0644 -o root -g root "$RELEASE/retention-scan.sql" /usr/local/bin/retention-scan.sql
  install_env work-retention-scan
  # Read the tail the same tolerant way the preflight does (set -euo pipefail kills a bare
  # `x="$(cat missing)"` with no message), then refuse if it is not a number.
  chain_tail="$( { cat "$RELEASE/MIGRATION_TAIL" 2>/dev/null || true; } | tr -d '[:space:]')"
  if ! [[ "$chain_tail" =~ ^[0-9]+$ ]]; then
    echo "migrations-only aborted: $RELEASE/MIGRATION_TAIL is missing or not a number - this package cannot say which chain it carries" >&2
    exit 1
  fi
  echo "migrations-only: this package carries chain tail $chain_tail"
  echo "MIGRATIONS-ONLY DID NOT: stop or restart work-worker, work-relay, work-export or work-api;"
  echo "MIGRATIONS-ONLY DID NOT: install any other binary (work-worker in particular);"
  echo "MIGRATIONS-ONLY DID NOT: render runtime env, install or reload service units, or start/enable timers."
  echo "consequence: #82 (0030) and #80 (0031/0032) take effect now, because the running binaries"
  echo "  already call those functions; #81's bounded reconcile parks do NOT - they are Go-side"
  echo "  workflow code and need the worker swap, which is I-4b and carries runbook §5.32's replay preflight."
  exit 0
fi

echo "== 3. stop writers =="
for unit in work-directory-sync.timer work-directory-sync-full.timer work-directory-sync.service work-worker work-relay work-export; do
  run systemctl stop "$unit" 2>/dev/null || true
done
# 0017/0027 reshape tables the API reads and writes, so it must not serve during the
# migration window. Stopped here after the writers and restarted right after step 4,
# bounding the outage to the migration itself instead of the whole rollout.
run systemctl stop work-api || true

echo "== 4. migrate =="
install_binary work-migrate
run env WORK_DATABASE_URL="$MIGRATOR_URL" /usr/local/bin/work-migrate apply --legacy-migrator-disabled
run env WORK_DATABASE_URL="$MIGRATOR_URL" /usr/local/bin/work-migrate status
# Migration is done: bring the API back now, still on the old binary, so the outage lasts
# only the migration window. Step 9 restarts it again to load the freshly installed binary.
run systemctl restart work-api

echo "== 5. binaries =="
for bin in work-api work-relay work-worker work-authz work-content-proxy work-egress work-directory-sync work-reconcile work-export work-provider-setup; do
  install_binary "$bin"
done
# Drill-side binaries. They are installed only because the package now declares them: the host copy
# of work-e2e-seed was hand-placed on 2026-10-30 and no release ever carried it (#54), which is how
# a drill prerequisite ended up with no source commit and no checksum. Replacing that file is a
# production write, so it happens here, under a rollout, and the sha goes into the log - not
# silently at build time. Nothing in this step runs them.
for bin in work-e2e-seed work-replay; do
  if [[ -f "$RELEASE/$bin" ]]; then
    install_binary "$bin"
  else
    echo "note: $bin is not in $RELEASE - skipping (the service units do not need it)"
  fi
done

echo "== 6. service account, PKI, env =="
ensure_group
run mkdir -p /var/lib/work/runtime /var/lib/work/content
run chown -R work-control:work-control /var/lib/work
if [[ ! -f /etc/work/runtime-ca/ca.crt ]]; then
  run bash "$RELEASE/init-workload-pki.sh"
else
  echo "keep existing workload CA"
fi
install_env work-authz
install_env work-content-proxy
install_env work-egress
render_env work-authz
render_env work-content-proxy
render_env work-egress

echo "== 7. units =="
for unit in work-authz work-content-proxy work-egress; do
  run install -m 0644 -o root -g root "$RELEASE/$unit.service" "/etc/systemd/system/$unit.service"
done
# 卡片 W（#118）分组裁定＝十个闭包名字里只给 work-api.service 补安装步骤，其余走 verify 的
# present/MISSING 读数。这一步同时是卡片 V 甲的硬前置：只改仓库那份 unit 到不了现网。
# work-api.service 与它 Requires= 的那支闸、闸的 ExecStart 指向的那支包装件必须同批落——unit 装上
# 了而它调用的 helper 没装上，正是本卡登记的那一格（现网三份手工件都在，缺的是"按本包重建的主机"）。
# 现网那份 unit 与仓库那份剥 CR 后只差 ProtectHome 的行序（2026-11-13 现读），语义相同；本轮写进去
# 的语义变化只有链尾核对这一条，所以覆盖前留 .bak（与 install_binary 同法），给 runbook 的回滚窗口
# 一个具体对象。restart 不在这里：第 9 步的重启才发生在链尾已 apply 之后。
if [[ -f /etc/systemd/system/work-api.service ]]; then
  run cp -p /etc/systemd/system/work-api.service "/etc/systemd/system/work-api.service.bak-$STAMP"
fi
# 两条 install 逐名写，不用 for 循环：门按字面名核对"unit 调用的东西 rollout 装不装"，循环里的
# $unit 展开后门看不见（卡片 W 的教训就是"看得见"本身要机器可核）。
run install -m 0644 -o root -g root "$RELEASE/work-api.service" /etc/systemd/system/work-api.service
run install -m 0644 -o root -g root "$RELEASE/work-chain-check.service" /etc/systemd/system/work-chain-check.service
run install -m 0755 -o root -g root "$RELEASE/ecs-migrate.sh" /usr/local/bin/ecs-migrate.sh
run systemctl daemon-reload
run systemctl enable work-authz work-content-proxy work-egress
# work-api 在现网早已 enabled＋active（unit 是初次装机手工放的）；这里的 enable 是为了按本包重建的
# 主机也能开机带出它与它的闸（闸无 [Install]，由 work-api 的 Requires= 拉起来）。
run systemctl enable work-api
# restart, not start: step 3 never stops these units, so `start` would be a
# no-op and the freshly installed binaries would sit on disk unused.
run systemctl restart work-authz work-content-proxy work-egress

# #50 A (2026-11-04): the read-only orphan scan ships in the release payload but was never
# wired on any host, so reconcile visibility depended on someone remembering to run it.
# Install and schedule it here so a rebuild of the host does not lose it again. The scan
# unit is read-only (-scan cannot be combined with write actions, cmd/work-reconcile).
run install -m 0755 -o root -g root "$RELEASE/work-reconcile-scan.sh" /usr/local/bin/work-reconcile-scan.sh
for unit in work-reconcile-scan.service work-reconcile-scan.timer; do
  run install -m 0644 -o root -g root "$RELEASE/$unit" "/etc/systemd/system/$unit"
done
install_env work-reconcile-scan
run install -m 0755 -o root -g root "$RELEASE/work-healthcheck.sh" /usr/local/bin/work-healthcheck.sh
run install -m 0644 -o root -g root "$RELEASE/work-healthcheck.service" /etc/systemd/system/work-healthcheck.service
run install -m 0644 -o root -g root "$RELEASE/work-healthcheck.timer" /etc/systemd/system/work-healthcheck.timer
# D4 裁定＝B（主签 2026-11-05，节奏每小时）：留存清扫从"文档指挥、机器上没有执行者"变成有 unit 的活儿。
# 装在这几行而不是后面的脚本段，是因为 daemon-reload／enable 紧接在后面——unit 晚于它就等于本轮不生效。
# 包装件与 SQL 同目录安装（脚本按 dirname $0 找 SQL，少一个是空跑）；env 模板只放组织清单，
# 口令仍复用 /etc/work/work-worker.env（清扫函数的 GRANT EXECUTE 只给 work_worker）。
run install -m 0755 -o root -g root "$RELEASE/run-retention-scan.sh" /usr/local/bin/run-retention-scan.sh
run install -m 0644 -o root -g root "$RELEASE/retention-scan.sql" /usr/local/bin/retention-scan.sql
for unit in work-retention-scan.service work-retention-scan.timer; do
  run install -m 0644 -o root -g root "$RELEASE/$unit" "/etc/systemd/system/$unit"
done
install_env work-retention-scan
run systemctl daemon-reload
run systemctl enable work-reconcile-scan.timer work-healthcheck.timer work-retention-scan.timer
run systemctl start work-reconcile-scan.timer
run systemctl start work-healthcheck.timer
run systemctl start work-retention-scan.timer

# C17 最小集（2026-11-04 主签选 C）：库侧只读巡检补上 Temporal 侧孤儿规则看不见的那一类
# ——workflow 仍 Running、activity 停在 STARTED、库侧租约已过期的「停放 Run」，以及挂在已终态
# Run 上未释放的预留。包装件与 SQL 必须同目录（脚本按 dirname $0 找 SQL），少一个就是空跑。
run install -m 0755 -o root -g root "$RELEASE/run-runstream-gauges.sh" /usr/local/bin/run-runstream-gauges.sh
run install -m 0644 -o root -g root "$RELEASE/runstream-gauges.sql" /usr/local/bin/runstream-gauges.sql
# C16 复跑通道成对安装：包装脚本按 dirname $0 找 log-scan.mjs，两个都落在 /usr/local/bin 才自洽，
# 不再依赖 /tmp 里那份手工放置的副本。
run install -m 0755 -o root -g root "$RELEASE/work-c16-log-scan.sh" /usr/local/bin/work-c16-log-scan.sh
run install -m 0644 -o root -g root "$RELEASE/log-scan.mjs" /usr/local/bin/log-scan.mjs
# #96 C1（2026-11-07）：canary 机制本来就在跑、正控也真的 fire 过，但主机上 c16/log-scan 定时器数
# 实测为 0，所以带真实用户内容的正文检测只在有人手跑时发生。这里给它一个执行者；扫描规则一行未动。
# unit 以 root 跑，因为 canary 来源是 `sudo -u postgres psql`（work_api 在 RLS 下会读到 0 条标题），
# 理由与 ProtectSystem 的取值都写在 unit 注释里。
for unit in work-c16-log-scan.service work-c16-log-scan.timer; do
  run install -m 0644 -o root -g root "$RELEASE/$unit" "/etc/systemd/system/$unit"
done
# D 段（D4-6b 留存清扫预检）成对安装：包装脚本按 dirname $0 找 SQL，两个都落在 /usr/local/bin
# 才自洽；此前那份只放在 /tmp，机器重启或换机就没了（#54／#57 同一类缺口）。
run install -m 0755 -o root -g root "$RELEASE/run-retention-preflight.sh" /usr/local/bin/run-retention-preflight.sh
run install -m 0644 -o root -g root "$RELEASE/retention-preflight-d0.sql" /usr/local/bin/retention-preflight-d0.sql
# #57：恢复演练脚本随包交付。目录先补上（新机可能没有 meet-db-backup），文件权限沿用现网
# 既有的 0700 root:root；verify 会比对主机副本与包内副本的 sha，不一致只 WARN 不覆盖判断。
run install -d -m 0755 -o root -g root /opt/meet-db-backup
run install -m 0700 -o root -g root "$RELEASE/work-db-restore-drill.py" /opt/meet-db-backup/work-db-restore-drill.py
for unit in work-runstream-scan.service work-runstream-scan.timer; do
  run install -m 0644 -o root -g root "$RELEASE/$unit" "/etc/systemd/system/$unit"
done
install_env work-runstream-scan
run systemctl daemon-reload
run systemctl enable work-runstream-scan.timer work-c16-log-scan.timer
run systemctl start work-runstream-scan.timer
run systemctl start work-c16-log-scan.timer

echo "== 8. Node runtime =="
if [[ -n "$RUNTIME_BUNDLE" && -f "$RUNTIME_BUNDLE" ]]; then
  node_version="$(node -v 2>/dev/null || true)"
  if [[ -z "$node_version" ]]; then
    echo "node is not installed; install Node >= 22 and re-run, or skip the runtime bundle" >&2
  else
    run mkdir -p /opt/work/runtime
    run tar -xzf "$RUNTIME_BUNDLE" -C /opt/work/runtime
    run chown -R root:root /opt/work/runtime
    run env -C /opt/work/runtime /usr/local/bin/npm ci --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com
    if [[ ! -f /etc/work/work-runtime.env ]]; then
      install_env work-runtime
    fi
    run install -m 0644 -o root -g root "$RELEASE/work-runtime.service" /etc/systemd/system/work-runtime.service
    run systemctl daemon-reload
    run systemctl enable work-runtime
    # work-runtime is never stopped in step 3 (it holds no DB writers), so
    # `start` would be a no-op and the freshly extracted child code would not
    # load until the next reboot.
    run systemctl restart work-runtime
  fi
else
  echo "no runtime bundle provided; skipping work-runtime"
fi

echo "== 8b. directory projection =="
run systemctl start work-directory-sync.timer work-directory-sync-full.timer
run systemctl start work-directory-sync.service || true
echo "new work stays 503 until directory_sync_state has a successful row"

echo "== 9. restart API, relay and export worker, start worker =="
# work-api was stopped for the migration window (step 3) and restarted on the old binary
# right after step 4; only this restart loads the new binary.
# work-export is stopped in step 3, and restart brings it back either way.
run systemctl restart work-api work-relay work-export
if [[ -f /etc/work/work-worker.env ]]; then
  if grep -qE '^WORK_MODEL_|^WORK_RUNTIME_MODE=(openai_compatible|stub|fake)' /etc/work/work-worker.env; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "DRY-RUN: normalize /etc/work/work-worker.env to WORK_RUNTIME_MODE=reference and drop WORK_MODEL_*"
    else
      cp -p /etc/work/work-worker.env "/etc/work/work-worker.env.bak-$STAMP"
      sed -i 's|^WORK_RUNTIME_MODE=.*|WORK_RUNTIME_MODE=reference|' /etc/work/work-worker.env
      sed -i '/^WORK_MODEL_/d' /etc/work/work-worker.env
      chown root:work-control /etc/work/work-worker.env
      chmod 640 /etc/work/work-worker.env
      echo "normalized /etc/work/work-worker.env for the reference runtime"
    fi
  fi
fi
if [[ "$ENABLE_ADVANCE" -eq 1 ]]; then
  run sed -i '/^WORK_WORKFLOW_ADVANCE=/d' /etc/work/work-worker.env
  run sh -c 'printf "WORK_WORKFLOW_ADVANCE=1\n" >> /etc/work/work-worker.env'
  run sed -i '/^WORK_ADVANCE_/d' /etc/work/work-worker.env
  run sh -c 'cat >>/etc/work/work-worker.env <<ENV
WORK_ADVANCE_URL=https://127.0.0.1:8446
WORK_ADVANCE_CERT=/etc/work/runtime-ca/work-go-worker.crt
WORK_ADVANCE_KEY=/etc/work/runtime-ca/work-go-worker.key
WORK_ADVANCE_CA=/etc/work/runtime-ca/ca.crt
WORK_ADVANCE_SERVER_NAME=work-runtime
ENV'
  run sed -i 's#^WORK_TEMPORAL_WORKFLOW_TYPE=.*#WORK_TEMPORAL_WORKFLOW_TYPE=RunWorkflowAdvance#' /etc/work/work-relay.env
  run systemctl restart work-relay
fi
# restart (not start): if the stop in step 3 failed, `start` would keep the
# pre-rollout process serving the old finishing code.
run systemctl restart work-worker

echo "== 10. smoke =="
# Read the radius from the run itself: count plus names, so an operator authorizing or reviewing a
# rollout never has to trust a number written in prose. In --dry-run this is the plan, not the result.
if [[ "$DRY_RUN" -eq 1 ]]; then RADIUS_MODE="will replace (dry-run plan)"; else RADIUS_MODE=replaced; fi
echo "binaries this rollout $RADIUS_MODE = ${#INSTALLED_BINARIES[@]} -> ${INSTALLED_BINARIES[*]}"
# A unit that systemd never stopped keeps serving the pre-rollout inode: the new
# binary is on disk, /proc/<pid>/exe points at the deleted one. Catch that here
# instead of discovering it hours later from an API response shape.
if [[ "$DRY_RUN" -eq 0 ]]; then
  for unit in work-api work-relay work-worker work-authz work-content-proxy work-egress work-export; do
    pid="$(systemctl show "$unit" -p MainPID --value)"
    [[ -n "$pid" && "$pid" != "0" ]] || continue
    if readlink "/proc/$pid/exe" 2>/dev/null | grep -q ' (deleted)$'; then
      echo "STALE: $unit (pid $pid) still runs the binary this rollout replaced" >&2
      exit 1
    fi
  done
fi
systemctl is-active work-authz work-content-proxy work-egress work-api work-relay work-worker || true
ss -ltnp 2>/dev/null | grep -E ':844[3-6]' || true
journalctl -u work-authz -u work-content-proxy -u work-egress -n 20 --no-pager || true

echo
echo "next: configure provider (work-provider-setup), then run the real-provider E2E."
echo "rollback: restore $DUMP and reinstall /usr/local/bin/*.bak-$STAMP"
