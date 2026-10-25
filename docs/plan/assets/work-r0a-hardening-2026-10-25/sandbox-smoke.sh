#!/usr/bin/env bash
# R0a reduced-profile sandbox smoke: runc, non-root, read-only rootfs,
# no host mounts, no network, dropped capabilities, resource limits.
# This is NOT gVisor and MUST NOT be cited as a sandbox proof.
set -u
docker run --rm \
  --read-only \
  --user 65532:65532 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  --memory 256m \
  --cpus 0.5 \
  --pids-limit 128 \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  node:22-bookworm sh -c '
    set +e
    echo "uid=$(id -u)"
    touch /rootfile 2>&1; echo "root_write_exit=$?"
    ls /host 2>&1; echo "host_path_exit=$?"
    ls /var/run/docker.sock 2>&1; echo "docker_sock_exit=$?"
    printf ok > /tmp/ok; echo "tmp_write_exit=$?"
    node -e "fetch(\"https://example.com\",{signal:AbortSignal.timeout(1500)}).then(()=>{console.log(\"network_ok\");process.exit(2)}).catch(e=>{console.log(\"network_blocked\",e.name);process.exit(0)})"
    echo "network_exit=$?"
    echo "sandbox-smoke-complete"
  '
