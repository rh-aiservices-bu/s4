# Docker/Podman Deployment

Comprehensive guide for deploying S4 using Docker or Podman containers.

## Overview

S4 is distributed as a single container image that includes:

- Ceph RGW (S3-compatible API on port 7480)
- Node.js backend + React frontend (Web UI on port 5000)
- Supervisord for process management

**Image**: `quay.io/rh-aiservices-bu/s4:latest`

## Prerequisites

- Docker 20.10+ or Podman 3.0+
- At least 2GB RAM
- 10GB disk space for data volumes

## Quick Start

```bash
# Using Podman (recommended for rootless containers)
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -v s4-data:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest

# Using Docker
docker run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -v s4-data:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest

# Access the web UI
open http://localhost:5000
```

## Basic Operations

### Start Container

```bash
# Using Makefile (detects podman/docker automatically)
make run

# Manual start
podman start s4
```

### Stop Container

```bash
# Using Makefile
make stop

# Manual stop
podman stop s4
podman rm s4
```

### View Logs

```bash
# All logs
podman logs s4

# Follow logs
podman logs -f s4

# Last 100 lines
podman logs --tail 100 s4
```

Both processes (RGW and Node.js) log to the container's stdout/stderr; there are
no per-process log files. Use `podman logs s4 | grep -i rgw` to isolate RGW
output.

### Restart Container

```bash
podman restart s4
```

## Configuration

### Environment Variables

Configure S4 using environment variables with `-e` flag:

```bash
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -e AWS_ACCESS_KEY_ID=myadmin \
  -e AWS_SECRET_ACCESS_KEY=mysecret \
  -e UI_USERNAME=admin \
  -e UI_PASSWORD=pass \
  -e JWT_SECRET=your-secret-key \
  -v s4-data:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest
```

### Using Environment File

Create `.env` file:

```bash
# .env
AWS_ACCESS_KEY_ID=myadmin
AWS_SECRET_ACCESS_KEY=mysecret
UI_USERNAME=admin
UI_PASSWORD=pass
JWT_SECRET=your-secret-key
MAX_FILE_SIZE_GB=20
MAX_CONCURRENT_TRANSFERS=2
```

Run with environment file:

```bash
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  --env-file .env \
  -v s4-data:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest
```

### Key Configuration Variables

| Variable                   | Default                 | Description                      |
| -------------------------- | ----------------------- | -------------------------------- |
| `AWS_ACCESS_KEY_ID`        | `s4admin`               | S3 access key                    |
| `AWS_SECRET_ACCESS_KEY`    | `s4secret`              | S3 secret key                    |
| `AWS_S3_ENDPOINT`          | `http://localhost:7480` | S3 endpoint URL                  |
| `AWS_DEFAULT_REGION`       | `us-east-1`             | AWS region                       |
| `UI_USERNAME`              | (none)                  | UI login username (enables auth) |
| `UI_PASSWORD`              | (none)                  | UI login password (enables auth) |
| `JWT_SECRET`               | (auto)                  | JWT signing secret               |
| `JWT_EXPIRATION_HOURS`     | `8`                     | JWT token expiration             |
| `PORT`                     | `5000`                  | Web UI port                      |
| `MAX_FILE_SIZE_GB`         | `20`                    | Max upload file size             |
| `MAX_CONCURRENT_TRANSFERS` | `2`                     | Max concurrent transfers         |

> **⚠️ Security Warning**: The default internal S3 credentials (`s4admin`/`s4secret`) are for development only. While the S3 endpoint is not exposed externally by default, you should change these credentials in production for defense-in-depth. Set custom values via `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables.

See [Configuration Guide](./configuration.md) for complete reference.

## Persistent Storage

### Volumes

S4 requires one persistent volume. Local filesystem browsing volumes are optional.

1. **S3 Data** (required) — `/var/lib/ceph/radosgw`

   - Stores S3 bucket metadata and objects
   - SQLite database for RGW
   - Critical for data persistence

2. **Local Storage** (optional) — mount path of your choice
   - Enables local filesystem browsing and S3 ↔ local transfers
   - Requires **both** a volume mount **and** the `LOCAL_STORAGE_PATHS` environment variable
   - Without `LOCAL_STORAGE_PATHS`, mounted volumes are not visible in the UI

### Named Volumes (Recommended)

```bash
# Create named volume
podman volume create s4-data

# Run with named volume
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -v s4-data:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest

# Inspect volumes
podman volume inspect s4-data
podman volume ls
```

### Bind Mounts (Host Directory)

```bash
# Create directory on host
mkdir -p /data/s4/rgw

# Set permissions (if running rootless)
chmod 777 /data/s4/rgw

