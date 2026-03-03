# Container Architecture

S4 packages both the Ceph RGW S3 engine and Node.js web application into a single container image using a multi-stage Docker build and supervisord for process management.

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

**Stage 1: Node.js Builder** (`registry.access.redhat.com/ubi9/nodejs-20`)

- Build frontend (Webpack)
- Build backend (TypeScript)
- Keep build tools and dependencies separate from runtime

**Stage 2: Final Image** (`quay.io/rh-aiservices-bu/radosgw-posix:0.0.7`)

- Copy built artifacts from builder
- Install Node.js runtime
- Install supervisord
- Install s5cmd (S3 debugging tool)
- Configure and set permissions

**Benefits**:

- Smaller final image size
- Faster rebuilds (cached layers)
- Separation of build-time and runtime dependencies

## Base Image

**Image**: `quay.io/rh-aiservices-bu/radosgw-posix:0.0.7`

**Based On**: Ceph daemon image (Reef release) with DBStore/SQLite support

**Includes**:

- Ceph RGW binaries
- radosgw-admin CLI
- SQLite libraries
- Fedora-based operating system

**Why Custom Base?**:

- Official Ceph images require full cluster (mon, mgr, osd)
- S4 needs lightweight standalone RGW with SQLite backend
- Custom image provides RGW configured for DBStore

## Process Management (Supervisord)

### Configuration

**File**: `docker/supervisord.conf`

```ini
[supervisord]
nodaemon=true
logfile=/var/log/supervisord.log
pidfile=/var/run/supervisord.pid
loglevel=info

[program:rgw]
command=/usr/bin/radosgw ...
priority=10
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stderr_logfile=/dev/stderr

[program:nodejs]
command=node /opt/app-root/bin/s4/backend/dist/server.js
priority=20
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stderr_logfile=/dev/stderr
```

### Process Startup Order

1. **supervisord** starts (PID 1)
2. **rgw** starts (priority 10) - S3 API on port 7480
3. **nodejs** starts (priority 20) - Web UI on port 5000

**Why this order?**:

- Node.js backend connects to RGW on startup
- RGW must be ready before backend starts
- Startup delays (`startsecs`) handle timing

### Process Restart Policy

**RGW** (`autorestart=true`):

- Restarts automatically on failure
- Maximum 3 restart attempts (`startretries=3`)
- 5-second grace period (`startsecs=5`)

**Node.js** (`autorestart=true`):

- Restarts automatically on failure
- Maximum 3 restart attempts
- 10-second grace period (longer than RGW)

**Logging**:

- All logs to stdout/stderr (container-friendly)
- No log rotation needed (Kubernetes/Docker handles)

## Entrypoint Script

**File**: `docker/entrypoint.sh`

```bash
#!/bin/bash
set -e

# Ensure data directories exist
mkdir -p /var/lib/ceph/radosgw/{db,buckets,tmp}
mkdir -p /var/lib/ceph/radosgw/db/rgw_posix_lmdbs

# Create initial RGW user (idempotent)
radosgw-admin user create \
  --uid s4admin \
  --display-name "S4 Admin" \
  --access-key "${AWS_ACCESS_KEY_ID:-s4admin}" \
  --secret-key "${AWS_SECRET_ACCESS_KEY:-s4secret}" \
  2>/dev/null || true

# Start supervisord
exec /usr/bin/supervisord -c /etc/supervisord.conf
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

3. **Process Delegation**:
   - Execs supervisord (becomes PID 1)
   - Proper signal handling for shutdown

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
│   └── rgw_posix_lmdbs/         # SQLite databases
├── buckets/                     # Object data (DBStore backend)
└── tmp/                         # Temporary files
```

### Volumes

**Production Mounts**:

- `/var/lib/ceph/radosgw` - S3 data persistence (required)
- `/opt/app-root/src/data` - Local storage for file browsing (optional)

**Development Mounts**:

- `/opt/app-root/bin/s4/backend` - Hot reload backend code
- `/opt/app-root/bin/s4/frontend` - Hot reload frontend code

## Ceph RGW Configuration

**File**: `docker/ceph.conf`

```ini
[global]
fsid = 00000000-0000-0000-0000-000000000000
osd_pool_default_size = 1
osd_pool_default_min_size = 1

[client.rgw]
rgw_backend_store = dbstore
rgw_d3n_l1_local_datacache_enabled = false
rgw_enable_usage_log = false
rgw_dns_name = localhost
rgw_frontends = beast port=7480
```

### Key Configuration

- **Backend Store**: DBStore (SQLite-based, no RADOS needed)
- **Frontends**: Beast HTTP server on port 7480
- **Data Cache**: Disabled (not needed for POC use case)
- **Usage Logging**: Disabled (performance optimization)

### RGW Command

```bash
/usr/bin/radosgw \
  --cluster ceph \
  --default-log-to-stderr=true \
  --err-to-stderr=true \
  --default-log-to-file=false \
  --foreground \
  -n client.rgw \
  --no-mon-config
```

**Flags**:

- `--foreground` - Run in foreground (supervisord manages)
- `--default-log-to-stderr` - Logs to container stdout
- `--no-mon-config` - Standalone mode (no Ceph monitor)

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
FROM registry.access.redhat.com/ubi9/nodejs-20 AS node-builder
# Install dependencies
# Build frontend and backend
```

**Stage 2: Runtime Image**

```dockerfile
FROM quay.io/rh-aiservices-bu/radosgw-posix:0.0.7
# Install Node.js runtime (v22 via CentOS Stream 10 appstream) and supervisord
# Copy built artifacts
# Install production dependencies
# Set permissions
```

> **Note**: The builder uses Node.js 20 (UBI9), while the runtime installs Node.js 22 from CentOS Stream 10's appstream repository. The minimum supported version is Node.js 20+.

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
4. supervisord starts
5. RGW starts (5 second startup time)
6. Node.js starts (10 second startup time)
7. Container ready

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

1. SIGTERM received by supervisord (PID 1)
2. supervisord sends SIGTERM to child processes
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

# Specific process logs via exec
kubectl exec -it pod/s4-xxx -- tail -f /var/log/supervisord.log
```

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
  radosgw-admin user list
```

### Process Status

```bash
# Check supervisor status
kubectl exec -it deployment/s4 -- \
  supervisorctl status

# Restart specific process
kubectl exec -it deployment/s4 -- \
  supervisorctl restart nodejs
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
- **Container Image**: ~800MB compressed

## Security Considerations

### Included Tools

- **s5cmd** - S3 CLI tool (debugging/administration)
- **radosgw-admin** - RGW administration
- **supervisorctl** - Process management

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
- Logs: `podman logs s4 | grep radosgw`

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
