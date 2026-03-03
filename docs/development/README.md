# Development Guide

This section provides comprehensive guides for developing S4 locally.

## Quick Start

```bash
# Clone repository
git clone https://github.com/rh-aiservices-bu/s4.git
cd s4

# Install dependencies
npm install

# Start development servers
npm run dev
```

## Prerequisites

- **Node.js** 20+ and npm
- **Git** for version control
- **Podman/Docker** (optional, for testing container builds)
- **kubectl** (optional, for Kubernetes deployments)

## Development Servers

When you run `npm run dev`, two servers start:

1. **Backend** (Fastify) - http://localhost:8888

   - API endpoints at `/api/*`
   - Auto-reloads on file changes (nodemon)

2. **Frontend** (React) - http://localhost:9000
   - Web UI with Hot Module Replacement (HMR)
   - Proxies API requests to backend

**Important**: `npm run dev` only starts the Node.js backend and React frontend. It does **not** start the Ceph RGW S3 engine.

### S3 Backend Options for Development

To develop against a working S3 backend, choose one option:

1. **Use full S4 container** (recommended):

   ```bash
   make run
   ```

   Then configure your dev environment to use `http://localhost:7480`

2. **Use external S3 service**:
   Configure via environment variables:
   ```bash
   export AWS_S3_ENDPOINT=https://s3.amazonaws.com
   export AWS_ACCESS_KEY_ID=your-key
   export AWS_SECRET_ACCESS_KEY=your-secret
   ```

## Port Configuration

| Service        | Port | Description                      |
| -------------- | ---- | -------------------------------- |
| Frontend (dev) | 9000 | Webpack dev server with HMR      |
| Backend (dev)  | 8888 | Fastify API server               |
| Backend (prod) | 5000 | Serves both API and static files |
| Ceph RGW       | 7480 | S3-compatible API                |

## Available Commands

```bash
# Development
npm run dev              # Start both backend and frontend in dev mode
npm run start:dev        # Alternative to npm run dev

# Building
npm run build            # Build both backend and frontend for production
npm run build:backend    # Build backend only (TypeScript compilation)
npm run build:frontend   # Build frontend only (Webpack production build)

# Testing
npm test                 # Run all tests (backend + frontend)
npm run test:backend     # Run backend tests only
npm run test:frontend    # Run frontend tests only
npm run test:coverage    # Run tests with coverage report

# Code Quality
npm run lint             # Run ESLint on both backend and frontend
npm run lint:backend     # Lint backend only
npm run lint:frontend    # Lint frontend only
npm run format           # Format code with Prettier
npm run type-check       # TypeScript type checking

# Production
npm start                # Run production build from dist/
```

## Project Structure

```
s4/
├── backend/               # Fastify API server (TypeScript)
│   ├── src/
│   │   ├── routes/api/    # API endpoints
│   │   ├── plugins/       # Fastify plugins
│   │   ├── utils/         # Utilities and helpers
│   │   ├── __tests__/     # Jest tests
│   │   ├── app.ts         # Fastify app initialization
│   │   └── server.ts      # Entry point
│   ├── dist/              # Compiled JavaScript output
│   └── tsconfig.json      # TypeScript configuration
│
├── frontend/              # React application (TypeScript)
│   ├── src/
│   │   ├── app/
│   │   │   ├── components/  # React components
│   │   │   ├── utils/       # Utilities and helpers
│   │   │   ├── hooks/       # Custom React hooks
│   │   │   └── routes.tsx   # Route definitions
│   │   └── index.tsx        # Entry point
│   ├── dist/                # Webpack build output
│   └── webpack.*.js         # Webpack configurations
│
├── docker/                # Container configuration
│   ├── Dockerfile
│   ├── entrypoint.sh
│   └── supervisord.conf
│
├── kubernetes/            # Kubernetes manifests
└── docs/                  # Documentation
```

## Development Workflow

1. **Make changes** to backend or frontend code
2. **Auto-reload** happens automatically
   - Backend: nodemon restarts server
   - Frontend: Webpack HMR updates browser
3. **Test locally** using the dev servers
4. **Run tests** before committing
5. **Format code** with `npm run format`
6. **Commit changes** following [contribution guidelines](./contributing.md)

## Environment Variables

Create a `.env` file in the project root:

```bash
# S3 Configuration
AWS_S3_ENDPOINT=http://localhost:7480
AWS_ACCESS_KEY_ID=s4admin
AWS_SECRET_ACCESS_KEY=s4secret
AWS_DEFAULT_REGION=us-east-1

# Authentication (optional)
UI_USERNAME=admin
UI_PASSWORD=pass
JWT_SECRET=your-secret-key

# Development
PORT=5000
NODE_ENV=development
```

See [Configuration Guide](../deployment/configuration.md) for complete reference.

## Related Guides

- [Backend Development](./backend.md) - Backend development patterns and practices
- [Frontend Development](./frontend.md) - Frontend development patterns and practices
- [Testing Guide](./testing.md) - Testing strategies and patterns
- [Code Style Guide](./code-style.md) - Coding standards and conventions
- [Contributing Guide](./contributing.md) - How to contribute to S4
- [PatternFly 6 Guide](./pf6-guide/README.md) - PatternFly 6 component patterns and best practices

## Troubleshooting

### Port Already in Use

```bash
# Find process using port
lsof -i :9000

# Kill process
kill -9 <PID>
```

### Dependencies Out of Sync

```bash
# Clean install
rm -rf node_modules package-lock.json
npm install
```

### TypeScript Errors

```bash
# Run type checking
npm run type-check

# Check specific file
npx tsc --noEmit src/app/components/MyComponent.tsx
```

### Webpack Build Fails

```bash
# Clear webpack cache
rm -rf frontend/.cache frontend/dist

# Rebuild
npm run build:frontend
```

## Next Steps

- Read [Backend Development Guide](./backend.md) for backend-specific patterns
- Read [Frontend Development Guide](./frontend.md) for frontend-specific patterns
- Review [Testing Guide](./testing.md) for testing strategies
- Check [Architecture Documentation](../architecture/README.md) for system design
