# Backend Development Guide

Guide for developing the S4 Fastify backend.

## Overview

The S4 backend is a Fastify 5 server with TypeScript, AWS S3 integration, and streaming file operations.

**Technology Stack**:

- Fastify 5.x
- Node.js 20+
- AWS SDK v3
- TypeScript 5.x

## Development Setup

```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Start development server with hot reload
npm run start:dev

# Run on custom port
PORT=3000 npm run start:dev
```

The backend dev server runs on port **8888** by default with nodemon auto-reload.

## Project Structure

```
backend/
├── src/
│   ├── routes/
│   │   └── api/           # API route handlers (auto-loaded)
│   │       ├── auth/      # Authentication endpoints
│   │       ├── buckets/   # S3 bucket operations
│   │       ├── objects/   # S3 object operations
│   │       ├── settings/  # Configuration management
│   │       ├── transfer/  # File transfer jobs
│   │       └── disclaimer/  # App metadata
│   ├── plugins/           # Fastify plugins (auto-loaded)
│   │   ├── auth.ts        # JWT authentication
│   │   ├── cors.ts        # CORS configuration
│   │   └── sensible.ts    # Sensible defaults
│   ├── utils/             # Utilities and helpers
│   │   ├── config.ts      # S3 client configuration
│   │   ├── errorHandler.ts  # Centralized error handling
│   │   ├── httpStatus.ts    # HTTP status constants
│   │   ├── validation.ts    # Input validation
│   │   ├── sanitization.ts  # Security sanitization
│   │   └── logger.ts        # Logging utilities
│   ├── schemas/           # JSON schemas for validation
│   ├── types.ts           # TypeScript type definitions
│   ├── app.ts             # Fastify app initialization
│   └── server.ts          # Server entry point
├── dist/                  # Compiled JavaScript
└── __tests__/             # Jest tests
```

## Key Patterns

### 1. Fastify Plugin Pattern

All routes and plugins MUST be Fastify plugins (async functions accepting FastifyInstance).

```typescript
import { FastifyInstance } from 'fastify';

export default async (fastify: FastifyInstance): Promise<void> => {
  // Register routes
  fastify.get('/endpoint', async (req, reply) => {
    return { message: 'Hello' };
  });

  fastify.post('/endpoint', async (req, reply) => {
    const { data } = req.body;
    return { success: true };
  });
};
```

Routes are automatically loaded from `src/routes/` and plugins from `src/plugins/`.

### 2. Streaming Architecture

All file operations MUST use streaming to avoid loading entire files into memory.

```typescript
import { Upload } from '@aws-sdk/lib-storage';
import { PassThrough } from 'stream';

// Upload with streaming
const upload = new Upload({
  client: s3Client,
  params: {
    Bucket: bucketName,
    Key: objectKey,
    Body: req.raw, // Stream from request
  },
});

await upload.done();

// Download with streaming
const command = new GetObjectCommand({ Bucket, Key });
const response = await s3Client.send(command);
return reply.send(response.Body); // Stream to response
```

### 3. Type-Safe Request Handling

Use `TypedRequest` instead of type casting for route handlers.

```typescript
import { TypedRequest, ObjectParams, ObjectQueryParams } from '../../../types';

fastify.get('/:bucketName/:encodedKey', async (req: TypedRequest<ObjectParams, ObjectQueryParams>, reply) => {
  const { bucketName, encodedKey } = req.params; // Fully typed
  const { prefix } = req.query; // Also typed
  // ...
});
```

Available types in `src/types.ts`:

- **Params**: `BucketParams`, `ObjectParams`, `TransferJobParams`, `LocationParams`
- **Query**: `ObjectQueryParams`, `LocalQueryParams`
- **Body**: `CreateBucketBody`, `S3ConfigBody`, `TransferRequestBody`

### 4. Error Handling

Use centralized error handlers for consistency.

