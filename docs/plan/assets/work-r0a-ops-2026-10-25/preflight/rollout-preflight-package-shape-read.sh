#!/usr/bin/env bash
# READ-ONLY readings about the shape of the newest release package on host. No writes.
set -u
echo "== A. release dirs and rollout wrappers in /root =="
ls -1d /root/work-release-* 2>/dev/null
ls -1 /root/run-rollout-*.sh 2>/dev/null
echo "== B. contents of newest package =="
LATEST="$(ls -1dt /root/work-release-* 2>/dev/null | head -1)"
echo "latest=$LATEST"
ls -1 "$LATEST" 2>/dev/null | head -40
echo "file_count=$(ls -1 "$LATEST" 2>/dev/null | wc -l)"
echo "== C. rollout script shipped in that package =="
for f in "$LATEST"/rollout*.sh; do
  [ -f "$f" ] || continue
  echo "--- $f"
  grep -nE 'systemctl (stop|restart|start|daemon-reload)' "$f" | head -30
  echo "    lines=$(wc -l < "$f")"
done
echo "rollout_scripts_present=$(ls -1 "$LATEST"/rollout*.sh 2>/dev/null | wc -l)"
echo "verify_scripts_present=$(ls -1 "$LATEST"/verify*.sh 2>/dev/null | wc -l)"
echo "== D. packaged binaries vs installed (sha equality) =="
if [ -f "$LATEST/SHA256SUMS" ]; then
  echo "SHA256SUMS_lines=$(wc -l < "$LATEST/SHA256SUMS")"
  echo "SHA256SUMS_failed_entries=$(grep -c FAILED "$LATEST/SHA256SUMS" 2>/dev/null || true)"
fi
BINROOT="$LATEST"
[ -d "$LATEST/bin" ] && BINROOT="$LATEST/bin"
for b in work-migrate work-api work-authz work-relay; do
  p=$(ls -1 "$BINROOT/$b" 2>/dev/null || true)
  if [ -n "$p" ]; then
    s1=$(sha256sum "$p" | cut -c1-16); s2=$(sha256sum "/usr/local/bin/$b" | cut -c1-16)
    same=$([ "$s1" = "$s2" ] && echo SAME || echo DIFFER)
    echo "$b package=${s1:-absent} installed=${s2:-absent} $same"
  else
    echo "$b package=NOT-AT $BINROOT/$b"
  fi
done
echo "== E. any package newer than 0039 staged but unused? =="
ls -1dt /root/work-release-* 2>/dev/null | sed -n '2,4p'
for d in $(ls -1dt /root/work-release-* 2>/dev/null | sed -n '1,3p'); do
  echo "$d RELEASE_COMMIT=$(cat "$d/RELEASE_COMMIT" 2>/dev/null) MIGRATION_TAIL=$(cat "$d/MIGRATION_TAIL" 2>/dev/null)"
done
echo "== F. the newest package's three self-assertions, one label per line =="
echo "RELEASE_COMMIT=$(cat "$LATEST/RELEASE_COMMIT" 2>/dev/null)"
echo "MIGRATION_TAIL=$(cat "$LATEST/MIGRATION_TAIL" 2>/dev/null)"
echo "RELEASE_DIRTY=$(cat "$LATEST/RELEASE_DIRTY" 2>/dev/null)"
echo "== done (read-only) =="
