# Architecture Overview

S4 is a lightweight, self-contained S3-compatible storage solution with a web-based management interface.

## High-Level Architecture

```txt
┌─────────────────────────────────────────────┐
│                S4 Container                  │
├─────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌──────────────────┐ │
│  │   Web UI (5000) │  │  S3 API (7480)   │ │
│  │   Node.js +     │  │   Ceph RGW +     │ │
│  │   React         │  │   SQLite         │ │
│  └────────┬────────┘  └────────┬─────────┘ │
│           │                    │            │
│           └────────────────────┘            │
│                    │                        │
│  ┌─────────────────┴──────────────────────┐│
│  │           Persistent Storage            ││
│  │  /var/lib/ceph/radosgw (S3 data)       ││
│  │  /opt/app-root/src/data (local files)  ││
│  └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

## Components

### 1. Web UI (Port 5000)

**Technology**: React 18 + PatternFly 6 + TypeScript

**Responsibilities**:

- Web-based file browser for S3 buckets and local storage
- Bucket management (create, delete, browse)
- Bucket notification management (webhook configuration)
- Object operations (upload, download, delete)
- Cross-storage file transfers
- HuggingFace model import
- Settings and configuration management
- Optional JWT-based authentication

**Key Features**:

- Single-page application (SPA)
- Real-time progress tracking via Server-Sent Events (SSE)
- Responsive design with PatternFly 6
- Dark mode support

See [Frontend Architecture](frontend.md) for details.

### 2. API Server (Port 5000)

**Technology**: Fastify 5 + Node.js 20+ + TypeScript

**Responsibilities**:

- RESTful API for storage operations
- Serves static frontend files in production
- S3 SDK integration (AWS SDK v3)
- Filesystem-based bucket notification watching with webhook dispatch
- JWT-based authentication (optional)
- SSE endpoints for real-time progress
- Request validation and error handling
- Streaming file transfers

**Key Features**:

- Fastify plugin architecture
- Type-safe TypeScript
- Centralized error handling
- Streaming-first design (no intermediate storage)
- Rate limiting on sensitive endpoints
- CORS support for development

See [Backend Architecture](backend.md) for details.

### 3. S3 Storage Engine (Port 7480)

**Technology**: Ceph RGW with DBStore (SQLite) backend

**Responsibilities**:

- S3-compatible API (AWS S3 protocol)
- Object storage and retrieval
- Bucket management
- Metadata storage in SQLite

**Key Features**:

- Lightweight alternative to full Ceph cluster
- SQLite-backed (no external database required)
- Single-node deployment
- Compatible with AWS S3 CLI and SDKs
- Based on [zgw](https://github.com/mmgaggle/zgw)

**Limitations**:

- Not suitable for millions of objects (SQLite limitations)
- Single-node only (no clustering)
- Best for POCs, demos, development

### 4. Process Manager

**Technology**: Supervisord

**Responsibilities**:

- Manages RGW and Node.js processes
- Automatic process restart on failure
- Centralized logging

See [Container Architecture](container.md) for details.

## Data Flow

### Upload Flow

```
User → Web UI → Fastify API → S3 Client → RGW → SQLite
              (streaming)      (streaming)
```

1. User selects file in Web UI
2. Frontend sends file to `/api/objects/upload/:bucketName/:encodedKey`
3. Fastify streams file directly to S3 using `@aws-sdk/lib-storage`
4. RGW stores object and metadata in SQLite
5. Progress updates sent via SSE to frontend

### Download Flow

```
User → Web UI → Fastify API → S3 Client → RGW → SQLite
              (streaming)      (streaming)
```

1. User clicks download in Web UI
2. Frontend requests `/api/objects/download/:bucketName/:encodedKey`
3. Fastify streams object from S3
4. Browser downloads file directly from stream

### Transfer Flow (S3 ↔ Local)

```
Source → Fastify → Destination
        (streaming, concurrent)
```

1. User initiates transfer in Web UI
2. Frontend calls `/api/transfer` with source and destination
3. Fastify creates transfer job
4. Worker streams files from source to destination
5. Progress updates sent via SSE
6. Supports concurrent transfers (default: 2)

## Directory Structure

```
s4/
├── backend/               # Fastify API server (TypeScript)
│   └── src/
│       ├── routes/api/    # API endpoints
│       │   ├── auth/      # Authentication endpoints
│       │   ├── buckets/   # Bucket operations
│       │   ├── objects/   # Object operations
│       │   ├── notifications/ # Bucket notification management
│       │   ├── transfer/  # Transfer operations
│       │   ├── settings/  # Configuration management
│       │   └── local/     # Local filesystem operations
│       ├── utils/         # Configuration, helpers, logging
│       ├── plugins/       # Fastify plugins
│       ├── types.ts       # TypeScript type definitions
│       └── server.ts      # Entry point
│
├── frontend/              # React application (TypeScript)
│   └── src/app/
│       ├── components/    # UI components
│       │   ├── AppLayout.tsx          # Main layout
│       │   ├── StorageBrowser.tsx     # File browser
│       │   ├── Buckets.tsx            # Bucket management
│       │   ├── BucketNotificationsModal.tsx # Notification config
│       │   ├── Settings.tsx           # Configuration UI
│       │   └── AuthContext.tsx        # Auth state management
│       ├── hooks/         # Custom React hooks
│       ├── utils/         # API client, EventEmitter
│       ├── services/      # Storage service layer
│       └── routes.tsx     # Route definitions
│
├── docker/                # Container configuration
│   ├── Dockerfile         # Multi-stage build
│   ├── ceph.conf          # RGW configuration
│   ├── entrypoint.sh      # Startup script
│   └── supervisord.conf   # Process management
│
└── kubernetes/            # K8s deployment manifests
    ├── s4-deployment.yaml
    ├── s4-service.yaml
    ├── s4-pvc.yaml
    ├── s4-secret.yaml
    ├── s4-route.yaml          # OpenShift Route for Web UI (optional)
    ├── s4-route-s3.yaml       # OpenShift Route for S3 API (optional)
    └── s4-ingress-s3.yaml     # Kubernetes Ingress for S3 API (optional)
