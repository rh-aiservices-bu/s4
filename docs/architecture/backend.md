# Backend Architecture

The S4 backend is a TypeScript-based Fastify application that provides a RESTful API for storage operations, serves the React frontend, and manages streaming file transfers.

## Technology Stack

- **Framework**: Fastify 5 (high-performance Node.js web framework)
- **Runtime**: Node.js 20+
- **Language**: TypeScript
- **S3 Client**: AWS SDK v3
- **Notifications**: Filesystem watching with webhook dispatch
- **Authentication**: JWT (jsonwebtoken)
- **Validation**: Fastify JSON Schema
- **Logging**: Pino (Fastify's built-in logger)
- **Testing**: Jest with aws-sdk-client-mock

## Architecture Principles

### 1. Fastify Plugin Pattern

All routes and plugins follow the Fastify plugin pattern for modular composition.

**Pattern**:

```typescript
export default async (fastify: FastifyInstance): Promise<void> => {
  fastify.get('/endpoint', async (req, reply) => {
    // handler logic
  });
};
```

**Benefits**:

- Automatic route loading via `@fastify/autoload`
- Encapsulation and reusability
- Plugin-specific hooks and decorators
- Clear dependency injection

### 2. Streaming Architecture

**Critical Design Decision**: All file operations use streaming with no intermediate storage.

**Implementation**:

- **Uploads**: `@aws-sdk/lib-storage` with multipart uploads
- **Downloads**: Direct stream from S3 to HTTP response
- **Transfers**: Pipe from source stream to destination stream
- **Concurrency Control**: `p-limit` to prevent overwhelming endpoints

**Memory Characteristics**:

- Base memory: ~50MB per concurrent operation
- HuggingFace 7B model import: ~256MB peak
- No file size limits (beyond disk space)

### 3. Type Safety

Comprehensive TypeScript types with minimal `as any` usage.

**Type System**:

```typescript
// Centralized types in src/types.ts
interface TypedRequest<TParams, TQuery, TBody> extends FastifyRequest {
  params: TParams;
  query: TQuery;
  body: TBody;
  user?: AuthUser;
}

// Route parameter types
type BucketParams = { bucketName: string };
type ObjectParams = { bucketName: string; encodedKey: string };

// Query parameter types
type ObjectQueryParams = {
  prefix?: string;
  continuationToken?: string;
  maxKeys?: string;
  q?: string;
  mode?: 'startsWith' | 'contains';
};
```

**Justified `as any` Usage**:

- Only 7 instances in production code
- All have `// JUSTIFICATION:` comments
- Located in error logging, disclaimer, and transfer routes

### 4. Centralized Error Handling

Consistent error handling via utility functions.

**Pattern**:

```typescript
import { handleS3Error, handleError } from '../../../utils/errorHandler';

try {
  const result = await s3Client.send(command);
} catch (error) {
  await handleS3Error(error, reply, req.log);
}
```

**Features**:

- Extracts HTTP status codes from S3ServiceException
- Sanitizes errors before logging (prevents credential leakage)
- Returns consistent error response format
- Logs with appropriate severity levels

### 5. Security-First Design

**Input Validation**:

- Fastify JSON schemas for all POST/PUT endpoints
- Bucket name validation (AWS-compliant)
- Object key validation and decoding
- Path traversal prevention

**Credential Protection**:

- `sanitizeErrorForLogging()` masks credentials in logs
- `sanitizeFileName()` prevents header injection
- Rate limiting on authentication and expensive operations

**Authentication**:

- Optional JWT-based authentication
- One-time tickets for SSE connections
- Timing-safe credential comparison

## Project Structure

```
backend/
├── src/
│   ├── routes/api/           # Auto-loaded API routes
│   │   ├── auth/             # Authentication (info, login, logout, me, sse-ticket)
│   │   ├── buckets/          # Bucket operations (list, create, delete)
│   │   ├── objects/          # Object operations (upload, download, list, delete, view)
│   │   ├── notifications/    # Bucket notification management (webhooks)
│   │   ├── transfer/         # Transfer operations (create, progress, cancel, cleanup)
│   │   ├── settings/         # Configuration (S3, HuggingFace, proxy, limits)
│   │   ├── local/            # Local storage operations
│   │   └── disclaimer/       # Application metadata
│   │
│   ├── plugins/              # Fastify plugins
│   │   └── auth.ts           # Authentication middleware
│   │
│   ├── utils/                # Utilities
│   │   ├── config.ts         # Configuration management
│   │   ├── errorHandler.ts   # Centralized error handling
│   │   ├── validation.ts     # Input validation
│   │   ├── sanitization.ts   # Filename sanitization
│   │   ├── errorLogging.ts   # Error sanitization
│   │   ├── rateLimit.ts      # Rate limiting
│   │   ├── httpStatus.ts     # HTTP status constants
│   │   ├── transferQueue.ts  # Transfer job management
│   │   ├── sseTickets.ts     # SSE ticket generation
│   │   ├── notificationStore.ts # Notification config persistence
│   │   ├── bucketWatcher.ts    # Filesystem watcher for bucket events
│   │   ├── webhookDispatcher.ts # Webhook dispatch for notifications
│   │   └── ...               # Other utilities
│   │
│   ├── types.ts              # TypeScript type definitions
│   ├── schemas/              # Fastify JSON schemas
│   ├── app.ts                # Fastify app initialization
│   └── server.ts             # Server entry point
│
├── dist/                     # Compiled JavaScript
├── tsconfig.json             # TypeScript config (dev + test)
└── tsconfig.prod.json        # Production config (excludes tests)
```

## Route Organization

Routes are organized under `/api/*` and auto-loaded from `src/routes/api/`:

### Authentication Routes (`/api/auth`)

- `GET /info` - Check if authentication is enabled (public)
- `POST /login` - Authenticate and get JWT token (public, rate-limited)
- `POST /logout` - Clear authentication cookie
- `GET /me` - Get current user info
- `POST /sse-ticket` - Generate one-time SSE ticket (rate-limited)

### Bucket Routes (`/api/buckets`)

- `GET /` - List all accessible buckets
- `POST /` - Create a new bucket
- `DELETE /:bucketName` - Delete a bucket

### Object Routes (`/api/objects`)

- `GET /:bucketName` - List objects in bucket with pagination
- `GET /:bucketName/:encodedKey` - List objects with prefix
- `POST /upload/:bucketName/:encodedKey` - Upload object (streaming)
- `GET /download/:bucketName/:encodedKey` - Download object (streaming)
- `DELETE /:bucketName/:encodedKey` - Delete object or folder
- `GET /view/:bucketName/:encodedKey` - View object metadata and content preview
- `POST /huggingface-import` - Import model from HuggingFace

### Notification Routes (`/api/notifications`)

- `GET /:bucketName` - Get notification configurations for a bucket
- `PUT /:bucketName` - Set notification configurations (starts filesystem watcher)
- `DELETE /:bucketName/:notificationId` - Remove a single notification (stops watcher if none remain)
- `POST /test-endpoint` - Test an HTTP endpoint by sending a sample S3 event

### Transfer Routes (`/api/transfer`)

- `POST /` - Create transfer job
- `GET /progress/:jobId` - SSE endpoint for transfer progress (requires ticket)
- `POST /cancel/:jobId` - Cancel transfer job
- `POST /cleanup/:jobId` - Clean up completed transfer
- `POST /check-conflicts` - Check for destination conflicts

### Settings Routes (`/api/settings`)

- `GET /s3` - Get S3 configuration
- `PUT /s3` - Update S3 configuration
- `POST /test-s3` - Test S3 connection
- `GET /huggingface` - Get HuggingFace token
- `PUT /huggingface` - Update HuggingFace token
- `POST /test-huggingface` - Test HuggingFace connection
- `GET /proxy` - Get proxy configuration
- `PUT /proxy` - Update proxy configuration
- `POST /test-proxy` - Test proxy connection
- `GET /max-concurrent-transfers` - Get concurrency limit
- `PUT /max-concurrent-transfers` - Update concurrency limit
- `GET /max-files-per-page` - Get pagination limit
- `PUT /max-files-per-page` - Update pagination limit

### Local Storage Routes (`/api/local`)

- `GET /locations` - List available storage locations
- `GET /files/:locationId/*` - List files at path
- `POST /upload/:locationId/*` - Upload file (streaming)
- `GET /download/:locationId/*` - Download file (streaming)
- `DELETE /:locationId/*` - Delete file or directory
- `GET /view/:locationId/*` - View file metadata and content preview
- `POST /create-directory/:locationId/*` - Create directory

## URL Parameter Handling

**Bucket Names (NOT encoded)**:

- Validated to URL-safe `[a-z0-9-]` via `validateBucketName()`
- Enables human-readable URLs like `/api/buckets/my-bucket`
- Fastify automatically decodes URL parameters

**Object Keys and Paths (Base64-encoded)**:

- Decoded using `validateAndDecodePrefix()` or `base64Decode()`
- Handles slashes, spaces, and special characters safely
- Prevents path traversal attacks (`..\..` sequences rejected)

**Rationale**: Strict bucket name validation eliminates need for URL encoding while maintaining security. This provides human-readable URLs and is consistent with frontend's locationId pattern.

## Configuration Management

### Environment Variables

**S3 Configuration**:

- `AWS_S3_ENDPOINT` - S3 endpoint URL (default: `http://localhost:7480`)
- `AWS_ACCESS_KEY_ID` - S3 access key (default: `s4admin`)
- `AWS_SECRET_ACCESS_KEY` - S3 secret key (default: `s4secret`)
- `AWS_DEFAULT_REGION` - AWS region (default: `us-east-1`)

**Authentication**:

- `UI_USERNAME` - UI login username (enables auth when both set)
- `UI_PASSWORD` - UI login password (enables auth when both set)
- `JWT_SECRET` - JWT signing secret (auto-generated if not set)
- `JWT_EXPIRATION_HOURS` - JWT token expiration (default: `8`)
- `SSE_TICKET_TTL_SECONDS` - SSE ticket TTL (default: `60`)

**Performance**:

- `MAX_CONCURRENT_TRANSFERS` - Concurrent transfer limit (default: `2`)
- `MAX_FILE_SIZE_GB` - Maximum upload size in GB (default: `20`)

**Proxy**:

- `HTTP_PROXY` - HTTP proxy URL
- `HTTPS_PROXY` - HTTPS proxy URL

**CORS**:

- `ALLOWED_ORIGINS` - Comma-separated allowed origins (default: localhost)

**Local Storage**:

- `LOCAL_STORAGE_PATHS` - Comma-separated storage paths (default: disabled)

### Runtime Configuration

Configuration can be updated via `/api/settings` endpoints:

**Dynamic Updates**:

- S3 credentials and endpoint
- HuggingFace token
- Proxy settings
- Concurrency limits
- Pagination limits

**Persistence**: Runtime configuration updates are ephemeral (lost on restart). For production, use environment variables or persistent configuration store.

## Authentication & Authorization

### Authentication Modes

**Disabled Mode** (Development):

- Set when `UI_USERNAME` and `UI_PASSWORD` are not configured
- All API endpoints accessible without authentication

**Enabled Mode** (Production):

- Activated when both `UI_USERNAME` and `UI_PASSWORD` are set
- JWT token-based authentication required
- Token expiration: 8 hours (configurable via `JWT_EXPIRATION_HOURS`)

### JWT Token Flow

1. Client calls `POST /api/auth/login` with credentials
2. Backend validates using timing-safe comparison
3. Backend signs JWT token with user payload
4. Token stored in browser sessionStorage and HttpOnly cookie
5. Client includes token in `Authorization: Bearer <token>` header
6. Backend verifies token on protected routes via global auth hook

### SSE Authentication

**Problem**: EventSource API cannot set custom headers, requiring query parameter auth. JWT tokens in URLs are insecure (logged by proxies, servers, browsers).

**Solution**: One-time tickets for SSE connections.

**Flow**:

1. Client requests ticket: `POST /api/auth/sse-ticket` with resource info
2. Backend generates 256-bit random token with 60s TTL
3. Backend stores ticket with resource scope and user info
4. Client creates EventSource with ticket in query: `?ticket=...`
5. Backend validates ticket, consumes it (single-use), removes from cache
6. SSE connection streams progress events

**Security**:

- 60-second TTL (vs 8-hour JWT)
- Single-use (deleted after validation)
- Resource-scoped (tied to specific transfer/upload)
- Rate-limited (20 tickets per minute)

### Authorization

**Current Implementation**: Single admin user with full access.

**Future Enhancements**:

- Multi-user support
- Role-based access control (RBAC)
- Resource-level permissions
- OAuth2/OIDC integration

## Rate Limiting

**Implementation**: In-memory Map with periodic cleanup.

**Rate Limits**:

- Login: 5 attempts per minute per IP
- SSE tickets: 20 requests per minute per IP
- Contains search: 5 requests per minute per IP
- Local upload: 20 requests per minute per IP

**Limitations**:

- State lost on restart (acceptable for single-replica deployment)
- Not shared across replicas (S4 is designed for single-replica deployment)

## Streaming Implementation

### Upload Flow

```typescript
import { Upload } from '@aws-sdk/lib-storage';

const upload = new Upload({
  client: s3Client,
  params: {
    Bucket: bucketName,
    Key: objectKey,
    Body: readableStream,
  },
});

upload.on('httpUploadProgress', (progress) => {
  // Emit progress via SSE
  emitProgress(progress.loaded, progress.total);
});

await upload.done();
```

### Download Flow

```typescript
const command = new GetObjectCommand({
  Bucket: bucketName,
  Key: objectKey,
});

const response = await s3Client.send(command);
reply.type(response.ContentType || 'application/octet-stream');
reply.send(response.Body); // Stream to client
```

### Transfer Flow

```typescript
// S3 → Local
const getCommand = new GetObjectCommand({ Bucket, Key });
const { Body } = await s3Client.send(getCommand);
await pipeline(Body, createWriteStream(localPath));

// Local → S3
const readStream = createReadStream(localPath);
const upload = new Upload({
  client: s3Client,
  params: { Bucket, Key, Body: readStream },
});
await upload.done();
```

## Error Handling

### Centralized Error Handlers

**S3 Errors**:

```typescript
async function handleS3Error(error: any, reply: FastifyReply, logger?: FastifyBaseLogger): Promise<void> {
  if (error instanceof S3ServiceException) {
    const statusCode = error.$metadata?.httpStatusCode || 500;
    const sanitizedError = sanitizeErrorForLogging(error);
    logger?.error(sanitizedError, 'S3 operation failed');

    reply.code(statusCode).send({
      error: error.name,
      message: error.message,
    });
  } else {
    await handleError(error, reply, 500, logger);
  }
}
```

**Generic Errors**:

```typescript
async function handleError(
  error: any,
  reply: FastifyReply,
  statusCode: number = 500,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const sanitizedError = sanitizeErrorForLogging(error);
  logger?.error(sanitizedError, 'Operation failed');

  reply.code(statusCode).send({
    error: error.name || 'Error',
    message: error.message || 'An error occurred',
  });
}
```

### Error Sanitization

**Prevents credential leakage** in logs and responses:

```typescript
function sanitizeErrorForLogging(error: any): any {
  const errorStr = JSON.stringify(error);
  const sensitivePatterns = [
    /accessKeyId['":\s]+[^'"\s]+/gi,
    /secretAccessKey['":\s]+[^'"\s]+/gi,
    /password['":\s]+[^'"\s]+/gi,
    /token['":\s]+[^'"\s]+/gi,
  ];

  let sanitized = errorStr;
  sensitivePatterns.forEach((pattern) => {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  });

  return JSON.parse(sanitized);
}
```

## Testing

### Testing Stack

- **Framework**: Jest
- **S3 Mocking**: aws-sdk-client-mock
- **HTTP Testing**: fastify.inject() (no server required)
- **Coverage**: 387/414 tests passing (93%)

### Testing Patterns

**Route Testing**:

```typescript
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
});

test('GET /api/buckets returns bucket list', async () => {
  s3Mock.on(ListBucketsCommand).resolves({
    Buckets: [{ Name: 'test-bucket' }],
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/buckets',
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().buckets).toHaveLength(1);
});
```

**Error Testing**:

```typescript
test('handles S3 errors correctly', async () => {
  s3Mock.on(GetObjectCommand).rejects({
    name: 'NoSuchKey',
    message: 'The specified key does not exist',
    $metadata: { httpStatusCode: 404 },
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/objects/download/bucket/key',
  });

  expect(response.statusCode).toBe(404);
});
```

## Performance Considerations

### Memory Usage

- Base: ~200MB (Node.js + Fastify)
- Streaming buffer: ~50MB per concurrent operation
- No file size limits (disk-bound, not memory-bound)

### Concurrency Control

```typescript
import pLimit from 'p-limit';

const limit = pLimit(getMaxConcurrentTransfers());

// Queue transfers with concurrency limit
const results = await Promise.all(files.map((file) => limit(() => transferFile(file))));
```

### Caching

**Not Implemented**: All operations query S3 directly. This is intentional to ensure data consistency in a single-replica deployment.

## Known Limitations

1. **Single Admin User** - No multi-user support or RBAC
2. **Ephemeral Configuration** - Runtime updates not persisted
3. **In-Memory Rate Limiting** - Not suitable for multi-replica deployments
4. **No Audit Trail** - Console logging only (not compliant)
5. **Limited Error Recovery** - Basic retry logic for network operations
6. **No Database** - All state from S3/environment

## Production Considerations

See [Production Readiness](../deployment/production-readiness.md) for complete deployment checklist.

**Critical Items**:

- Implement persistent audit logging
- Add monitoring and observability (APM, tracing)
- Configure shared JWT secret if scaling beyond single replica
- Enable HTTPS at ingress/load balancer
- Review and tighten CORS configuration

## Further Reading

- **[API Reference](../api/README.md)** - Complete API documentation
- **[Frontend Architecture](frontend.md)** - React application structure
- **[Container Architecture](container.md)** - Supervisord and process management
- **[Development Guide](../development/backend.md)** - Backend development workflow
- **[Production Readiness](../deployment/production-readiness.md)** - Deployment checklist