# Run with bind mount
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -v /data/s4/rgw:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest
```

### Local Filesystem Browsing

S4 can browse and transfer files between local volumes and S3 buckets. To enable this, mount one or more volumes and set `LOCAL_STORAGE_PATHS` to tell S4 which container paths to expose in the UI.

**Single local storage path:**

```bash
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -v s4-data:/var/lib/ceph/radosgw \
  -v /host/models:/models \
  -e LOCAL_STORAGE_PATHS=/models \
  quay.io/rh-aiservices-bu/s4:latest
```

**Multiple local storage paths:**

```bash
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -v s4-data:/var/lib/ceph/radosgw \
  -v /host/models:/models \
  -v /host/datasets:/datasets \
  -e LOCAL_STORAGE_PATHS=/models,/datasets \
  quay.io/rh-aiservices-bu/s4:latest
```

**Using a named volume for local storage:**

```bash
podman volume create s4-storage

podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -v s4-data:/var/lib/ceph/radosgw \
  -v s4-storage:/opt/app-root/src/data \
  -e LOCAL_STORAGE_PATHS=/opt/app-root/src/data \
  quay.io/rh-aiservices-bu/s4:latest
```

> **Note**: If `LOCAL_STORAGE_PATHS` is not set, local filesystem browsing is disabled and S4 operates in S3-only mode.

### Volume Backup

```bash
# Stop container
podman stop s4

# Backup named volume
podman run --rm \
  -v s4-data:/source \
  -v $(pwd):/backup \
  alpine tar czf /backup/s4-data-backup.tar.gz -C /source .

# Restore named volume
podman run --rm \
  -v s4-data:/target \
  -v $(pwd):/backup \
  alpine tar xzf /backup/s4-data-backup.tar.gz -C /target

# Start container
podman start s4
```

## Networking

### Port Mapping

Map container ports to host ports:

```bash
# Default ports
-p 5000:5000  # Web UI
-p 7480:7480  # S3 API

# Custom host ports
-p 8080:5000  # Web UI on 8080
-p 9000:7480  # S3 API on 9000
```

### Network Modes

#### Bridge Network (Default)

```bash
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  quay.io/rh-aiservices-bu/s4:latest
```

#### Host Network

```bash
# Shares host network namespace
podman run -d \
  --name s4 \
  --network host \
  quay.io/rh-aiservices-bu/s4:latest
```

#### Custom Network

```bash
# Create custom network
podman network create s4-network

# Run on custom network
podman run -d \
  --name s4 \
  --network s4-network \
  -p 5000:5000 \
  -p 7480:7480 \
  quay.io/rh-aiservices-bu/s4:latest
```

## Resource Limits

### Memory

```bash
# Limit memory to 2GB
podman run -d \
  --name s4 \
  --memory 2g \
  --memory-swap 2g \
  -p 5000:5000 \
  -p 7480:7480 \
  quay.io/rh-aiservices-bu/s4:latest
```

### CPU

```bash
# Limit to 2 CPUs
podman run -d \
  --name s4 \
  --cpus 2 \
  -p 5000:5000 \
  -p 7480:7480 \
  quay.io/rh-aiservices-bu/s4:latest
```

### Combined Limits

```bash
podman run -d \
  --name s4 \
  --memory 2g \
  --cpus 2 \
  -p 5000:5000 \
  -p 7480:7480 \
  quay.io/rh-aiservices-bu/s4:latest
```

## Running with Authentication

### Enable Authentication

```bash
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -e UI_USERNAME=admin \
  -e UI_PASSWORD=your-secure-password \
  -e JWT_SECRET=your-random-secret-key \
  -v s4-data:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest
```

### Using Secrets (Podman)

```bash
# Create secrets
echo "admin" | podman secret create s4_username -
echo "your-secure-password" | podman secret create s4_password -
echo "your-random-secret-key" | podman secret create s4_jwt_secret -

# Run with secrets
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  --secret s4_username,type=env,target=UI_USERNAME \
  --secret s4_password,type=env,target=UI_PASSWORD \
  --secret s4_jwt_secret,type=env,target=JWT_SECRET \
  -v s4-data:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest
```

## External S3 Connection

Configure S4 to use external S3 instead of internal RGW:

```bash
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -e AWS_S3_ENDPOINT=https://s3.amazonaws.com \
  -e AWS_ACCESS_KEY_ID=your-aws-key \
  -e AWS_SECRET_ACCESS_KEY=your-aws-secret \
  -e AWS_DEFAULT_REGION=us-east-1 \
  quay.io/rh-aiservices-bu/s4:latest

