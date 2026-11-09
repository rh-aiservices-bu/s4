# Container Architecture

S4 packages both the Ceph RGW S3 engine and Node.js web application into a single container image using a multi-stage Docker build. The entrypoint script supervises both processes, because the RGW base image ships no init system.

## Container Design Philosophy

### Single Container Deployment

**Decision**: Package RGW + Node.js in one container instead of separate pods.

**Rationale**:

- Simpler deployment (single pod/container)
- No network overhead between components
- Easier for POCs, demos, and development
- Reduced operational complexity

**Trade-offs**:

- Less flexible scaling (cannot scale components independently)
- Coupled lifecycle (restart affects both)
- Not cloud-native best practice (but acceptable for use case)

### Multi-Stage Build

**Stage 1: Node.js Builder** (`registry.access.redhat.com/ubi9/nodejs-22`)

- Build frontend (Webpack)
- Build backend (TypeScript)
- Keep build tools and dependencies separate from runtime

**Stage 2: Runtime Tooling** (`registry.access.redhat.com/ubi9/ubi`)

- Download the official Node.js 22 build (self-contained, no extra shared libraries)
- Download s5cmd (S3 debugging tool)
- Exists only because the final image has no package manager access to these tools

**Stage 3: Final Image** (`icr.io/cpopen/ibm-ceph/rgw-standalone-rhel10:v9.9.2-27322`)

- Copy Node.js and s5cmd from the tooling stage
- Copy built artifacts from builder
- Install production dependencies with npm
- Configure and set permissions

**Benefits**:

- Smaller final image size
- Faster rebuilds (cached layers)
- Separation of build-time and runtime dependencies

## Base Image

**Image**: `icr.io/cpopen/ibm-ceph/rgw-standalone-rhel10:v9.9.2-27322`

**Based On**: Red Hat UBI 10 minimal, with IBM Storage Ceph 9.9.2 `ceph-rgw-standalone`

**Includes**:

- `rgw-standalone` daemon and `rgw-standalone-admin` CLI (Ceph Tentacle 20.2.2)
- POSIX backend (`rgw backend store = posix`) with LMDB/SQLite metadata
- SQLite, LMDB, Arrow and other Ceph runtime libraries
- Bash, Python 3.12 and curl

**Does not include**:

- Node.js or npm (installed from the tooling stage)
- An init/supervision system (`supervisord` is unavailable — no EPEL, no usable RHEL subscription repos)
- `tar` (only needed at build time, in the tooling stage)

**Why this base?**:

- Official Ceph images require a full cluster (mon, mgr, osd)
- S4 needs a lightweight standalone RGW with a local POSIX/SQLite backend
- Vendor-supported standalone gateway image, multi-arch (amd64, arm64, ppc64le, s390x)

## Process Supervision (Entrypoint)

The base image has no init system, so `docker/entrypoint.sh` supervises both
processes itself. It stays in the foreground as PID 1 and runs each service in a
restart loop.

### Startup Order

1. **entrypoint.sh** starts (PID 1)
2. Directories are created, the S3 admin user is provisioned
3. **rgw-standalone** starts - S3 API on port 7480
4. **node** starts - Web UI on port 5000

**Why this order?**: the user must exist before RGW serves requests, and the
Node.js backend talks to RGW at `localhost:7480`.

### Restart Policy

Both services are restarted with a 2-second delay when they exit non-zero.
After `S4_MAX_RESTARTS` (default `3`) consecutive failures the supervisor gives
up and the entrypoint exits non-zero, so the orchestrator restarts the whole
container instead of leaving it half-up.

A service that exits cleanly (status 0) or is terminated by a signal stops the
container: both processes are stopped and the entrypoint exits with that status.

**Logging**:

- All logs to stdout/stderr (container-friendly)
- No log rotation needed (Kubernetes/Docker handles)
- Entrypoint supervision messages are prefixed with `[entrypoint]`; RGW and
  Node.js lines share the same stream

## Entrypoint Script

