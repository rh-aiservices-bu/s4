# =============================================================================
# S4 - Super Simple Storage Service
# Combined container with Ceph RGW (POSIX backend) + Node.js Web UI
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Node.js Builder
# Build the frontend and backend TypeScript applications
# -----------------------------------------------------------------------------
FROM registry.access.redhat.com/ubi9/nodejs-20 AS node-builder

USER 0
WORKDIR /tmp/src

# Copy package files first for better layer caching
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

# Install all dependencies
RUN npm install

# Copy source code
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Build both frontend and backend
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: Runtime Tooling
# The RGW base image is UBI 10 minimal: it ships neither Node.js nor supervisor
# (EPEL is unavailable) and has no `tar`. Fetch Node.js and s5cmd here, in a
# stage that has curl + tar, and copy only the resulting binaries.
# -----------------------------------------------------------------------------
FROM registry.access.redhat.com/ubi9/ubi:9.8 AS runtime-tools

ARG NODE_VERSION=22.23.4
ARG S5CMD_VERSION=2.3.0

# amd64 only, mirroring the s5cmd asset below. Extend both URLs if other
# architectures ever need to be built.
# Official Node.js builds are self-contained (bundled OpenSSL/ICU/libuv), so
# they run on the minimal UBI 10 runtime without extra shared libraries.
RUN curl -fsSL -o /tmp/node.tar.gz \
        "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" && \
    tar -xzf /tmp/node.tar.gz -C /opt && \
    mv "/opt/node-v${NODE_VERSION}-linux-x64" /opt/node && \
    rm -rf /opt/node/include /opt/node/share /opt/node/CHANGELOG.md /opt/node/LICENSE /opt/node/README.md

# Install s5cmd for S3 debugging/administration
RUN curl -fsSL -o /tmp/s5cmd.tar.gz \
        "https://github.com/peak/s5cmd/releases/download/v${S5CMD_VERSION}/s5cmd_${S5CMD_VERSION}_Linux-64bit.tar.gz" && \
    tar -xzf /tmp/s5cmd.tar.gz -C /usr/local/bin s5cmd

# -----------------------------------------------------------------------------
# Stage 3: Final Image
# IBM Storage Ceph Object Gateway (rgw-standalone) with Node.js runtime
# -----------------------------------------------------------------------------
FROM icr.io/cpopen/ibm-ceph/rgw-standalone-rhel10:v9.9.2-27322

LABEL name="s4" \
      summary="S4 - Super Simple Storage Service" \
      description="Lightweight S3-compatible storage with web UI" \
      io.k8s.display-name="S4" \
      io.k8s.description="S4 combines Ceph RGW with SQLite backend and a web management UI" \
      maintainer="Red Hat AI Services BU"

USER root

# Node.js runtime (self-contained official build) and s5cmd from the tooling stage
COPY --from=runtime-tools /opt/node /opt/node
COPY --from=runtime-tools /usr/local/bin/s5cmd /usr/local/bin/s5cmd

# The base image defaults to its own data directories; S4 keeps all state under
# /var/lib/ceph/radosgw so existing volumes keep their mount point.
ENV PATH=/opt/node/bin:$PATH \
    HOME=/opt/app-root/src \
    RGW_POSIX_BASE_PATH=/var/lib/ceph/radosgw/buckets \
    RGW_POSIX_DATABASE_ROOT=/var/lib/ceph/radosgw/db

# Create the runtime user and application directories with OpenShift-compatible
# permissions. The base image only declares its own `ceph` user, but tools that
# resolve the current UID expect a passwd entry.
RUN useradd --uid 1001 --gid 0 --home-dir /opt/app-root/src \
            --no-create-home --shell /usr/sbin/nologin default && \
    mkdir -p /opt/app-root/bin/s4/backend \
             /opt/app-root/bin/s4/frontend \
             /opt/app-root/src/data \
             /var/lib/ceph/radosgw/buckets \
             /var/lib/ceph/radosgw/db \
             /var/lib/ceph/radosgw/db/rgw_posix_lmdbs \
             /var/run/ceph && \
    chown -R 1001:0 /opt/app-root /var/lib/ceph /var/run/ceph && \
    chmod -R g+rwX /opt/app-root /var/lib/ceph /var/run/ceph

# Copy configuration files (rarely change, good for caching)
COPY docker/config /etc/ceph/ceph.conf
COPY docker/entrypoint.sh /usr/local/bin/s4-entrypoint.sh

# Copy built backend from builder stage
COPY --from=node-builder --chown=1001:0 /tmp/src/backend/package*.json /opt/app-root/bin/s4/backend/
COPY --from=node-builder --chown=1001:0 /tmp/src/backend/dist /opt/app-root/bin/s4/backend/dist

# Copy built frontend from builder stage
COPY --from=node-builder --chown=1001:0 /tmp/src/frontend/dist /opt/app-root/bin/s4/frontend/dist

# Install production dependencies and set permissions in one layer
WORKDIR /opt/app-root/bin/s4/backend
RUN npm install --omit=dev && \
    npm cache clean --force && \
    # Set permissions for config and entrypoint
    chown 1001:0 /etc/ceph/ceph.conf /usr/local/bin/s4-entrypoint.sh && \
    chmod g+rw /etc/ceph/ceph.conf && \
    chmod +x /usr/local/bin/s4-entrypoint.sh

# Expose ports
# 7480 - Ceph RGW S3 API
# 5000 - Node.js Web UI
EXPOSE 7480 5000

# Environment variables with S4 defaults
ENV AWS_S3_ENDPOINT=http://localhost:7480 \
    AWS_ACCESS_KEY_ID=s4admin \
    AWS_SECRET_ACCESS_KEY=s4secret \
    AWS_DEFAULT_REGION=us-east-1 \
    PORT=5000 \
    IP=0.0.0.0 \
    NODE_ENV=production

# Set working directory
WORKDIR /opt/app-root/src

# Run as non-root user (OpenShift compatible: UID 1001, GID 0)
USER 1001

# Use custom entrypoint
ENTRYPOINT ["/usr/local/bin/s4-entrypoint.sh"]
