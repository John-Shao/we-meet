#!/bin/bash
# D 段留存欠账预检的包装脚本（与 retention-preflight-d0.sql 成对，#47／#57／#62 那条规矩）。
#
# 为什么需要这半件：SQL 本体只读，但它**只在 superuser 连接下才有正确含义**——
# work schema 里 44 张表是 ENABLE＋FORCE ROW LEVEL SECURITY，FORCE 对表 owner 同样生效，
# 换个身份就会把"这个会话看不到的行"读成 0（runbook §5.2 的 11-04 教训，#53 的门）。
# 包装脚本负责三件事：取到 superuser 连接、缺 psql／缺 SQL 早失败、把 ON_ERROR_STOP 固定带上
# （没有它 psql 报错仍然 rc=0，这份预检会安静地把错误读成"欠账为 0"，而那个数字正是勾 D-A 的依据）。
#
# 用法（口令交给既有机制：.peers／PGPASSWORD／peer auth；本脚本不打印、不落盘、不写进命令行）：
#   sudo ./run-retention-preflight.sh                    # 切到 postgres 身份走 socket
#   PGHOST=127.0.0.1 PGPORT=5432 ./run-retention-preflight.sh   # TCP 监听（需 .peers 或 PGPASSWORD）
#   WORK_DB=work_ro PGUSER=postgres ./run-retention-preflight.sh # 只读副本
set -euo pipefail

DB="${WORK_DB:-work}"
DB_USER="${PGUSER:-postgres}"
SQL="$(dirname "$0")/retention-preflight-d0.sql"

if [ ! -r "$SQL" ]; then
  echo "RETENTION PREFLIGHT FAILED: missing SQL next to this wrapper: $SQL" >&2
  echo "  两个文件必须同目录安装（#47 的成对交付）" >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "RETENTION PREFLIGHT FAILED: psql not installed (run on the Work host)" >&2
  exit 1
fi

PSQL_FLAGS=(-X -q -At -v ON_ERROR_STOP=1 -d "$DB" -f "$SQL")
if [ -n "${PGHOST:-}" ]; then
  # 显式给了主机：走 TCP，身份由 .peers／PGPASSWORD 解析（runbook §2 那条）。
  exec psql "${PSQL_FLAGS[@]}" -h "$PGHOST" -p "${PGPORT:-5432}" -U "$DB_USER"
fi
if [ "$(id -un)" = "postgres" ]; then
  exec psql "${PSQL_FLAGS[@]}"
fi
if command -v runuser >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
  SQL_ABS="$(readlink -f "$SQL")"   # 切身份后 dirname 的相对性会变，先取绝对路径
  exec runuser -u postgres -- psql -X -q -At -v ON_ERROR_STOP=1 -d "$DB" -f "$SQL_ABS"
fi
echo "RETENTION PREFLIGHT FAILED: cannot reach PostgreSQL as superuser (current user: $(id -un))" >&2
echo "  以 root 跑：sudo $0    或显式给 PGHOST/PGPORT/PGPASSWORD" >&2
exit 1