**File**: `docker/entrypoint.sh`

```bash
#!/bin/bash
set -euo pipefail

# Ensure data directories exist
mkdir -p /var/lib/ceph/radosgw/buckets \
         /var/lib/ceph/radosgw/db/rgw_posix_lmdbs \
         /var/run/ceph

# Create initial RGW user (idempotent)
rgw-standalone-admin -c /etc/ceph/ceph.conf user create \
  --uid s4admin \
  --display-name "S4 Admin" \
  --access-key "${AWS_ACCESS_KEY_ID:-s4admin}" \
  --secret-key "${AWS_SECRET_ACCESS_KEY:-s4secret}" \
  2>/dev/null || true

# Supervise both services in-process (see the full script for the loop)
supervise rgw / /usr/bin/rgw-standalone ... --rgw-frontends "beast port=7480" &
supervise nodejs /opt/app-root/bin/s4/backend /opt/node/bin/node dist/server.js &
```

### Responsibilities

1. **Directory Initialization**:

   - Creates RGW data directories (PVC mounts may override)
   - Creates SQLite database directory
   - Ensures permissions are correct

2. **User Provisioning**:

   - Creates S3 admin user on first run
   - Uses environment variables for credentials
   - Idempotent (fails gracefully if user exists)

3. **Process Supervision**:
   - Runs `rgw-standalone` and Node.js in restart loops (remains PID 1)
   - Forwards SIGTERM/SIGINT to both services for graceful shutdown
   - Exits non-zero when a service exhausts its restart budget

## Directory Structure

### Application Directories

```
/opt/app-root/
├── bin/s4/
│   ├── backend/
│   │   ├── dist/                # Compiled backend JavaScript
│   │   ├── node_modules/        # Production dependencies
│   │   └── package.json
│   └── frontend/
│       └── dist/                # Webpack build output
│
└── src/
    └── data/                    # Local storage mount point
```

### Persistent Data Directories

```
/var/lib/ceph/radosgw/
├── db/
│   └── rgw_posix_lmdbs/         # LMDB metadata partitions
├── dbstore-config.db            # SQLite config store (realm/zone/period)
├── dbstore-default_ns.db        # SQLite user/bucket metadata
└── buckets/                     # Object data (POSIX backend)
```

### Volumes

**Production Mounts**:

- `/var/lib/ceph/radosgw` - S3 data persistence (required)
- `/opt/app-root/src/data` - Local storage for file browsing (optional)

**Development Mounts**:

- `/opt/app-root/bin/s4/backend` - Hot reload backend code
- `/opt/app-root/bin/s4/frontend` - Hot reload frontend code

## Ceph RGW Configuration

**File**: `docker/config` (installed as `/etc/ceph/ceph.conf`)

```ini
[client]
rgw backend store = posix
rgw config store = dbstore

rgw_posix_base_path = /var/lib/ceph/radosgw/buckets
rgw_posix_database_root = /var/lib/ceph/radosgw/db

admin socket = /var/lib/ceph/radosgw/ceph-$cluster-$name.asok

rgw_enable_apis = s3, s3website, sts, sns, notifications
rgw_enable_usage_log = false
rgw_enable_ops_log = false
```

### Key Configuration

- **Backend Store**: POSIX (LMDB/SQLite metadata, files on disk; no RADOS needed)
- **Config Store**: SQLite (`dbstore`) under `rgw_posix_database_root`
- **Frontends**: Beast HTTP server on port 7480 (passed on the command line)
- **Usage/Ops Logging**: Disabled (performance optimization)

The base image's own `ceph.conf` only sets the backend/config stores. S4 adds
explicit POSIX paths so all state lives under the persisted volume.

### RGW Command

```bash
/usr/bin/rgw-standalone \
  -c /etc/ceph/ceph.conf \
  --cluster ceph \
  --default-log-to-stderr=true \
  --err-to-stderr=true \
  --default-log-to-file=false \
  --foreground \
  -n client.rgw \
  --no-mon-config \
  --rgw-frontends "beast port=7480"
```

