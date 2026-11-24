#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-/tmp/work-observability-release-$(date +%Y%m%d-%H%M%S)}"

if [[ -e "$OUT" && -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  case "$OUT" in
    */work-observability-release-*) ;;
    *) echo "ERROR: refusing to clear non-empty directory not named work-observability-release-*: $OUT" >&2; exit 1 ;;
  esac
fi
rm -rf "$OUT"
mkdir -p "$OUT"/{bin,third-party,prometheus,alertmanager,grafana/provisioning/datasources,grafana/provisioning/dashboards,grafana/dashboards,systemd}

# The package is a closure over this directory. Copying the tree before adding generated
# metadata and third-party assets means a new config cannot silently miss the release.
cp -a "$SOURCE/." "$OUT/"
rm -rf "$OUT/test" "$OUT/__pycache__"
git -C "$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")" rev-parse HEAD > "$OUT/RELEASE_COMMIT"
DIRTY="$(git -C "$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")" status --porcelain -- deploy/observability src/work docs/plan/assets/work-r0a-design-2026-10-25/test/telemetry-producers.test.mjs | wc -l | tr -d ' ')"
printf '%s\n' "$DIRTY" > "$OUT/RELEASE_DIRTY"
cp "$SOURCE/demo-metrics.py" "$SOURCE/demo-webhook.py" "$OUT/bin/"
cp "$SOURCE/prometheus-rules.yaml" "$SOURCE/demo-rules.yaml" "$OUT/prometheus/"
cp "$SOURCE/grafana-dashboards/work-overview.json" "$OUT/grafana/dashboards/"

# shellcheck disable=SC1091
source "$SOURCE/versions.env"
fetch() {
  local repo="$1" version="$2" archive="$3" url="$4" expected="$5"
  local destination="$OUT/third-party/$archive"
  if [[ -f "$destination" ]]; then
    local existing
    existing="$(sha256sum "$destination" | cut -d' ' -f1)"
    if [[ "$existing" != "$expected" ]]; then
      echo "ERROR: staged asset checksum mismatch for $archive" >&2
      exit 1
    fi
    printf '%s  %s\n' "$expected" "$archive" > "$OUT/third-party/$archive.sha256"
    (cd "$OUT/third-party" && sha256sum -c "$archive.sha256")
    return
  fi
  local cached="${OBSERVABILITY_ASSET_CACHE:-}/$archive"
  if [[ -n "${OBSERVABILITY_ASSET_CACHE:-}" && -f "$cached" ]]; then
    actual="$(sha256sum "$cached" | cut -d' ' -f1)"
    if [[ "$actual" != "$expected" ]]; then
      echo "ERROR: cached asset checksum mismatch for $archive" >&2
      exit 1
    fi
    cp "$cached" "$destination"
  elif command -v gh >/dev/null 2>&1 && \
    HTTPS_PROXY= HTTP_PROXY= gh release download "v$version" -R "$repo" -p "$archive" -O "$destination" --clobber; then
    :
  else
    curl --fail --location --connect-timeout 20 --max-time 900 --speed-time 60 --speed-limit 1024 \
      --output "$destination" "$url"
  fi
  printf '%s  %s\n' "$expected" "$archive" > "$OUT/third-party/$archive.sha256"
  (cd "$OUT/third-party" && sha256sum -c "$archive.sha256")
}
stage_binary() {
  local name="$1" expected="$2"
  local cached="${OBSERVABILITY_BIN_CACHE:-}/$name"
  if [[ -z "${OBSERVABILITY_BIN_CACHE:-}" || ! -f "$cached" ]]; then
    return 1
  fi
  local actual
  actual="$(sha256sum "$cached" | cut -d' ' -f1)"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: cached binary checksum mismatch for $name" >&2
    exit 1
  fi
  cp "$cached" "$OUT/bin/$name"
}

stage_archive_binary() {
  local repo="$1" version="$2" archive="$3" url="$4" archive_sha="$5" binary="$6" binary_sha="$7"
  if stage_binary "$binary" "$binary_sha"; then
    return
  fi
  fetch "$repo" "$version" "$archive" "$url" "$archive_sha"
  local extract
  extract="$(mktemp -d)"
  tar -xzf "$OUT/third-party/$archive" -C "$extract"
  local source="$extract/${archive%.linux-amd64.tar.gz}/$binary"
  if [[ ! -f "$source" ]]; then
    echo "ERROR: $archive does not contain $binary" >&2
    rm -rf "$extract"
    exit 1
  fi
  cp "$source" "$OUT/bin/$binary"
  rm -rf "$extract"
}

stage_archive_binary "$PROMETHEUS_REPO" "$PROMETHEUS_VERSION" "$PROMETHEUS_ARCHIVE" "$PROMETHEUS_URL" "$PROMETHEUS_SHA256" prometheus "$PROMETHEUS_BIN_SHA256"
stage_archive_binary "$PROMETHEUS_REPO" "$PROMETHEUS_VERSION" "$PROMETHEUS_ARCHIVE" "$PROMETHEUS_URL" "$PROMETHEUS_SHA256" promtool "$PROMTOOL_BIN_SHA256"
stage_archive_binary "$ALERTMANAGER_REPO" "$ALERTMANAGER_VERSION" "$ALERTMANAGER_ARCHIVE" "$ALERTMANAGER_URL" "$ALERTMANAGER_SHA256" alertmanager "$ALERTMANAGER_BIN_SHA256"
stage_archive_binary "$ALERTMANAGER_REPO" "$ALERTMANAGER_VERSION" "$ALERTMANAGER_ARCHIVE" "$ALERTMANAGER_URL" "$ALERTMANAGER_SHA256" amtool "$AMTOOL_BIN_SHA256"
rm -f "$OUT/third-party/$PROMETHEUS_ARCHIVE" "$OUT/third-party/$PROMETHEUS_ARCHIVE.sha256"
rm -f "$OUT/third-party/$ALERTMANAGER_ARCHIVE" "$OUT/third-party/$ALERTMANAGER_ARCHIVE.sha256"
fetch "$GRAFANA_REPO" "$GRAFANA_VERSION" "$GRAFANA_ARCHIVE" "$GRAFANA_URL" "$GRAFANA_SHA256"

OUT_WIN="$(cygpath -w "$OUT/bin/work-api" 2>/dev/null || echo "$OUT/bin/work-api")"
(cd "$ROOT/src/work" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$OUT_WIN" ./cmd/work-api)

chmod 0755 "$OUT"/*.sh "$OUT"/bin/*
CURRENT_COMMIT="$(git -C "$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")" rev-parse HEAD)"
CURRENT_DIRTY="$(git -C "$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")" status --porcelain -- deploy/observability src/work docs/plan/assets/work-r0a-design-2026-10-25/test/telemetry-producers.test.mjs | wc -l | tr -d ' ')"
if [[ "$CURRENT_COMMIT" != "$(cat "$OUT/RELEASE_COMMIT")" || "$CURRENT_DIRTY" != "$DIRTY" ]]; then
  echo "ERROR: source tree changed while building the observability release" >&2
  exit 1
fi
(cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "observability release ready: $OUT"
echo "commit=$(cat "$OUT/RELEASE_COMMIT") dirty=$DIRTY"
