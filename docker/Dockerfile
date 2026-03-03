# =============================================================================
# S4 - Super Simple Storage Service
# Combined container with Ceph RGW (SQLite backend) + Node.js Web UI
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
# Stage 2: Final Image
# Ceph RGW daemon with Node.js runtime
# -----------------------------------------------------------------------------
FROM quay.io/rh-aiservices-bu/radosgw-posix:0.1.0

LABEL name="s4" \
      summary="S4 - Super Simple Storage Service" \
      description="Lightweight S3-compatible storage with web UI" \
      io.k8s.display-name="S4" \
      io.k8s.description="S4 combines Ceph RGW with SQLite backend and a web management UI" \
      maintainer="Red Hat AI Services BU"

USER root

# Install Node.js, supervisor, s5cmd, and clean up in a single layer
# Base image is CentOS Stream 10 which provides Node.js 22 via appstream
RUN dnf update -y && \
    dnf install -y nodejs npm supervisor && \
    dnf clean all && \
    rm -rf /var/cache/dnf && \
    # Install s5cmd for S3 debugging/administration
    curl -LO https://github.com/peak/s5cmd/releases/download/v2.2.2/s5cmd_2.2.2_Linux-64bit.tar.gz && \
    tar xzf s5cmd_2.2.2_Linux-64bit.tar.gz && \
    mv s5cmd /usr/local/bin/ && \
    rm -f s5cmd_2.2.2_Linux-64bit.tar.gz LICENSE

# Create application directories with OpenShift-compatible permissions
RUN mkdir -p /opt/app-root/bin/s4/backend \
             /opt/app-root/bin/s4/frontend \
             /opt/app-root/src/data \
             /var/lib/ceph/radosgw/{db,buckets,tmp} && \
    chown -R 1001:0 /opt/app-root /var/lib/ceph && \
    chmod -R g+rwX /opt/app-root /var/lib/ceph

# Copy configuration files (rarely change, good for caching)
COPY docker/config /etc/ceph/ceph.conf
COPY docker/supervisord.conf /etc/supervisord.conf
COPY docker/entrypoint.sh /opt/ceph-container/bin/entrypoint.sh

# Copy built backend from builder stage
COPY --from=node-builder --chown=1001:0 /tmp/src/backend/package*.json /opt/app-root/bin/s4/backend/
COPY --from=node-builder --chown=1001:0 /tmp/src/backend/dist /opt/app-root/bin/s4/backend/dist

# Copy built frontend from builder stage
COPY --from=node-builder --chown=1001:0 /tmp/src/frontend/dist /opt/app-root/bin/s4/frontend/dist

# Install production dependencies and set permissions in one layer
WORKDIR /opt/app-root/bin/s4/backend
RUN npm install --omit=dev && \
    npm cache clean --force && \
    # Set permissions for config files and directories
    chown 1001:0 /etc/ceph/ceph.conf /etc/supervisord.conf /opt/ceph-container/bin/entrypoint.sh && \
    chmod g+rw /etc/ceph/ceph.conf /etc/supervisord.conf && \
    chmod +x /opt/ceph-container/bin/entrypoint.sh && \
    chown -R 1001:0 /var/log /var/run && \
    chmod -R g+rwX /var/log /var/run

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
ENTRYPOINT ["/opt/ceph-container/bin/entrypoint.sh"]