**Flags**:

- `--foreground` - Run in foreground (entrypoint supervises)
- `--default-log-to-stderr` - Logs to container stdout
- `--no-mon-config` - Standalone mode (no Ceph monitor)
- `--rgw-frontends` - Passed as a CLI argument so it takes precedence over any
  value previously stored in the config store

## OpenShift Compatibility

### Non-Root User

**UID**: 1001
**GID**: 0 (root group)

**Rationale**:

- OpenShift runs containers as arbitrary UIDs
- Root group membership provides necessary permissions
- Follows OpenShift security best practices

### Permissions

```dockerfile
# Set ownership and permissions for OpenShift
RUN chown -R 1001:0 /opt/app-root /var/lib/ceph && \
    chmod -R g+rwX /opt/app-root /var/lib/ceph
```

**Pattern**:

- Owner: UID 1001
- Group: Root (GID 0)
- Group permissions: Read, write, execute for directories

### SCCs (Security Context Constraints)

S4 runs with default `restricted` SCC:

- No root privileges required
- No host filesystem access
- No privileged ports (>1024)

## Build Process

### Multi-Stage Build

**Stage 1: Build Applications**

```dockerfile
FROM registry.access.redhat.com/ubi9/nodejs-22 AS node-builder
# Install dependencies
# Build frontend and backend
```

**Stage 2: Runtime Tooling**

```dockerfile
FROM registry.access.redhat.com/ubi9/ubi AS runtime-tools
# Download official Node.js 22 (linux-x64) and s5cmd; the final image has no
# package manager access to either and does not ship tar.
```

**Stage 3: Runtime Image**

```dockerfile
FROM icr.io/cpopen/ibm-ceph/rgw-standalone-rhel10:v9.9.2-27322
# Copy Node.js and s5cmd from the tooling stage
# Copy built artifacts
# Install production dependencies
# Set permissions
```

> **Note**: The builder uses Node.js 22 (UBI9); the runtime ships Node.js 22
> (official build) copied from the tooling stage. The minimum supported version
> is Node.js 22.15+.

### Layer Optimization

1. **Configuration files** - Copied early (change infrequently)
2. **Built artifacts** - Copied from builder
3. **Production dependencies** - npm install (cached if package.json unchanged)
4. **Permissions** - Set in same layer as installation

### Makefile Targets

```bash
# Build container image
make build

# Run locally with Podman
make run

# Push to registry
make login
make push

# Deploy to Kubernetes
make deploy
```

## Ports

- **7480** - Ceph RGW S3 API (HTTP)
- **5000** - Node.js Web UI (HTTP)

**Production**: Use ingress/route with TLS termination.

## Environment Variables

### S4-Specific

```dockerfile
ENV AWS_S3_ENDPOINT=http://localhost:7480 \
    AWS_ACCESS_KEY_ID=s4admin \
    AWS_SECRET_ACCESS_KEY=s4secret \
    AWS_DEFAULT_REGION=us-east-1 \
    PORT=5000 \
    IP=0.0.0.0 \
    NODE_ENV=production
```

### Override at Runtime

```bash
podman run -d \
  -e AWS_ACCESS_KEY_ID=myadmin \
  -e AWS_SECRET_ACCESS_KEY=mysecret \
  -e UI_USERNAME=admin \
  -e UI_PASSWORD=password \
  quay.io/rh-aiservices-bu/s4:latest
```

## Storage

### S3 Data Volume

**Path**: `/var/lib/ceph/radosgw`

**Contents**:

- SQLite databases (metadata)
- Object data (file content)
- RGW temporary files

**Size**: Grows with objects stored.

**Backup**: Critical for data persistence.

### Local Storage Volume

**Path**: `/opt/app-root/src/data`

**Contents**: User files for browsing and transfer.

**Size**: User-defined.

**Optional**: Not required for S3-only use.

## Container Lifecycle

### Startup Sequence

