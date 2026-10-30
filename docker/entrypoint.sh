#!/bin/bash
# S4 container entrypoint.
#
# The RGW base image is UBI 10 minimal and no longer ships supervisord (nor is
# EPEL available to install it), so this script provisions the S3 admin user and
# supervises the two long-running processes itself:
#
#   1. rgw-standalone     - Ceph RGW S3 API on port 7480
#   2. node               - Fastify backend + web UI on port 5000
#
# A service that keeps crashing is restarted a bounded number of times; once the
# budget is exhausted the script exits non-zero so the orchestrator restarts the
# container instead of leaving it half-up.
set -euo pipefail

CEPH_CONF=/etc/ceph/ceph.conf
DATA_DIR=/var/lib/ceph/radosgw
RGW_DAEMON=/usr/bin/rgw-standalone
RGW_ADMIN=/usr/bin/rgw-standalone-admin
NODE_BIN=/opt/node/bin/node
NODE_DIR=/opt/app-root/bin/s4/backend
MAX_RESTARTS=${S4_MAX_RESTARTS:-3}

# Ensure data directories exist (PVC mount may override Dockerfile-created dirs)
mkdir -p "$DATA_DIR/buckets" "$DATA_DIR/db/rgw_posix_lmdbs" /var/run/ceph

# Create initial RGW user if it does not exist (fails silently on later runs)
"$RGW_ADMIN" -c "$CEPH_CONF" user create \
  --uid s4admin \
  --display-name "S4 Admin" \
  --access-key "${AWS_ACCESS_KEY_ID:-s4admin}" \
  --secret-key "${AWS_SECRET_ACCESS_KEY:-s4secret}" 2>/dev/null || true

# Run one service in a restart loop. Signals are forwarded to the current child
# so that `docker stop` / pod termination shuts both services down cleanly.
supervise() {
  local name="$1" workdir="$2"
  shift 2
  local restarts=0 pid="" rc

  trap 'if [[ -n "$pid" ]]; then kill -TERM "$pid" 2>/dev/null || true; fi; exit 0' TERM INT

  while true; do
    (cd "$workdir" && exec "$@") &
    pid=$!
    echo "[entrypoint] started ${name} (pid ${pid})"

    wait "$pid" && rc=0 || rc=$?

    # Clean exit or termination by signal: stop supervising, do not restart.
    if [[ $rc -eq 0 || $rc -eq 130 || $rc -eq 143 ]]; then
      echo "[entrypoint] ${name} exited with status ${rc}"
      return 0
    fi

    restarts=$((restarts + 1))
    if ((restarts > MAX_RESTARTS)); then
      echo "[entrypoint] ${name} failed ${restarts} times; giving up" >&2
      return "$rc"
    fi

    echo "[entrypoint] ${name} crashed (status ${rc}); restarting (${restarts}/${MAX_RESTARTS})" >&2
    sleep 2
  done
}

supervise rgw / \
  "$RGW_DAEMON" \
  -c "$CEPH_CONF" \
  --cluster ceph \
  --default-log-to-stderr=true \
  --err-to-stderr=true \
  --default-log-to-file=false \
  --foreground \
  -n client.rgw \
  --no-mon-config \
  --rgw-frontends "beast port=7480" &
RGW_SUPERVISOR=$!

supervise nodejs "$NODE_DIR" \
  "$NODE_BIN" dist/server.js &
NODE_SUPERVISOR=$!

# The first service to give up takes the container down with it.
trap 'kill -TERM "$RGW_SUPERVISOR" "$NODE_SUPERVISOR" 2>/dev/null || true; wait || true; exit 0' TERM INT

wait -n "$RGW_SUPERVISOR" "$NODE_SUPERVISOR" && rc=0 || rc=$?
echo "[entrypoint] a service stopped (status ${rc}); stopping the other" >&2
kill -TERM "$RGW_SUPERVISOR" "$NODE_SUPERVISOR" 2>/dev/null || true
wait
exit "$rc"
