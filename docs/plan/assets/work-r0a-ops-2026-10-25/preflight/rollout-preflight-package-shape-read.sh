#!/usr/bin/env bash
# READ-ONLY package and host-copy preflight for the current rollout. No writes.
set -uo pipefail

PF_FAILURES=0
EXPECTED_MIGRATION_TAIL="${EXPECTED_MIGRATION_TAIL:-97}"
WORK_RELEASE_ROOT="${WORK_RELEASE_ROOT:-/root}"
WORK_INSTALL_BIN_DIR="${WORK_INSTALL_BIN_DIR:-/usr/local/bin}"
WORK_BACKUP_PY="${WORK_BACKUP_PY:-/opt/meet-db-backup/work-content-backup.py}"
WORK_BACKUP_SERVICE="${WORK_BACKUP_SERVICE:-/etc/systemd/system/work-content-backup.service}"
WORK_BACKUP_TIMER="${WORK_BACKUP_TIMER:-/etc/systemd/system/work-content-backup.timer}"

pf_pass() { printf 'PF PASS %s\n' "$*"; }
pf_fail() { printf 'PF FAIL %s\n' "$*" >&2; PF_FAILURES=$((PF_FAILURES + 1)); }
pf_finish() {
  if [ "$PF_FAILURES" -ne 0 ]; then
    printf 'PF RESULT=FAIL failures=%s\n' "$PF_FAILURES"
    exit 1
  fi
  printf 'PF RESULT=PASS\n'
}

if [[ ! "$EXPECTED_MIGRATION_TAIL" =~ ^[0-9]+$ ]]; then
  pf_fail "EXPECTED_MIGRATION_TAIL is not a number: $EXPECTED_MIGRATION_TAIL"
  exit 1
fi

printf '== A. release dirs and rollout wrappers ==\n'
ls -1d "$WORK_RELEASE_ROOT"/work-release-* 2>/dev/null || true
ls -1 "$WORK_RELEASE_ROOT"/run-rollout-*.sh 2>/dev/null || true
latest="${PF_RELEASE_DIR:-$(ls -1dt "$WORK_RELEASE_ROOT"/work-release-* 2>/dev/null | head -1 || true)}"
echo "latest=${latest:-none}"
if [ -z "$latest" ] || [ ! -d "$latest" ]; then
  pf_fail "no release package found under $WORK_RELEASE_ROOT"
  pf_finish
fi

printf '== B. package provenance ==\n'
release_commit="$(cat "$latest/RELEASE_COMMIT" 2>/dev/null || true)"
migration_tail="$(cat "$latest/MIGRATION_TAIL" 2>/dev/null | tr -d '[:space:]')"
release_dirty="$(cat "$latest/RELEASE_DIRTY" 2>/dev/null | tr -d '[:space:]')"
echo "RELEASE_COMMIT=${release_commit:-MISSING}"
echo "MIGRATION_TAIL=${migration_tail:-MISSING}"
echo "RELEASE_DIRTY=${release_dirty:-MISSING}"
echo "package_migrations_dir=$([ -d "$latest/migrations" ] && echo PRESENT || echo ABSENT)"
if [ -n "$release_commit" ]; then
  pf_pass "release commit is recorded"
else
  pf_fail "RELEASE_COMMIT is missing"
fi
if [[ "$migration_tail" =~ ^[0-9]+$ ]] && [ "$migration_tail" -eq "$EXPECTED_MIGRATION_TAIL" ]; then
  pf_pass "package migration tail is $EXPECTED_MIGRATION_TAIL"
else
  pf_fail "package migration tail is ${migration_tail:-MISSING}, expected $EXPECTED_MIGRATION_TAIL"
fi
if [ "$release_dirty" = "0" ]; then
  pf_pass "release tree is clean against its recorded commit"
else
  pf_fail "RELEASE_DIRTY is ${release_dirty:-MISSING}, expected 0"
fi

printf '== C. package checksums ==\n'
if [ ! -f "$latest/SHA256SUMS" ]; then
  pf_fail "SHA256SUMS is missing"
