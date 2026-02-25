# Installation

> For the fastest way to get S4 running, see the [Quick Start Guide](README.md). This page covers detailed installation options, building from source, and verification.

This guide covers installing S4 using containers, Kubernetes, or building from source.

## Prerequisites

### Container Runtime

Choose one:

- **Podman** (recommended) - Red Hat's daemonless container engine
- **Docker** - Traditional container runtime

### Kubernetes/OpenShift (Optional)

For Kubernetes deployment:

- Kubernetes 1.24+
- `kubectl` CLI tool
- Cluster access with sufficient permissions

For OpenShift deployment:

- OpenShift 4.10+
- `oc` CLI tool
- Cluster access

## Container Installation

### Using Podman (Recommended)

#### Basic Installation

```bash
# Pull the latest image
podman pull quay.io/rh-aiservices-bu/s4:latest

# Run with persistent storage
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -v s4-data:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest

# Verify it's running
podman ps

# Check logs
podman logs s4
```

#### With Custom Configuration

```bash
# Create environment file
cat > s4.env << EOF
AWS_ACCESS_KEY_ID=myadmin
AWS_SECRET_ACCESS_KEY=mysecretkey
UI_USERNAME=admin
UI_PASSWORD=secure-password
HF_TOKEN=hf_your_token_here
EOF

# Run with environment file
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  --env-file s4.env \
  -v s4-data:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest
```

### Using Docker

Replace `podman` with `docker` in the above commands:

```bash
docker pull quay.io/rh-aiservices-bu/s4:latest
docker run -d --name s4 ...
```

### Container Management

```bash
# Stop container
podman stop s4

# Start container
podman start s4

# Restart container
podman restart s4

# Remove container (data persists in volumes)
podman rm s4

# Remove container and volumes (⚠️ deletes all data)
podman rm -v s4
podman volume rm s4-data
```

## Kubernetes Installation

### Quick Deploy

```bash
# Clone repository
git clone https://github.com/rh-aiservices-bu/s4.git
cd s4

# Deploy all resources
kubectl apply -f kubernetes/

# Check deployment status
kubectl get pods -l app=s4

# Port-forward to access locally
kubectl port-forward svc/s4 5000:5000 7480:7480
```

### Manual Deployment

1. **Create namespace** (optional):

```bash
kubectl create namespace s4
kubectl config set-context --current --namespace=s4
```

2. **Create secrets**:

```bash
kubectl create secret generic s4-credentials \
  --from-literal=AWS_ACCESS_KEY_ID=s4admin \
  --from-literal=AWS_SECRET_ACCESS_KEY=s4secret \
  --from-literal=UI_USERNAME=admin \
  --from-literal=UI_PASSWORD=secure-password
```

3. **Create PersistentVolumeClaims**:

```bash
kubectl apply -f kubernetes/s4-pvc.yaml
```

4. **Deploy application**:

```bash
kubectl apply -f kubernetes/s4-deployment.yaml
```

5. **Create service**:

```bash
kubectl apply -f kubernetes/s4-service.yaml
```

6. **Create ingress** (optional):

```bash
kubectl apply -f kubernetes/s4-ingress.yaml
```

For detailed Kubernetes deployment, see [Deployment → Kubernetes](../deployment/kubernetes.md).

## OpenShift Installation

### Using `oc` CLI

```bash
# Login to OpenShift
oc login https://api.your-cluster.com

# Create project
oc new-project s4

# Create secrets
oc create secret generic s4-credentials \
  --from-literal=AWS_ACCESS_KEY_ID=s4admin \
  --from-literal=AWS_SECRET_ACCESS_KEY=s4secret \
  --from-literal=UI_USERNAME=admin \
  --from-literal=UI_PASSWORD=secure-password

# Deploy application
oc apply -f kubernetes/

# Create route for external access
oc expose svc/s4 --port=5000 --name=s4-ui
oc expose svc/s4 --port=7480 --name=s4-api
```

### Using OpenShift Console