```typescript
import { handleS3Error, handleError } from '../../../utils/errorHandler';

// For S3 operations
try {
  const result = await s3Client.send(command);
} catch (error) {
  await handleS3Error(error, reply, req.log);
}

// For generic operations
try {
  const result = await someOperation();
} catch (error) {
  await handleError(error, reply, 500, req.log);
}
```

Error handlers automatically:

- Extract HTTP status codes from S3ServiceException
- Sanitize errors (prevent credential leakage)
- Return consistent error response format
- Log errors with appropriate severity

### 5. HTTP Status Constants

Use named constants instead of magic numbers.

```typescript
import { HttpStatus } from '../../../utils/httpStatus';

reply.code(HttpStatus.OK).send({ message: 'Success' });
reply.code(HttpStatus.NOT_FOUND).send({ error: 'Not found' });
reply.code(HttpStatus.UNAUTHORIZED).send({ error: 'Unauthorized' });
```

### 6. Input Validation

Apply Fastify schemas to all POST/PUT endpoints.

```typescript
import { createBucketSchema } from '../../../schemas';

fastify.post('/', { schema: createBucketSchema }, async (req, reply) => {
  const { bucketName } = req.body; // Automatically validated
  // ...
});
```

### 7. Security Utilities

Sanitize user input before using in headers or logs.

```typescript
import { sanitizeFileName } from '../../../utils/sanitization';
import { sanitizeErrorForLogging } from '../../../utils/errorLogging';

// Prevent header injection
reply.header('Content-Disposition', `attachment; filename="${sanitizeFileName(fileName)}"`);

// Prevent credential leakage in logs
req.log.error(sanitizeErrorForLogging(error));
```

## Adding New Endpoints

### Step 1: Create Route File

Create a new file in `src/routes/api/`:

```typescript
// src/routes/api/myfeature/index.ts
import { FastifyInstance } from 'fastify';
import { TypedRequest } from '../../../types';
import { handleS3Error } from '../../../utils/errorHandler';
import { HttpStatus } from '../../../utils/httpStatus';

export default async (fastify: FastifyInstance): Promise<void> => {
  // GET /api/myfeature
  fastify.get('/', async (req, reply) => {
    try {
      // Implementation
      return { data: [] };
    } catch (error) {
      await handleS3Error(error, reply, req.log);
    }
  });

  // POST /api/myfeature
  fastify.post('/', async (req, reply) => {
    try {
      // Implementation
      return reply.code(HttpStatus.CREATED).send({ success: true });
    } catch (error) {
      await handleError(error, reply, HttpStatus.INTERNAL_SERVER_ERROR, req.log);
    }
  });
};
```

### Step 2: Add Type Definitions

Add types to `src/types.ts` if needed:

```typescript
export interface MyFeatureParams {
  id: string;
}

export interface MyFeatureBody {
  name: string;
  value: number;
}
```

### Step 3: Add Validation Schema

Add schema to `src/schemas/index.ts`:

```typescript
export const myFeatureSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
      value: { type: 'number', minimum: 0 },
    },
  },
};
```

### Step 4: Write Tests

Create test file in `src/__tests__/`:

```typescript
import { build } from '../app';

describe('MyFeature API', () => {
  let app: any;

  beforeAll(async () => {
    app = await build();
  });

  afterAll(async () => {
    await app.close();
  });

  test('GET /api/myfeature should return data', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/myfeature',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('data');
  });
});
```

## Authentication

S4 supports optional JWT-based authentication.

### Authentication Modes

- **`simple`** - Enabled when both `UI_USERNAME` and `UI_PASSWORD` are set
- **`none`** - Default when credentials not configured

### Protected Routes

All `/api` routes except public endpoints require authentication when enabled:

**Public routes**:

- `GET /api/auth/info` - Check auth status
- `POST /api/auth/login` - Login endpoint

**Protected routes**:

- All other `/api/*` endpoints require valid JWT token

### Global Auth Hook

