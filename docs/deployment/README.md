# Deployment Guide

S4 can be deployed as a standalone container or in Kubernetes/OpenShift environments.

## Deployment Options

### 1. Container Deployment (Docker/Podman)

Best for:

- Development and testing
- Single-server deployments
- Quick POCs and demos
- Local development environments

[View Docker/Podman Deployment Guide](./docker.md)

### 2. Kubernetes Deployment (Helm - Recommended)

Best for:

- Production environments
- GitOps workflows
- Easy configuration management
- Kubernetes and OpenShift deployments

[View Kubernetes Deployment Guide](./kubernetes.md) | [Helm Chart README](../../charts/s4/README.md)

### 3. OpenShift Deployment

Best for:

- Red Hat OpenShift environments
- Enterprise deployments
- Enhanced security requirements
- Integration with OpenShift ecosystem

[View OpenShift Deployment Guide](./openshift.md)

## Quick Start

### Docker/Podman

```bash
podman run -d \
  --name s4 \
  -p 5000:5000 \
  -p 7480:7480 \
  -v s4-data:/var/lib/ceph/radosgw \
  quay.io/rh-aiservices-bu/s4:latest
```

### Kubernetes (Helm)

```bash
helm install s4 ./charts/s4 --namespace s4 --create-namespace \
  --set auth.username=admin \
  --set auth.password=your-secure-password
kubectl port-forward svc/s4 5000:5000 7480:7480 -n s4
```

### Kubernetes (Raw Manifests)

```bash
kubectl apply -f kubernetes/
kubectl port-forward svc/s4 5000:5000 7480:7480
```

### OpenShift

```bash
oc apply -f kubernetes/
oc expose svc/s4
```

## Configuration

S4 is configured via environment variables. See [Configuration Guide](./configuration.md) for the complete reference.

Authentication is optional — set both `UI_USERNAME` and `UI_PASSWORD` to enable JWT-based auth. See [Security → Authentication](../security/authentication.md) for details.

## Storage

S4 requires one persistent volume (`/var/lib/ceph/radosgw`) for S3 data. Local filesystem browsing volumes are optional — see the [Quick Start Guide](../getting-started/README.md#storage-volumes) for details.

> **Upgrading from 0.3.x?** That is a breaking change: the storage engine was
> replaced (IBM `rgw-standalone` base image with the native POSIX driver) and
> **existing data from a prior installation will be lost**. See
> [Upgrading to 0.4](../operations/migration-0.4.md) before upgrading.

## Production Considerations

Before deploying to production, review:

- ✅ Enable authentication (`UI_USERNAME` and `UI_PASSWORD`)
- ✅ Use strong credentials and JWT secrets
- ✅ Deploy behind HTTPS (reverse proxy or Ingress/Route)
- ✅ Configure persistent storage
- ✅ Set up monitoring and logging
- ✅ Plan backup strategy

See [Production Readiness Guide](./production-readiness.md) for the complete checklist.

## Choosing Deployment Method

### Use Container Deployment When

- Development and testing
- Single-server deployment
- Simple POCs and demos
- Learning and evaluation
- No orchestration required

### Use Kubernetes/OpenShift When

- Production environments
- Managed pod lifecycle and automated restarts
- Persistent volume management
- Network policies and TLS termination via Ingress/Route
- Enterprise infrastructure integration

## Next Steps

1. Choose deployment method:

   - [Docker/Podman](./docker.md)
   - [Kubernetes](./kubernetes.md)
   - [OpenShift](./openshift.md)

2. Review [Configuration Guide](./configuration.md)

3. Check [Production Readiness Guide](./production-readiness.md)

4. Set up [monitoring and operations](../operations/monitoring.md)

## Related Documentation

- [Architecture Overview](../architecture/README.md) - System design and container architecture
- [Configuration Guide](./configuration.md) - Environment variables
- [Production Readiness](./production-readiness.md) - Production deployment checklist
- [Docker Deployment](./docker.md) - Container deployment details
- [Kubernetes Deployment](./kubernetes.md) - Kubernetes deployment details
- [OpenShift Deployment](./openshift.md) - OpenShift deployment details
- [Security Best Practices](../security/best-practices.md) - Security recommendations