1. Navigate to **Administrator** → **Projects** → **Create Project**
2. Enter project name: `s4`
3. Navigate to **Workloads** → **Secrets** → **Create** → **Key/value secret**
4. Add S4 credentials
5. Navigate to **Workloads** → **Deployments** → **Create Deployment**
6. Import YAML from `kubernetes/s4-deployment.yaml`
7. Navigate to **Networking** → **Routes** → **Create Route**
8. Configure route for Web UI (port 5000)

For detailed OpenShift deployment, see [Deployment → OpenShift](../deployment/openshift.md).

## Building from Source

### Prerequisites

- Node.js 20+ and npm
- Make
- Container runtime (Podman/Docker)

### Build Steps

```bash
# Clone repository
git clone https://github.com/rh-aiservices-bu/s4.git
cd s4

# Install dependencies
npm install

# Build container image
make build

# Run locally
make run

# Or run development servers (UI only, no RGW)
npm run dev
```

### Development Mode

Development mode starts only the Node.js backend (port 8888) and React frontend (port 9000) for UI development. It does **not** start the Ceph RGW S3 engine.

To develop against a working S3 backend, either:

- Run the full S4 container (`make run`) and configure your dev environment to use `http://localhost:7480`
- Point to an external S3-compatible service via environment variables

For detailed development setup, see [Development → Setup](../development/README.md).

### Build Container Image

```bash
# Build with custom tag
make build TAG=my-custom-tag

# Push to registry
make login  # Login to quay.io
make push TAG=my-custom-tag
```

### Deploy Custom Build to Kubernetes

```bash
# Build and push image
make build TAG=v1.0.0
make push TAG=v1.0.0

# Update deployment to use custom image
kubectl set image deployment/s4 s4=quay.io/your-org/s4:v1.0.0

# Or edit deployment YAML
kubectl edit deployment s4
```

## Verification

After installation, verify S4 is working:

### Container Installation

```bash
# Check container is running
podman ps | grep s4

# Check logs for startup messages
podman logs s4

# Test Web UI
curl -I http://localhost:5000

# Test S3 API
curl -I http://localhost:7480
```

### Kubernetes Installation

```bash
# Check pod status
kubectl get pods -l app=s4

# Check pod logs
kubectl logs -l app=s4 --tail=50

# Port-forward and test
kubectl port-forward svc/s4 5000:5000 &
curl -I http://localhost:5000
```

### Functional Test

```bash
# Configure AWS CLI
export AWS_ACCESS_KEY_ID=s4admin
export AWS_SECRET_ACCESS_KEY=s4secret
export AWS_ENDPOINT_URL=http://localhost:7480

# Create test bucket
aws s3 mb s3://test-bucket

# Upload test file
echo "Hello S4" > test.txt
aws s3 cp test.txt s3://test-bucket/

# Verify upload
aws s3 ls s3://test-bucket/

# Clean up
aws s3 rm s3://test-bucket/test.txt
aws s3 rb s3://test-bucket
```

## Next Steps

- **[Configuration](configuration.md)** - Configure S4 with environment variables
- **[Deployment](../deployment/README.md)** - Production deployment guides
- **[API Reference](../api/README.md)** - Explore the S3 API

## Troubleshooting

### Image Pull Failures

```bash
# Verify image exists
podman pull quay.io/rh-aiservices-bu/s4:latest

# Use specific tag if latest fails
podman pull quay.io/rh-aiservices-bu/s4:v1.0.0
```

### Port Already in Use

```bash
# Check what's using the port
lsof -i :5000
lsof -i :7480

# Use different ports
podman run -p 8000:5000 -p 8480:7480 ...
```

### Permission Denied (Volumes)

```bash
# On SELinux systems, use :Z flag
podman run -v s4-data:/var/lib/ceph/radosgw:Z ...

# Or create volumes first
podman volume create s4-data
```

For more troubleshooting, see [Operations → Troubleshooting](../operations/troubleshooting.md).