The auth hook runs on `onRequest` lifecycle for all `/api` routes:

```typescript
// In src/app.ts
fastify.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api')) return;
  if (req.method === 'OPTIONS') return; // Skip CORS preflight
  if (isPublicRoute(req.url)) return;

  await authenticateUser(req, reply);
});
```

### Adding Protected Endpoints

No special configuration needed - all `/api` routes are protected by default.

To create a public endpoint:

1. Add to public routes list in `src/app.ts`
2. Document in API reference

## Configuration Management

Access S3 configuration at runtime:

```typescript
import { getS3Config, updateS3Config } from '../utils/config';

// Get current S3 client
const s3Client = getS3Config();

// Update configuration (requires reinitializing client)
await updateS3Config({
  endpoint: 'https://s3.amazonaws.com',
  accessKeyId: 'new-key',
  secretAccessKey: 'new-secret',
});
```

Configuration updates are ephemeral (not persisted to disk).

## Logging

### In Route Handlers

Use `req.log` for request-specific logging:

```typescript
fastify.get('/endpoint', async (req, reply) => {
  req.log.info('Processing request');
  req.log.error(sanitizeErrorForLogging(error));
  req.log.warn('Potential issue detected');
});
```

### In Utilities

Use `createLogger()` for utilities without request context:

```typescript
import { createLogger } from '../utils/logger';

const logger = createLogger(undefined, '[MyUtility]');
logger.info('Operation started');
logger.error('Operation failed');
```

### Startup/Shutdown

Direct `console.log` is acceptable for startup/shutdown messages:

```typescript
console.log('Server starting on port 5000...');
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- buckets.test.ts

# Watch mode
npm test -- --watch
```

### Test Patterns

#### 1. Route Testing

```typescript
import { build } from '../app';

describe('Buckets API', () => {
  let app: any;

  beforeAll(async () => {
    app = await build();
  });

  afterAll(async () => {
    await app.close();
  });

  test('GET /api/buckets should return buckets', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/buckets',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('buckets');
  });
});
```

#### 2. Mocking S3 Operations

```typescript
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
});

test('should list buckets', async () => {
  s3Mock.on(ListBucketsCommand).resolves({
    Buckets: [{ Name: 'test-bucket' }],
  });

  // Test implementation
});
```

#### 3. Error Testing

```typescript
test('should handle S3 errors', async () => {
  s3Mock.on(GetObjectCommand).rejects(new Error('NoSuchKey'));

  const response = await app.inject({
    method: 'GET',
    url: '/api/objects/test-bucket/file.txt',
  });

  expect(response.statusCode).toBe(404);
});
```

## Building for Production

```bash
# Build TypeScript to JavaScript
npm run build

# Run production build
npm start
```

Production build:

- Compiles TypeScript to `dist/`
- Excludes test files (`tsconfig.prod.json`)
- Optimizes for deployment

## Best Practices

### DO

- ✅ Use Fastify plugin pattern for all routes
- ✅ Stream all file operations
- ✅ Use centralized error handlers
- ✅ Use HTTP status constants
- ✅ Apply validation schemas to POST/PUT endpoints
- ✅ Use `TypedRequest` for type safety
- ✅ Sanitize user input before using in headers
- ✅ Use `req.log` for logging in routes
- ✅ Write tests for new endpoints
- ✅ Run `npm run format` before committing

### DON'T

- ❌ Load entire files into memory
- ❌ Skip error handling for S3 operations
- ❌ Use magic numbers for HTTP status codes
- ❌ Type cast request parameters (`as any`)
- ❌ Bypass autoload conventions
- ❌ Create routes outside plugin pattern
- ❌ Hardcode configuration values

## Related Documentation

- [Backend Architecture](../architecture/backend.md) - Detailed architecture overview
- [API Reference](../api/README.md) - Complete API documentation
- [Testing Guide](./testing.md) - Testing strategies and patterns
- [Code Style Guide](./code-style.md) - Coding standards
