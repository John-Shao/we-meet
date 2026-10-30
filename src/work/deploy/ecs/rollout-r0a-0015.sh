#!/usr/bin/env bash
# Roll out Work R0a schema 0008-0015 and the runtime services on the pilot host.
#
# Run as root. Every step is idempotent and every destructive step is preceded
# by a database dump. Use --dry-run first: it prints the exact commands.
#
#   ./rollout-r0a-0015.sh --release /root/work-release-0015 \
#     --migrator-url 'postgresql://work_migrator_login:...@127.0.0.1:5432/work' \
#     [--enable-advance] [--runtime-bundle /root/work-runtime-0015.tar.gz] [--dry-run]
#
# Rollback: restore the dump taken in step 2 and reinstall the .bak-<stamp>
# binaries. Schema 0008-0015 has no destructive down migration by design.
set -euo pipefail

RELEASE=""
MIGRATOR_URL="${MIGRATOR_DATABASE_URL:-}"
ENABLE_ADVANCE=0
RUNTIME_BUNDLE=""
DRY_RUN=0
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR=/var/backups/work

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) RELEASE="${2:-}"; shift 2 ;;
    --migrator-url) MIGRATOR_URL="${2:-}"; shift 2 ;;
    --runtime-bundle) RUNTIME_BUNDLE="${2:-}"; shift 2 ;;
    --enable-advance) ENABLE_ADVANCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown flag: $1" >&2; usage ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
if [[ -z "$RELEASE" || ! -d "$RELEASE" ]]; then
  echo "--release <dir> is required" >&2
  exit 1
fi
if [[ -z "$MIGRATOR_URL" ]]; then
  echo "--migrator-url (or MIGRATOR_DATABASE_URL) is required" >&2
  exit 1
fi
for bin in work-migrate work-api work-relay work-worker work-authz work-content-proxy work-egress work-directory-sync; do
  [[ -f "$RELEASE/$bin" ]] || { echo "missing $RELEASE/$bin" >&2; exit 1; }
done

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
  runuser -u postgres -- psql -d work -Atc "select coalesce(max(version),0) from work.schema_migration" 2>/dev/null || echo 0
}

install_binary() {
  local name="$1"
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
  python3 - "$target" "$worker_url" "$content_key" "$name" <<'PYEOF'
import pathlib, re, sys
target, worker_url, content_key, name = sys.argv[1:5]
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
current="$(ledger_max)"
echo "ledger currently at ${current:-0}"
if [[ "${current:-0}" -gt 15 ]]; then
  echo "database is ahead of this release (ledger $current); aborting" >&2
  exit 1
fi
df -h / | tail -1
systemctl is-active work-api work-relay work-worker || true

echo "== 2. database dump =="
run mkdir -p "$BACKUP_DIR"
DUMP="$BACKUP_DIR/work-pre-0015-$STAMP.dump"
TMP_DUMP="/tmp/work-pre-0015-$STAMP.dump"
run runuser -u postgres -- pg_dump -Fc -f "$TMP_DUMP" work
run mv "$TMP_DUMP" "$DUMP"
run chmod 600 "$DUMP"
echo "dump: $DUMP"

echo "== 2b. in-flight runs =="
runuser -u postgres -- psql -d work -Atc "select state, count(*) from work.run where state in ('queued','active','waiting','cancel_requested') group by state" || true
echo "the new worker cannot resume legacy in-flight runs; drain or accept their loss before --enable-advance"

echo "== 3. stop writers =="
for unit in work-directory-sync.timer work-directory-sync-full.timer work-directory-sync.service work-worker work-relay; do
  run systemctl stop "$unit" 2>/dev/null || true
done

echo "== 4. migrate =="
install_binary work-migrate
run env WORK_DATABASE_URL="$MIGRATOR_URL" /usr/local/bin/work-migrate apply --legacy-migrator-disabled
run env WORK_DATABASE_URL="$MIGRATOR_URL" /usr/local/bin/work-migrate status

echo "== 5. binaries =="
for bin in work-api work-relay work-worker work-authz work-content-proxy work-egress work-directory-sync; do
  install_binary "$bin"
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
run systemctl daemon-reload
run systemctl enable work-authz work-content-proxy work-egress
run systemctl start work-authz work-content-proxy work-egress

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

echo "== 9. restart API and relay, start worker =="
run systemctl start work-api work-relay
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
run systemctl start work-worker

echo "== 10. smoke =="
systemctl is-active work-authz work-content-proxy work-egress work-api work-relay work-worker || true
ss -ltnp 2>/dev/null | grep -E ':844[3-6]' || true
journalctl -u work-authz -u work-content-proxy -u work-egress -n 20 --no-pager || true

echo
echo "next: configure provider (work-provider-setup), then run the real-provider E2E."
echo "rollback: restore $DUMP and reinstall /usr/local/bin/*.bak-$STAMP"
