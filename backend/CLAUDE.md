# CLAUDE.md - S4 Backend Context

> **Note for AI Assistants**: This file contains AI-specific development context for the S4 Fastify backend. For user-facing architecture documentation, see [docs/architecture/backend.md](../docs/architecture/backend.md) and [docs/development/backend.md](../docs/development/backend.md). For project overview, see root [CLAUDE.md](../CLAUDE.md). For frontend context, see [frontend/CLAUDE.md](../frontend/CLAUDE.md).

## Backend Overview

**s4-backend** - Fastify-based API server with TypeScript, AWS S3 integration, and streaming file transfers. Connects to the bundled Ceph RGW S3 engine by default (localhost:7480).

**Technology Stack**: Fastify 5, Node.js 20+, AWS SDK v3, TypeScript

### Port Architecture

**Development** (npm run dev):

- Backend API: Port 8888 (set by `start:dev` script, nodemon hot reload)
- Frontend UI: Port 9000 (webpack dev server)
- Two separate processes for hot-reload development

**Production** (container):

- Node.js Fastify listens directly on port 5000 (set by supervisord `PORT=5000`)
- No proxy — supervisord starts Node.js directly, not behind a reverse proxy
- Frontend built as static files served by Fastify from `frontend/dist/`
- S3 API always on port 7480 (Ceph RGW, both dev and production)

**Code default** (no env var): Port 8080 (from `constants.ts`)

**Why this matters**: When developing, connect to 8888 for backend, 9000 for frontend. When running the container, always use port 5000.

**For detailed architecture**, see [docs/architecture/backend.md](../docs/architecture/backend.md).

## Critical Architecture Principles

### 1. Fastify Plugin Pattern

⚠️ **REQUIRED**: All routes and plugins MUST be Fastify plugins (async functions accepting FastifyInstance).

**Pattern**: Each route file exports an async function that registers routes:

```typescript
export default async (fastify: FastifyInstance): Promise<void> => {
  fastify.get('/endpoint', async (req, reply) => {
    /* handler */
  });
};
```

**Autoload**: Routes and plugins are automatically loaded from their respective directories (`src/routes/`, `src/plugins/`).

### 2. Streaming Architecture

⚠️ **CRITICAL**: All file operations MUST use streaming - no intermediate storage.

- Direct passthrough from source to destination
- Memory-efficient (~256MB max for 7B model imports)
- Concurrent transfer limits via `p-limit` (default: 2)
- Supports files larger than available RAM

### 3. Error Handling Pattern

⚠️ **REQUIRED**: Use centralized error handlers for consistency.

**For S3 Operations**:

```typescript
import { handleS3Error } from '../../../utils/errorHandler';

try {
  const result = await s3Client.send(command);
} catch (error) {
  await handleS3Error(error, reply, req.log);
}
```

**For Generic Operations**:

```typescript
import { handleError } from '../../../utils/errorHandler';

try {
  const result = await operation();
} catch (error) {
  await handleError(error, reply, 500, req.log);
}
```

**Error handlers automatically**:

- Extract HTTP status codes from S3ServiceException
- Sanitize errors before logging (prevent credential leakage)
- Return consistent error response format
- Log errors with appropriate severity

**Location**: `backend/src/utils/errorHandler.ts`

### 4. Type Safety Best Practices

⚠️ **REQUIRED**: Use TypedRequest for route handlers instead of casting.

**Pattern**:

```typescript
import { TypedRequest, ObjectParams, ObjectQueryParams } from '../../../types';

// Instead of: req.params as any
fastify.get('/:bucketName/:encodedKey', async (req: TypedRequest<ObjectParams, ObjectQueryParams>, reply) => {
  const { bucketName, encodedKey } = req.params; // Fully typed!
  const { prefix, query } = req.query; // Also typed!
});
```

**Available Types**:

- **Params**: `BucketParams`, `ObjectParams`, `TransferJobParams`, `LocationParams`, `NotificationParams`
- **Query**: `ObjectQueryParams`, `LocalQueryParams`
- **Body**: `CreateBucketBody`, `S3ConfigBody`, `TransferRequestBody`, `NotificationConfigBody`, `TestEndpointBody`, etc.

**Justified `as any` Usage**:

