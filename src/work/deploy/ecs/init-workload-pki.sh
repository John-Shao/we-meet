#!/usr/bin/env bash
# Create the R0a workload PKI for the internal runtime listeners.
#
# Idempotent: existing CA or certificates are never overwritten. Run as root on
# the Work host. Server certificates carry both a DNS SAN and the loopback IP
# because clients dial 127.0.0.1 while the Node parent verifies by IP.
set -euo pipefail

DIR=/etc/work/runtime-ca
OWNER=root
GROUP=work-control
DAYS=825

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
if ! getent group "$GROUP" >/dev/null; then
  echo "group $GROUP is missing; create the service account first" >&2
  exit 1
fi

umask 077
mkdir -p "$DIR"
chown "$OWNER:$GROUP" "$DIR"
chmod 750 "$DIR"

if [[ ! -f "$DIR/ca.key" ]]; then
  openssl ecparam -genkey -name prime256v1 -out "$DIR/ca.key"
  openssl req -x509 -new -key "$DIR/ca.key" -sha256 -days 3650 \
    -subj "/CN=work-runtime-ca" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out "$DIR/ca.crt"
fi
chmod 600 "$DIR/ca.key"
chmod 644 "$DIR/ca.crt"

issue() {
  local name="$1" kind="$2" san="${3:-}"
  if [[ -f "$DIR/$name.key" && -f "$DIR/$name.crt" ]]; then
    echo "keep $name"
    return
  fi
  openssl ecparam -genkey -name prime256v1 -out "$DIR/$name.key"
  openssl req -new -key "$DIR/$name.key" -subj "/CN=$name" -out "$DIR/$name.csr"
  local ext
  ext="$(mktemp)"
  if [[ "$kind" == "server" ]]; then
    printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$san" >"$ext"
  else
    printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n' >"$ext"
  fi
  openssl x509 -req -in "$DIR/$name.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" \
    -CAcreateserial -days "$DAYS" -sha256 -extfile "$ext" -out "$DIR/$name.crt"
  rm -f "$ext" "$DIR/$name.csr"
  chmod 600 "$DIR/$name.key"
  chmod 644 "$DIR/$name.crt"
  echo "issued $name ($kind)"
}

issue work-authz server "DNS:work-authz,IP:127.0.0.1"
issue work-content-proxy server "DNS:work-content-proxy,IP:127.0.0.1"
issue work-egress server "DNS:work-egress,IP:127.0.0.1"
issue work-runtime server "DNS:work-runtime,IP:127.0.0.1"
issue work-parent client
issue work-egress-client client
issue work-go-worker client

fingerprint() {
  openssl x509 -in "$DIR/$1.crt" -outform der | sha256sum | cut -d' ' -f1
}

if [[ ! -f "$DIR/workloads.json" ]]; then
  cat >"$DIR/workloads.json" <<JSON
{"workloads":[
  {"fingerprint":"$(fingerprint work-parent)","kind":"runtime_parent","workload_id":"work-parent-1"},
  {"fingerprint":"$(fingerprint work-egress-client)","kind":"egress","workload_id":"work-egress-1"}
]}
JSON
fi

chown "$OWNER:$GROUP" "$DIR"/*.key "$DIR"/*.crt "$DIR/workloads.json" 2>/dev/null || true
chmod 640 "$DIR"/*.key
chmod 640 "$DIR/workloads.json"

echo
echo "workload registry: $DIR/workloads.json"
echo "parent fingerprint: $(fingerprint work-parent)"
echo "egress fingerprint:  $(fingerprint work-egress-client)"
