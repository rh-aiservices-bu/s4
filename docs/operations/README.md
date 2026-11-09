# Operations Guide

Operations documentation for monitoring, troubleshooting, and managing S4 in production.

## In This Section

- **[Monitoring](monitoring.md)** - Observability, health checks, and metrics
- **[Upgrading to 0.4](migration-0.4.md)** - Breaking-change migration from 0.3.x to 0.4+ (base image, data reset)
- **[Troubleshooting](troubleshooting.md)** - Common issues and solutions
- **[Error Reference](error-reference.md)** - Complete error message reference with causes and resolutions
- **[FAQ](faq.md)** - Frequently asked questions

## Quick Operations Tasks

### Health Checks

```bash
# Check API health
curl http://localhost:5000/api/auth/info

# Check S3 endpoint
curl http://localhost:7480

# View container logs
kubectl logs -l app=s4
```

### Common Debugging

- **Container won't start**: See [Troubleshooting → Container Issues](troubleshooting.md#container-startup-issues)
- **S3 connection failed**: See [Troubleshooting → S3 Connectivity](troubleshooting.md#s3-connectivity-issues)
- **Authentication errors**: See [Troubleshooting → Authentication](troubleshooting.md#authentication-issues)

## Related Documentation

- [Deployment → Production Readiness](../deployment/production-readiness.md) - Pre-production checklist
- [Security → Best Practices](../security/best-practices.md) - Security hardening
- [Architecture](../architecture/) - System design and components