- Only 9 instances remain in production code
- All have justification comments explaining why
- Located in `errorLogging.ts` (5), `disclaimer/index.ts` (1), `settings/index.ts` (2), `transfer/index.ts` (1)

**Location**: `backend/src/types.ts` (128 lines)

### 5. Additional Features

- **Local filesystem storage** - `/api/local/*` routes provide file operations on configured local paths (`LOCAL_STORAGE_PATHS`)
- **File type validation** - Configurable allowed/blocked extensions (`utils/fileValidation.ts`)
- **Audit logging** - Structured audit events for auth, storage, transfer, and notification operations (`utils/auditLog.ts`)
- **Bucket notifications** - Webhook-based event notifications via filesystem watching (`routes/api/notifications/`, `utils/notificationStore.ts`, `utils/bucketWatcher.ts`, `utils/webhookDispatcher.ts`)
- **Transfer queue** - Managed concurrent cross-storage transfers with progress tracking (`utils/transferQueue.ts`)
- **Path prefix routing** - `NB_PREFIX` support for gateway/ingress deployments

### 6. Configuration Management

- Runtime S3 configuration via `getS3Config()` and `updateS3Config()`
- Environment variables loaded from `.env` or ODH/RHOAI Data Connection
- Proxy support via HTTP_PROXY and HTTPS_PROXY
- Configuration updates require S3 client reinitialization

### 7. Authentication Architecture

S4 supports optional JWT-based authentication (see root [CLAUDE.md](../CLAUDE.md) for auth modes overview). API responses use `authMode: "none"` or `"simple"`.

**Global Auth Hook** (`src/app.ts`):

- Runs on `onRequest` lifecycle for all `/api` routes
- **Skips OPTIONS requests** - Lets CORS plugin handle preflight requests
- **Skips public routes** - `/api/auth/info`, `/api/auth/login`, `GET /api` (health check)
- Calls `authenticateUser()` from `src/plugins/auth.ts` for protected routes

**JWT Flow**:

- Credentials validated with timing-safe comparison
- JWT signed with user payload (id, username, roles)
- Token verified on protected routes via global auth hook
- Authentication priority in `src/plugins/auth.ts`: signed cookie → Authorization header → one-time ticket (SSE)

**CORS Configuration** (`src/config/cors.ts`):

- Uses `origin: true` (reflects request origin) with `credentials: true`
- Allows `Authorization` and `Cookie` headers

**Rate Limiting**:

- Login endpoint: 5 attempts per minute per IP address
- SSE ticket endpoint: 20 requests per minute per IP address
- Uses in-memory Map, cleaned up every 60 seconds

**SSE Ticket System** (`src/utils/sseTickets.ts`):