```

## Technology Stack

### Backend

- **Runtime**: Node.js 20+
- **Framework**: Fastify 5
- **Language**: TypeScript
- **S3 Client**: AWS SDK v3
- **Notifications**: Filesystem watching with webhook dispatch
- **Authentication**: JWT (jsonwebtoken)
- **Validation**: Fastify JSON Schema
- **Logging**: Pino (Fastify's logger)

### Frontend

- **Framework**: React 18
- **UI Library**: PatternFly 6
- **Language**: TypeScript
- **Routing**: React Router 7
- **HTTP Client**: Axios
- **Build Tool**: Webpack 5
- **State Management**: React Context + useState

### Storage Engine

- **S3 Engine**: Ceph RGW (Reef release)
- **Backend**: DBStore with SQLite
- **Base Image**: `quay.io/ceph/daemon`

### Container

- **Process Manager**: Supervisord
- **Base Image**: `quay.io/ceph/daemon` (Fedora-based)
- **Build**: Multi-stage Docker build

## Key Design Decisions

### 1. Streaming Architecture

**Decision**: All file operations use streaming, no intermediate storage.

**Rationale**:

- Memory-efficient (handles files larger than available RAM)
- Faster transfer times
- Scalable for large files (HuggingFace models)

**Implementation**:

- `@aws-sdk/lib-storage` for uploads
- Node.js streams for transfers
- Concurrent transfer limiting with `p-limit`

### 2. Single Container Deployment

**Decision**: Package RGW + Node.js in one container.

**Rationale**:

- Simpler deployment (single pod/container)
- No network overhead between components
- Easier for POCs and demos

**Trade-offs**:

- Less flexible scaling
- Coupled lifecycle
- Not cloud-native best practice (but acceptable for use case)

### 3. SQLite for S3 Metadata

**Decision**: Use Ceph RGW with DBStore (SQLite) instead of full Ceph cluster.

**Rationale**:

- No external dependencies
- Lightweight for POCs/demos
- Simple to deploy and maintain

**Limitations**:

- Not suitable for millions of objects
- Single-node only
- Lower performance than distributed Ceph

### 4. Optional Authentication

**Decision**: Authentication disabled by default, enabled via environment variables.

**Rationale**:

- Quick start for demos
- Flexible for different use cases
- Simple JWT-based implementation

**Security Note**: Always enable authentication in production.

### 5. Base64 Path Encoding

**Decision**: Use Base64 encoding for object keys and file paths in URLs.

**Rationale**:

- Handles slashes, spaces, special characters
- Prevents URL encoding issues
- Safer than percent-encoding for complex paths

**Trade-off**: URLs less human-readable but more reliable.

## Scalability Considerations

### Single Instance Limitations

S4 is designed for single-instance deployment:

- **In-memory rate limiting** - Resets on restart
- **No distributed state** - Cannot share state across replicas
- **SQLite backend** - Single-writer limitation
- **Ephemeral configuration** - Runtime settings not persisted

### Scaling Recommendations

For production deployments requiring high availability:

1. **Use external S3** - Connect to AWS S3, MinIO cluster, or Ceph cluster
2. **Add database** - For persistent configuration and audit logs
3. **Implement session store** - For multi-replica JWT validation

See [Deployment → Production Readiness](../deployment/production-readiness.md) for details.

## Security Architecture

### Authentication

- **Mode**: Optional JWT-based authentication
- **Storage**: JWTs in browser sessionStorage (cleared on tab close)
- **Expiration**: 8 hours (configurable)
- **SSE Auth**: One-time tickets for EventSource connections

### Authorization

- **Model**: Single admin user (no RBAC)
- **Future**: OAuth2/OIDC integration planned

### Network Security

- **CORS**: Configurable origins (default: localhost)
- **Rate Limiting**: Login (5/min), SSE tickets (20/min), contains search (5/min)
- **Input Validation**: S3 bucket/object name validation, path traversal prevention

### Data Security

- **Credentials**: Sanitized before logging
- **Headers**: Injection prevention via sanitization
- **File Uploads**: Streaming validation, size limits (20GB default)

See [Security Architecture](../security/README.md) for details.

## Performance Characteristics

### Memory Usage

- **Base**: ~200MB (RGW + Node.js)
- **Uploads**: ~50MB per concurrent upload (streaming buffer)
- **Transfers**: ~100MB per concurrent transfer
- **HF Import (7B model)**: ~256MB peak memory usage

### Throughput

- **Uploads**: Limited by network and disk I/O
- **Downloads**: Limited by network and disk I/O
- **Transfers**: 2 concurrent transfers (default, configurable)

### Storage

- **S3 Data**: Grows with objects stored
- **SQLite DB**: ~10KB per object (metadata)
- **Local Files**: Grows with files stored

## Further Reading

- **[Backend Architecture](backend.md)** - Fastify API implementation details
- **[Frontend Architecture](frontend.md)** - React application structure
- **[Container Architecture](container.md)** - Supervisord and process management
- **[API Reference](../api/README.md)** - Complete API documentation
- **[Deployment](../deployment/README.md)** - Deployment guides
