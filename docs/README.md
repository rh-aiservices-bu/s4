# S4 Documentation

Welcome to the S4 (Super Simple Storage Service) documentation. This guide will help you get started with S4, understand its architecture, use its APIs, and deploy it in production.

## 📚 Documentation Structure

### [User Guide](user-guide/)

Complete end-user documentation for using S4.

- **[User Guide](user-guide/README.md)** - Comprehensive guide for using S4's web interface

### [Getting Started](getting-started/)

Quick start guide, installation procedures, and basic configuration.

- **[Quick Start](getting-started/README.md)** - Get S4 running in 5 minutes
- **[Installation](getting-started/installation.md)** - Detailed installation procedures
- **[Configuration](getting-started/configuration.md)** - Basic configuration options

### [Architecture](architecture/)

System design, components, and technical architecture.

- **[Architecture Overview](architecture/README.md)** - High-level system design
- **[Backend Architecture](architecture/backend.md)** - Fastify API server internals
- **[Frontend Architecture](architecture/frontend.md)** - React application structure
- **[Container Architecture](architecture/container.md)** - Base image, process supervision, and data layout

### [API Reference](api/)

Complete REST API documentation with examples.

- **[API Overview](api/README.md)** - Authentication and common patterns
- **[Buckets API](api/buckets.md)** - S3 bucket operations
- **[Objects API](api/objects.md)** - S3 object operations
- **[Notifications API](api/notifications.md)** - Bucket notification webhooks
- **[Transfer API](api/transfer.md)** - Cross-storage file transfers
- **[Settings API](api/settings.md)** - Configuration management
- **[Local Storage API](api/local.md)** - Local filesystem operations
- **[API Examples](api/examples.md)** - Practical usage examples

### [Development](development/)

Development setup, testing, and contribution guidelines.

- **[Development Setup](development/README.md)** - Local development environment
- **[Backend Development](development/backend.md)** - Fastify patterns and conventions
- **[Frontend Development](development/frontend.md)** - React and PatternFly 6 guide
- **[Testing Guide](development/testing.md)** - Testing strategies and tools
- **[Contributing](development/contributing.md)** - How to contribute to S4
- **[Code Style](development/code-style.md)** - Coding standards and conventions
- **[PatternFly 6 Guide](development/pf6-guide/README.md)** - PatternFly 6 component patterns and best practices

### [Deployment](deployment/)

Production deployment guides for Docker, Kubernetes, and OpenShift.

- **[Deployment Overview](deployment/README.md)** - Deployment options and planning
- **[Docker Deployment](deployment/docker.md)** - Docker and Podman deployment
- **[Kubernetes Deployment](deployment/kubernetes.md)** - Kubernetes manifests and setup
- **[OpenShift Deployment](deployment/openshift.md)** - OpenShift-specific guide
- **[Configuration Reference](deployment/configuration.md)** - Environment variables reference
- **[Production Readiness](deployment/production-readiness.md)** - Production deployment checklist

### [Security](security/)

Security policies, authentication, and vulnerability management.

- **[Security Overview](security/README.md)** - Security policy and reporting
- **[Authentication](security/authentication.md)** - JWT and SSE authentication details
- **[Vulnerability Management](security/vulnerability-management.md)** - Dependency audit status
- **[Security Best Practices](security/best-practices.md)** - Secure deployment practices

### [Operations](operations/)

Monitoring, troubleshooting, and operational guides.

- **[Operations Overview](operations/README.md)** - Operations documentation hub
- **[Monitoring](operations/monitoring.md)** - Observability and monitoring
- **[Troubleshooting](operations/troubleshooting.md)** - Common issues and solutions
- **[Error Reference](operations/error-reference.md)** - Complete error message reference
- **[Upgrading to 0.4](operations/migration-0.4.md)** - Breaking-change migration (base image, data reset)
- **[FAQ](operations/faq.md)** - Frequently asked questions

## 🚀 Quick Links

- **New to S4?** Start with the [Quick Start Guide](getting-started/README.md)
- **Using S4?** See the [User Guide](user-guide/README.md)
- **Setting up for development?** See [Development Setup](development/README.md)
- **Deploying to production?** Check [Production Readiness](deployment/production-readiness.md)
- **Need API docs?** Browse the [API Reference](api/README.md)
- **Security questions?** Read the [Security Overview](security/README.md)

## 🔍 Finding What You Need

- **Installation**: [Getting Started → Installation](getting-started/installation.md)
- **Environment Variables**: [Deployment → Configuration Reference](deployment/configuration.md)
- **Authentication Setup**: [Security → Authentication](security/authentication.md)
- **API Endpoints**: [API Reference](api/README.md)
- **Kubernetes/OpenShift**: [Deployment Section](deployment/)
- **Troubleshooting**: [Operations → Troubleshooting](operations/troubleshooting.md)

## 📖 About S4

S4 (Super Simple Storage Service) is a lightweight, self-contained S3-compatible storage solution combining:

- **Ceph RGW with SQLite backend** - Lightweight S3 server
- **Node.js/React Web UI** - Storage management interface

Perfect for POCs, development environments, demos, and simple deployments where a full-scale object storage solution is overkill.

## 📝 License

S4 is licensed under the Apache 2.0 License.

## 🤝 Support

- **GitHub Issues**: https://github.com/rh-aiservices-bu/s4/issues
- **Discussions**: https://github.com/rh-aiservices-bu/s4/discussions