One-time tickets for SSE connections (EventSource can't set custom headers):

- `POST /api/auth/sse-ticket` with `{ resource, resourceType }`
- 256-bit random tokens (Base64url-encoded), 60-second TTL (`SSE_TICKET_TTL_SECONDS`)
- Single-use, resource-scoped (tied to specific jobId or encodedKey)
- SSE endpoints: `/api/transfer/progress/:jobId?ticket=...`, `/api/objects/upload-progress/:encodedKey?ticket=...`

### 8. Utility Functions & Best Practices

S4 provides centralized utilities to ensure consistent patterns across the codebase.

#### Error Handling

**Pattern**: Use centralized error handlers instead of duplicate try-catch blocks.

```typescript
import { handleS3Error, handleError } from '../../../utils/errorHandler';

// For S3 operations
try {
  const result = await s3Client.send(command);
} catch (error) {
  await handleS3Error(error, reply, req.log);
}

// For non-S3 operations
try {
  const result = await someOperation();
} catch (error) {
  await handleError(error, reply, 500, req.log);
}
```

**Functions**:

- `handleS3Error(error, reply, logger?)` - Extracts HTTP status from S3ServiceException
- `handleError(error, reply, statusCode?, logger?)` - Generic error handler

**Location**: `backend/src/utils/errorHandler.ts`

#### HTTP Status Codes

**Pattern**: Use named constants instead of magic numbers.

```typescript
import { HttpStatus } from '../../../utils/httpStatus';

// Instead of: reply.code(200)
reply.code(HttpStatus.OK).send({ message: 'Success' });

// Instead of: reply.code(404)
reply.code(HttpStatus.NOT_FOUND).send({ error: 'Not found' });
```

**Available Constants**:

- 2xx: `OK` (200), `CREATED` (201), `MULTI_STATUS` (207)
- 4xx: `BAD_REQUEST` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `PAYLOAD_TOO_LARGE` (413), `TOO_MANY_REQUESTS` (429)
- 5xx: `INTERNAL_SERVER_ERROR` (500), `INSUFFICIENT_STORAGE` (507)

**Location**: `backend/src/utils/httpStatus.ts`

#### Logging Standards

**Pattern**: Use request logger in routes, utility logger outside routes.

```typescript
// In route handlers - use req.log
fastify.get('/endpoint', async (req, reply) => {
  req.log.info('Processing request');
  req.log.error(sanitizeErrorForLogging(error));
});

// In utilities without request context
import { createLogger } from '../utils/logger';
const logger = createLogger(undefined, '[My Utility]');
logger.info('Operation started');
logger.error('Operation failed');
```

**Guidelines**:

- **Routes**: Always use `req.log.info()`, `req.log.error()`, `req.log.warn()`
- **Utilities**: Use `createLogger()` from `backend/src/utils/logger.ts`
- **Startup/Shutdown**: Direct `console.log` acceptable

**Location**: `backend/src/utils/logger.ts`

#### Input Validation

**Pattern**: Apply Fastify schemas to all POST/PUT endpoints.

```typescript
import { createBucketSchema } from '../../../schemas';

fastify.post('/', { schema: createBucketSchema }, async (req, reply) => {
  // Body is automatically validated
  const { bucketName } = req.body; // Type-safe!
});
```

**Available Schemas**:

- `createBucketSchema` - Bucket creation
- `updateS3ConfigSchema` - S3 configuration
- `updateProxyConfigSchema` - Proxy settings
- `updateHFConfigSchema` - HuggingFace token
- `transferRequestSchema` - Transfer job creation
- `putNotificationsSchema` - Notification configuration
- `testEndpointSchema` - Notification endpoint testing

**Location**: `backend/src/schemas/index.ts`

#### Security Utilities

**Pattern**: Sanitize user input before using in headers or logs.

```typescript
import { sanitizeFileName } from '../../../utils/sanitization';
import { sanitizeErrorForLogging } from '../../../utils/errorLogging';

// Prevent header injection
reply.header('Content-Disposition', `attachment; filename="${sanitizeFileName(fileName)}"`);

// Prevent credential leakage in logs
req.log.error(sanitizeErrorForLogging(error));
```

**Functions**:

- `sanitizeFileName(fileName)` - Removes CRLF, quotes, backslashes; prevents header injection
- `sanitizeErrorForLogging(error)` - Masks credentials in error messages

**Locations**:

- `backend/src/utils/sanitization.ts`
- `backend/src/utils/errorLogging.ts`

#### Formatting Utilities

**Pattern**: Use centralized formatters for consistency.

```typescript
import { formatBytes } from '../../../utils/formatting';

const size = formatBytes(1073741824); // "1.00 GB"
const delta = formatBytes(-512000); // "-500.00 KB"
```

**Location**: `backend/src/utils/formatting.ts`

#### Rate Limiting

**Pattern**: Use centralized rate limiting utility.

```typescript
import { checkRateLimit, getRateLimitResetTime } from '../../../utils/rateLimit';

const rateLimitKey = `operation:${req.ip}`;
if (checkRateLimit(rateLimitKey, 10, 60000)) {
  const retryAfter = getRateLimitResetTime(rateLimitKey);
  return reply.code(HttpStatus.TOO_MANY_REQUESTS).send({
    error: 'TooManyRequests',
    message: 'Rate limit exceeded',
    retryAfter,
  });
}
```

**Location**: `backend/src/utils/rateLimit.ts`

## Essential Development Commands

```bash
# Development server with hot reload
npm run start:dev

# Building
npm run build          # Clean + TypeScript production build

# Testing
npm test               # Lint + type-check + jest
npm run test:lint      # ESLint check
npm run test:jest      # Jest tests with coverage

# Code quality
npm run format         # Prettier format

# Production
npm start              # Run production build from dist/
```

**For complete workflow**, see [docs/development/backend.md](../docs/development/backend.md).

## Route Organization

API routes are organized under `/api/*` and auto-loaded from `src/routes/api/`:

- `/api/auth` - Authentication endpoints (info, login, logout, me, sse-ticket)
- `/api/buckets` - S3 bucket operations
- `/api/objects` - S3 object operations (upload, download, list, delete, tags, metadata)
- `/api/settings` - Configuration management (S3, HuggingFace, proxy, concurrency, pagination)
- `/api/disclaimer` - Application metadata
- `/api/notifications` - Bucket notification management (webhooks via filesystem watching)
- `/api/transfer` - Cross-storage transfer operations and SSE progress
- `/api/local/*` - Local filesystem storage operations (list, upload, download, mkdir, delete)

Additional routes registered in `src/routes/root.ts`:

- `GET /api` - Health check endpoint (for Kubernetes probes)
- `GET /api/kernels`, `GET /api/terminals` - Platform compatibility endpoints (idle culler)

Static files served from `frontend/dist/` via `@fastify/static` in production.

**For detailed route documentation**, see [docs/architecture/backend.md](../docs/architecture/backend.md).

### URL Parameter Handling

**Bucket Names (NOT encoded)**:

- Validated to URL-safe `[a-z0-9-]` via `validateBucketName()` in `src/utils/validation.ts`
- Fastify automatically decodes URL parameters, but no decoding is needed
- This validation enables human-readable frontend URLs like `/browse/my-bucket`

**Object Keys and Paths (Base64-encoded)**:

- Decoded using `validateAndDecodePrefix()` in `src/utils/validation.ts`
- Handles slashes, spaces, and special characters safely
- Prevents path traversal attacks (`..\..` sequences rejected after decoding)

**Rationale**: By strictly validating bucket names to URL-safe characters, we avoid the need for URL encoding while maintaining security. This architectural decision provides human-readable URLs and is consistent with the frontend's locationId abstraction pattern.

## Key Implementation Guidelines

### For AI Assistants

**DO:**

- ✅ Use Fastify plugin pattern for all routes
- ✅ Use streaming for all file operations (Upload from `@aws-sdk/lib-storage`)
- ✅ Use centralized error handlers (`handleS3Error`, `handleError`)
- ✅ Use `getS3Config()` to access current S3 client
- ✅ Use `req.log` for all route handlers (req.log.info(), req.log.error(), req.log.warn())
- ✅ Use `createLogger()` in utilities without request context
- ✅ Use `logAccess(req)` specifically for HTTP access logs
- ✅ Use HTTP status constants from `httpStatus.ts` instead of magic numbers
- ✅ Apply validation schemas from `schemas/index.ts` to all POST/PUT endpoints
- ✅ Sanitize filenames with `sanitizeFileName()` before using in headers
- ✅ Use `TypedRequest<TParams, TQuery, TBody>` instead of type casting
- ✅ Control concurrency with `p-limit(getMaxConcurrentTransfers())`
- ✅ Support proxy configuration for enterprise environments
- ✅ Use TypeScript with proper types (FastifyRequest, FastifyReply, FastifyInstance)
- ✅ **Run `npm run format` after creating or modifying files** - Ensures consistent Prettier formatting across the codebase

**DON'T:**

- ❌ Load entire files into memory - always stream
- ❌ Skip error handling for S3 operations
- ❌ Ignore runtime configuration updates
- ❌ Create routes outside the plugin pattern
- ❌ Bypass autoload conventions

### Testing Requirements

- Use `aws-sdk-client-mock` for mocking S3 operations
- Use `fastify.inject()` for testing routes without starting server
- Mock configuration module with Jest
- Test both success and error cases (especially S3ServiceException)

**For testing patterns**, see [docs/development/testing.md](../docs/development/testing.md).

## Project Structure

```
backend/
├── src/
│   ├── routes/api/       # Auto-loaded API routes
│   ├── plugins/          # Auto-loaded Fastify plugins (auth)
│   ├── config/           # CORS configuration
│   ├── schemas/          # Request validation schemas
│   ├── types.ts          # TypeScript type definitions
│   ├── utils/            # Config, logging, constants, validation, audit, notifications
│   ├── __tests__/        # Jest tests
│   ├── app.ts            # Fastify app initialization, global auth hook
│   └── server.ts         # Server entry point
├── dist/                 # Compiled JavaScript
├── tsconfig.json         # TypeScript config (dev + test)
└── tsconfig.prod.json    # Production config (excludes tests)
```

## Environment Variables

Key configuration for backend development (see [Configuration Reference](../docs/deployment/configuration.md) for complete list):

**S3 Configuration**:

- `AWS_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`

**Authentication**:

- `UI_USERNAME`, `UI_PASSWORD` - Enable auth when both set
- `JWT_SECRET` - JWT signing secret (auto-generated if not provided)
- `JWT_EXPIRATION_HOURS` (default: 8) - Token expiration time
- `COOKIE_REQUIRE_HTTPS` (default: true) - Require HTTPS for cookies

**Performance**:

- `MAX_CONCURRENT_TRANSFERS` (default: 2) - Concurrent transfer limit
- `MAX_FILES_PER_PAGE` (default: 100) - Pagination limit
- `MAX_FILE_SIZE_GB` (default: 20) - Maximum file size limit in GB

**File Validation**:

- `ALLOWED_FILE_EXTENSIONS` - Override default allowed extensions (blank disables all)
- `ALLOWED_FILE_EXTENSIONS_APPEND` - Append to default allowed extensions
- `BLOCKED_FILE_EXTENSIONS` - Override default blocked extensions
- `BLOCKED_FILE_EXTENSIONS_APPEND` - Append to default blocked extensions

**Local Storage**:

- `LOCAL_STORAGE_PATHS` - Comma-separated paths for local filesystem access

**Logging & Audit**:

- `LOG_LEVEL` / `FASTIFY_LOG_LEVEL` (default: info) - Logging level
- `LOG_HEALTH_CHECKS` (default: false) - Log health check requests
- `AUDIT_LOG_ENABLED` (default: true) - Enable audit logging

**SSE**:

- `SSE_TICKET_TTL_SECONDS` (default: 60) - One-time SSE ticket lifetime

**Notifications**:

- `NOTIFICATION_STORE_PATH` (default: `/var/lib/ceph/radosgw/db/notifications.json`) - Path to JSON file storing notification configs
- `BUCKET_DATA_PATH` (default: `/var/lib/ceph/radosgw/buckets`) - Path to Ceph POSIX backend bucket data directory

**Routing**:

- `NB_PREFIX` - URL path prefix for gateway/ingress routing

**Proxy**: `HTTP_PROXY`, `HTTPS_PROXY` - Corporate proxy support

**Development**: `PORT` (default: 8080 from code, 8888 in dev script, 5000 in container), `NODE_ENV` (default: production)

## Known Limitations

- Simple authentication only (single admin user, no multi-user support or role-based access control)
- Rate limiting on login (5/min) and SSE ticket (20/min) endpoints only
- Ephemeral configuration (runtime updates not persisted)
- No database (all state from S3/environment)
- Limited error recovery/retry logic
- JWT secrets auto-generated on startup if not provided (not suitable for multi-replica deployments without shared secret)

## Production Deployment

For production deployment considerations, see [docs/deployment/production-readiness.md](../docs/deployment/production-readiness.md).

**Critical items before production**:

- ✅ Security: Header injection protection, input validation, credential masking
- ✅ Type Safety: Comprehensive types, centralized error handling
- ✅ Code Quality: Deduplication, consistent patterns
- ✅ Rate Limiting: In-memory implementation (suitable for single-replica deployment)
- 🔴 Audit Logging: Implement persistent, tamper-proof audit logs
- 🟠 Monitoring: Add APM, distributed tracing, error tracking

See [docs/deployment/production-readiness.md](../docs/deployment/production-readiness.md) for complete checklist and migration path.

## Related Documentation

### For AI Assistants

- Root [CLAUDE.md](../CLAUDE.md) - Project overview and AI development context
- Frontend [CLAUDE.md](../frontend/CLAUDE.md) - Frontend React app AI context

### For Users and Developers

- [Backend Architecture](../docs/architecture/backend.md) - Complete implementation details, code patterns, and examples
- [Backend Development](../docs/development/backend.md) - Build process, testing, and development setup
- [Configuration](../docs/deployment/configuration.md) - Environment variables and runtime configuration
- [Production Readiness](../docs/deployment/production-readiness.md) - Production deployment checklist