1. Container starts → entrypoint.sh runs
2. Directories initialized
3. RGW user created (if first run)
4. RGW daemon and its supervisor start
5. Node.js and its supervisor start
6. Container ready

### Health Checks

**Not Implemented**: Future enhancement.

**Recommendation**:

```yaml
livenessProbe:
  httpGet:
    path: /api/disclaimer
    port: 5000
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /api/disclaimer
    port: 5000
  initialDelaySeconds: 15
  periodSeconds: 5
```

### Shutdown Sequence

1. SIGTERM received by entrypoint.sh (PID 1)
2. Entrypoint signals both supervisors, which forward SIGTERM to their child
3. Node.js graceful shutdown (closes connections)
4. RGW graceful shutdown (flushes writes)
5. Container exits

**Grace Period**: 30 seconds (Kubernetes default).

## Debugging

### Logs

```bash
# Container logs (both RGW and Node.js)
podman logs -f s4

# Kubernetes logs
kubectl logs -f deployment/s4
```

Both processes log to the container's stdout/stderr, so there are no
per-process log files to tail.

### Shell Access

```bash
# Podman
podman exec -it s4 bash

# Kubernetes
kubectl exec -it deployment/s4 -- bash
```

### S3 Debugging

```bash
# List buckets with s5cmd
kubectl exec -it deployment/s4 -- \
  s5cmd --endpoint-url http://localhost:7480 ls

# RGW admin commands
kubectl exec -it deployment/s4 -- \
  rgw-standalone-admin -c /etc/ceph/ceph.conf user list
```

### Process Status

```bash
# Check that both processes are running
kubectl exec -it deployment/s4 -- \
  ps -ef

# Follow the supervision messages (starts, restarts, give-ups)
kubectl logs -f deployment/s4 | grep entrypoint
```

## Resource Requirements

### Recommended Limits

```yaml
resources:
  requests:
    memory: '512Mi'
    cpu: '500m'
  limits:
    memory: '2Gi'
    cpu: '2000m'
```

### Memory Breakdown

- **Base**: ~200MB (RGW + Node.js)
- **Per Upload**: ~50MB (streaming buffer)
- **Per Transfer**: ~100MB
- **HuggingFace Import (7B)**: ~256MB peak

### Storage Requirements

- **S3 Data**: User-defined (depends on objects)
- **Local Storage**: User-defined (optional)
- **Container Image**: dominated by the Ceph base image (~360 MiB compressed), plus ~180 MB of Node.js runtime

## Security Considerations

### Included Tools

- **s5cmd** - S3 CLI tool (debugging/administration)
- **rgw-standalone-admin** - RGW administration (`user create`, `user list`, quotas)

**Note**: These tools are admin-level. Restrict shell access in production.

### Network Security

- RGW and Node.js communicate via localhost (no external exposure needed)
- Only expose port 5000 via ingress/route (TLS termination)
- RGW port 7480 optionally exposed for S3 CLI access

### File System Security

- Non-root user (UID 1001)
- Minimal writable directories
- No privileged operations
- Compatible with `restricted` SCC

## Troubleshooting

### Container Won't Start

**Check**:

- Volume permissions (must be writable by UID 1001 or GID 0)
- Environment variables (credentials, endpoints)
- Port conflicts (7480, 5000)

### RGW Crashes

**Check**:

- SQLite database corruption (delete and restart)
- Disk full (check volume space)
- Logs: `podman logs s4 | grep -i rgw`

### Node.js Crashes

**Check**:

- Memory limits (increase if needed)
- Environment variables (S3 endpoint, credentials)
- Logs: `podman logs s4 | grep node`

### Data Loss After Restart

**Check**:

- Volume mounted correctly
- Volume not using `emptyDir` (ephemeral)
- PVC exists and is bound

## Further Reading

- **[Backend Architecture](backend.md)** - API server implementation
- **[Deployment Guide](../deployment/kubernetes.md)** - Kubernetes deployment
- **[Production Readiness](../deployment/production-readiness.md)** - Production checklist