else
  echo "SHA256SUMS_lines=$(wc -l < "$latest/SHA256SUMS")"
  echo "SHA256SUMS_failed_entries=$(grep -c FAILED "$latest/SHA256SUMS" 2>/dev/null || true)"
  if checks="$(cd "$latest" && sha256sum -c SHA256SUMS 2>&1)"; then
    pf_pass "SHA256SUMS verifies every packaged file"
  else
    pf_fail "SHA256SUMS verification failed"
    printf '%s\n' "$checks"
  fi
fi

printf '== D. declared binaries and rollout assets ==\n'
if [ ! -f "$latest/BINARIES" ]; then
  pf_fail "BINARIES manifest is missing"
else
  binary_count=0
  missing_binaries=0
  while IFS= read -r binary || [ -n "$binary" ]; do
    [ -n "$binary" ] || continue
    binary_count=$((binary_count + 1))
    if [ ! -f "$latest/$binary" ]; then
      pf_fail "declared binary is missing: $binary"
      missing_binaries=$((missing_binaries + 1))
    fi
  done < "$latest/BINARIES"
  echo "declared_binaries=$binary_count"
  if [ "$binary_count" -lt 12 ]; then
    pf_fail "BINARIES declares only $binary_count binaries, expected at least 12"
  elif [ "$missing_binaries" -eq 0 ]; then
    pf_pass "all $binary_count declared binaries are present"
  fi
fi
for asset in rollout-r0a-0027.sh verify-r0a-0027.sh work-content-backup.py work-content-backup.service work-content-backup.timer; do
  if [ -f "$latest/$asset" ]; then
    pf_pass "packaged asset is present: $asset"
  else
    pf_fail "packaged asset is missing: $asset"
  fi
done

printf '== E. backup trio host copies vs package (CR-stripped) ==\n'
compare_backup() {
  local name="$1" host="$2" packaged="$latest/$1" host_hash package_hash
  if [ ! -e "$host" ]; then
    echo "$name host=MISSING allowed=first-install"
    return
  fi
  if [ ! -f "$packaged" ]; then
    pf_fail "$name exists on host but is missing from the package"
    return
  fi
  host_hash="$(tr -d '\r' < "$host" | sha256sum | cut -d ' ' -f1)"
  package_hash="$(tr -d '\r' < "$packaged" | sha256sum | cut -d ' ' -f1)"
  echo "$name host_sha256=$host_hash package_sha256=$package_hash"
  if [ "$host_hash" = "$package_hash" ]; then
    pf_pass "$name matches the package after CR stripping"
  else
    pf_fail "$name differs from the package after CR stripping"
  fi
}
compare_backup work-content-backup.py "$WORK_BACKUP_PY"
compare_backup work-content-backup.service "$WORK_BACKUP_SERVICE"
compare_backup work-content-backup.timer "$WORK_BACKUP_TIMER"

printf '== F. rollout script systemctl actions (listed, never executed) ==\n'
for f in "$latest"/rollout*.sh; do
  [ -f "$f" ] || continue
  echo "--- $f"
  grep -nE 'systemctl (stop|restart|start|daemon-reload)' "$f" | head -30 || true
  echo "    lines=$(wc -l < "$f")"
done

printf '== G. packaged binaries vs installed (informational before swap) ==\n'
binroot="$latest"
[ -d "$latest/bin" ] && binroot="$latest/bin"
for b in work-migrate work-api work-authz work-relay; do
  p="$(ls -1 "$binroot/$b" 2>/dev/null || true)"
  if [ -n "$p" ]; then
    s1=$(sha256sum "$p" | cut -c1-16)
    s2=$(sha256sum "$WORK_INSTALL_BIN_DIR/$b" 2>/dev/null | cut -c1-16 || true)
    same=$([ "$s1" = "$s2" ] && echo SAME || echo DIFFER)
    echo "$b package=${s1:-absent} installed=${s2:-absent} $same"
  else
    echo "$b package=NOT-AT $binroot/$b"
  fi
done

printf '== H. three newest package self-assertions ==\n'
for d in $(ls -1dt "$WORK_RELEASE_ROOT"/work-release-* 2>/dev/null | sed -n '1,3p'); do
  echo "$d RELEASE_COMMIT=$(cat "$d/RELEASE_COMMIT" 2>/dev/null) MIGRATION_TAIL=$(cat "$d/MIGRATION_TAIL" 2>/dev/null)"
done

pf_finish