# Note: Port 7480 not needed when using external S3
```

## Reverse Proxy Setup

### Nginx

```nginx
# nginx.conf
server {
    listen 80;
    server_name s4.example.com;

    # Web UI
    location / {
        proxy_pass http://localhost:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # S3 API
    location /s3/ {
        proxy_pass http://localhost:7480/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Traefik

```yaml
# docker-compose.yml
version: '3'
services:
  s4:
    image: quay.io/rh-aiservices-bu/s4:latest
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.s4.rule=Host(`s4.example.com`)'
      - 'traefik.http.services.s4.loadbalancer.server.port=5000'
    volumes:
      - s4-data:/var/lib/ceph/radosgw

  traefik:
    image: traefik:v2.10
    command:
      - '--providers.docker=true'
      - '--entrypoints.web.address=:80'
    ports:
      - '80:80'
    volumes:
      - '/var/run/docker.sock:/var/run/docker.sock:ro'

volumes:
  s4-data:
```

## Docker Compose

### Basic Deployment

```yaml
# docker-compose.yml
version: '3.8'

services:
  s4:
    image: quay.io/rh-aiservices-bu/s4:latest
    container_name: s4
    ports:
      - '5000:5000'
      - '7480:7480'
    environment:
      - AWS_ACCESS_KEY_ID=s4admin
      - AWS_SECRET_ACCESS_KEY=s4secret
      - UI_USERNAME=admin
      - UI_PASSWORD=pass
    volumes:
      - s4-data:/var/lib/ceph/radosgw
    restart: unless-stopped

volumes:
  s4-data:
```

### With Local Filesystem Browsing

```yaml
# docker-compose.yml
version: '3.8'

services:
  s4:
    image: quay.io/rh-aiservices-bu/s4:latest
    container_name: s4
    ports:
      - '5000:5000'
      - '7480:7480'
    environment:
      - AWS_ACCESS_KEY_ID=s4admin
      - AWS_SECRET_ACCESS_KEY=s4secret
      - UI_USERNAME=admin
      - UI_PASSWORD=pass
      - LOCAL_STORAGE_PATHS=/models,/datasets
    volumes:
      - s4-data:/var/lib/ceph/radosgw
      - ./models:/models
      - ./datasets:/datasets
    restart: unless-stopped

volumes:
  s4-data:
```

### Start/Stop

```bash
# Start
docker-compose up -d

# Stop
docker-compose down

# View logs
docker-compose logs -f

# Restart
docker-compose restart
```

## Building from Source

### Build Image

```bash
# Using Makefile
make build

# Manual build
podman build -t s4:local -f docker/Dockerfile .
```

### Run Local Build

```bash
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -v s4-data:/var/lib/ceph/radosgw \
  s4:local
```

### Push to Registry

```bash
# Tag image
podman tag s4:local quay.io/your-org/s4:latest

# Login to registry
make login
# Or manually
podman login quay.io

# Push
make push
# Or manually
podman push quay.io/your-org/s4:latest
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
podman logs s4

# Check if ports are available
sudo lsof -i :5000
sudo lsof -i :7480

# Check container status
podman ps -a | grep s4

# Inspect container
podman inspect s4
```

### Permission Issues (Rootless)

```bash
# Fix volume permissions
podman unshare chown -R 0:0 /data/s4/rgw
podman unshare chown -R 0:0 /data/s4/storage

# Or run with correct user mapping
podman run -d \
  --name s4 \
  --userns=keep-id \
  -p 5000:5000 \
  -p 7480:7480 \
  -v s4-data:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest
```

### S3 Connection Issues

```bash
# Test S3 endpoint
curl http://localhost:7480/

# Check RGW logs
podman logs s4 | grep -i rgw

# Verify S3 credentials
podman exec s4 env | grep AWS
```

### Web UI Not Accessible

```bash
# Check backend logs
podman logs s4 | grep -i node

# Check if backend is running
podman exec s4 ps aux | grep node

# Test web UI port
curl http://localhost:5000/
```

## Production Recommendations

### Security

- ✅ Enable authentication (`UI_USERNAME`, `UI_PASSWORD`)
- ✅ Use strong, random credentials
- ✅ Set custom JWT secret
- ✅ Deploy behind HTTPS reverse proxy
- ✅ Use Podman secrets for sensitive data
- ✅ Restrict network access with firewall

### Reliability

- ✅ Use named volumes for data persistence
- ✅ Set restart policy: `--restart=unless-stopped`
- ✅ Configure resource limits
- ✅ Set up monitoring and logging
- ✅ Regular backups of volumes

### Performance

- ✅ Allocate sufficient memory (2GB+)
- ✅ Use SSD for volume storage
- ✅ Adjust `MAX_CONCURRENT_TRANSFERS` based on workload
- ✅ Monitor resource usage

See [Production Readiness Guide](./production-readiness.md) for complete checklist.

## Related Documentation

- [Configuration Guide](./configuration.md) - Environment variables reference
- [Production Readiness](./production-readiness.md) - Production deployment checklist
- [Kubernetes Deployment](./kubernetes.md) - Kubernetes deployment
- [Monitoring](../operations/monitoring.md) - Monitoring and logging
- [Troubleshooting](../operations/troubleshooting.md) - Common issues
