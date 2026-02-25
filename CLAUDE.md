# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note**: This file contains AI-specific development context. For user-facing documentation, see the [docs/](docs/) folder.

## Project Overview

**S4 (Super Simple Storage Service)** is a lightweight, self-contained S3-compatible storage solution combining:

- **Ceph RGW with SQLite backend** - Lightweight S3 server (based on zgw)
- **Node.js/React Web UI** - Storage management interface

Licensed under Apache 2.0.

## Development Commands

```bash
# Install dependencies
npm install

# Start development servers (backend + frontend)
npm run dev

# Build for production
npm run build

# Run tests
npm run test

# Build container image
make build

# Run container locally
make run

# Deploy to Kubernetes (Helm)
make deploy NAMESPACE=s4

# Deploy to Kubernetes (raw manifests)
make deploy-raw NAMESPACE=s4

# Lint Helm chart
make helm-lint
```

## Architecture

### Container Architecture

S4 runs as a single container with two processes managed by supervisord:

- **Ceph RGW** (port 7480) - S3-compatible API using SQLite for persistence
- **Node.js backend** (port 5000) - Fastify server serving React frontend and API

### Directory Structure

```
s4/
├── backend/               # Fastify API server (TypeScript)
│   └── src/
│       ├── routes/api/    # API endpoints (buckets, objects, notifications, settings, etc.)
│       ├── plugins/       # Auto-loaded Fastify plugins (auth)
│       ├── config/        # CORS configuration
│       ├── schemas/       # Request validation schemas
│       ├── types.ts       # TypeScript type definitions
│       ├── utils/         # Configuration, helpers, notifications
│       ├── __tests__/     # Jest tests
│       ├── app.ts         # Fastify app initialization
│       └── server.ts      # Entry point
├── frontend/              # React application (TypeScript)
│   └── src/
│       ├── app/
│       │   ├── components/  # UI components (StorageBrowser, Buckets, Settings)
│       │   ├── hooks/       # Custom hooks (useModal, useStorageLocations, useIsMobile)
│       │   ├── services/    # API service layer (storageService)
│       │   ├── utils/       # Utilities (apiClient, notifications, validation)
│       │   └── routes.tsx   # Route definitions
│       └── i18n/            # Internationalization
├── docker/                # Container configuration
│   ├── Dockerfile         # Multi-stage build
│   ├── ceph.conf          # RGW configuration
│   ├── entrypoint.sh      # Startup script
│   └── supervisord.conf   # Process management
├── charts/s4/             # Helm chart (recommended for K8s deployment)
│   ├── Chart.yaml         # Chart metadata
│   ├── values.yaml        # Default configuration values
│   └── templates/         # Kubernetes resource templates
└── kubernetes/            # Raw K8s manifests (legacy)
```

### Key Files

- `backend/src/app.ts` - Fastify app initialization, global auth hook
- `backend/src/utils/config.ts` - S3 client configuration (defaults to localhost:7480)
- `frontend/src/app/routes.tsx` - Frontend route definitions
- `docker/Dockerfile` - Container build (RGW base + Node.js)
- `docker/entrypoint.sh` - Creates RGW user on first run

## Version Management

The application version is defined in `package.json` (source of truth). To bump:

1. Update `version` in `package.json`
2. Run `npm run version:sync` — this syncs `appVersion` in `charts/s4/Chart.yaml`

Other consumers read from `package.json` automatically at build time:

- `Makefile` — uses it for the container image tag
- `frontend/webpack.common.js` — injects it as `process.env.APP_VERSION`

The `backend/package.json` and `frontend/package.json` versions are set to `0.0.0-see-root` and should not be changed.

## Default Configuration

### S3 Storage

S4 defaults to using its internal S3 engine:

- **Endpoint**: `http://localhost:7480`
- **Access Key**: `s4admin`
- **Secret Key**: `s4secret`

Override via environment variables for external S3 connections.

### Authentication

S4 supports optional JWT-based authentication:

- **Disabled (default)**: No `UI_USERNAME`/`UI_PASSWORD` set
- **Enabled**: Both `UI_USERNAME` and `UI_PASSWORD` set

For implementation details (JWT flow, SSE ticket system, CORS, rate limiting), see [backend/CLAUDE.md](backend/CLAUDE.md). For user-facing docs, see [docs/security/authentication.md](docs/security/authentication.md) and [docs/deployment/configuration.md](docs/deployment/configuration.md).

## Technology Stack

- **Backend**: Fastify 5, Node.js 20+, AWS SDK v3, TypeScript
- **Frontend**: React 18, PatternFly 6, React Router 7, TypeScript
- **S3 Engine**: Ceph RGW with DBStore (SQLite) backend
- **Container**: Based on `quay.io/rh-aiservices-bu/radosgw-posix` (Ceph RGW)

## Detailed Documentation

### For AI Assistants

Component-specific AI development context:

- **[Backend CLAUDE.md](backend/CLAUDE.md)** - Fastify API patterns, route development, testing, error handling
- **[Frontend CLAUDE.md](frontend/CLAUDE.md)** - React/PatternFly 6 components, styling, state management

### For Users and Developers

Complete user-facing documentation:

- **[Architecture](docs/architecture/)** - System design, backend/frontend architecture, container structure, data flow
- **[Development](docs/development/)** - Backend/frontend development guides, code style, testing, PatternFly 6 guide
- **[Deployment](docs/deployment/)** - Production readiness, configuration, Docker, Kubernetes, OpenShift
- **[API](docs/api/)** - Complete API reference with examples
- **[Security](docs/security/)** - Authentication, best practices, vulnerability management
- **[Operations](docs/operations/)** - Monitoring, troubleshooting, FAQ

## Production Readiness

S4 has undergone comprehensive cleanup and hardening for production use:

- ✅ **Security**: Header sanitization, input validation, credential protection
- ✅ **Type Safety**: Comprehensive TypeScript types, minimal `as any` usage
- ✅ **Code Quality**: Centralized utilities, consistent error handling
- ✅ **Logging**: Standardized logging patterns throughout

For complete production deployment guidance, see [docs/deployment/production-readiness.md](docs/deployment/production-readiness.md).

**Note**: Some features (rate limiting, audit logging) use in-memory implementations suitable for development but require persistence solutions for production multi-instance deployments.
