import { fastify } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { APP_ENV, PORT, IP, LOG_LEVEL, LOG_HEALTH_CHECKS } from './utils/constants';
import { initializeApp } from './app';
import { AddressInfo } from 'net';
import https from 'https';
import fs from 'fs';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { getCorsConfig } from './config/cors';
import { getLocalStoragePaths } from './utils/config';
import { getStorageLocations } from './utils/localStorage';

const app = fastify({
  logger: {
    level: LOG_LEVEL,
    redact: [
      'err.response.request.headers.Authorization',
      'response.request.headers.Authorization',
      'request.headers.Authorization',
      'headers.Authorization',
      'Authorization',
    ],
    ...(APP_ENV === 'development' && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    }),
  },
  disableRequestLogging: true, // Disable default logging so we can filter health checks
  pluginTimeout: 10000,
  maxParamLength: 1000,
});

// Helper to check if request is a health check probe or idle culler request
const isHealthCheckRequest = (url: string | undefined, method: string): boolean => {
  if (method !== 'GET' || !url) {
    return false;
  }
  // OpenShift liveness/readiness probes
  if (url.endsWith('/api')) {
    return true;
  }
  // Idle culler mechanism endpoints
  if (url.endsWith('/api/kernels') || url.endsWith('/api/terminals')) {
    return true;
  }
  return false;
};

// Custom request logging hook - filters out health check requests
app.addHook('onRequest', async (request, _reply) => {
  const isHealthCheck = isHealthCheckRequest(request.url, request.method);
  if (!isHealthCheck || LOG_HEALTH_CHECKS) {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        hostname: request.hostname,
        remoteAddress: request.ip,
      },
      'incoming request',
    );
  }
});

// Custom response logging hook - filters out health check requests
app.addHook('onResponse', async (request, reply) => {
  const isHealthCheck = isHealthCheckRequest(request.url, request.method);
  if (!isHealthCheck || LOG_HEALTH_CHECKS) {
    request.log.info(
      {
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'request completed',
    );
  }
});

// Debug: Log CORS headers on OPTIONS responses
app.addHook('onSend', async (request, reply, _payload) => {
  if (request.method === 'OPTIONS') {
    request.log.info(
      {
        url: request.url,
        origin: request.headers.origin,
        allowOrigin: reply.getHeader('access-control-allow-origin'),
        allowMethods: reply.getHeader('access-control-allow-methods'),
        allowHeaders: reply.getHeader('access-control-allow-headers'),
        allowCredentials: reply.getHeader('access-control-allow-credentials'),
      },
      'OPTIONS response headers',
    );
  }
});

// Register CORS with secure configuration
app.register(cors, getCorsConfig());

// Register cookie plugin for authentication
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fastifyCookie = require('@fastify/cookie');
app.register(fastifyCookie, {
  secret: process.env.JWT_SECRET || 'dev-cookie-secret', // Use JWT secret for cookie signing
  parseOptions: {}, // Default options
});

// Add security headers via Helmet
app.register(helmet, {
  strictTransportSecurity: false, // S4 runs behind a reverse proxy/ingress that handles TLS
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // PatternFly needs inline styles
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'], // blob: for Blob URLs from file uploads/previews
      connectSrc:
        APP_ENV === 'development'
          ? [
              "'self'",
              'http://localhost:8888',
              'http://localhost:9000',
              'http://127.0.0.1:8888',
              'http://127.0.0.1:9000',
            ]
          : ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      frameAncestors: ["'none'"], // Prevents clickjacking attacks
    },
  },
  crossOriginEmbedderPolicy: false, // Needed for some assets
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

app.register(fastifyMultipart);

app.register(initializeApp);

app.listen({ port: PORT, host: IP }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1); // eslint-disable-line
  }

  // Log CORS configuration
  app.log.info('CORS configured to reflect request origin');

  // Log local storage configuration
  const localPaths = getLocalStoragePaths();
  app.log.info(
    {
      rawEnvVar: process.env.LOCAL_STORAGE_PATHS,
      parsedPaths: localPaths,
      pathCount: localPaths.length,
    },
    'Local storage paths configuration',
  );

  // Check availability of local storage paths
  getStorageLocations(app.log)
    .then((locations) => {
      const available = locations.filter((loc) => loc.available);
      const unavailable = locations.filter((loc) => !loc.available);

      if (available.length > 0) {
        app.log.info(
          {
            locations: available.map((loc) => ({
              id: loc.id,
              path: loc.path,
            })),
          },
          `${available.length} local storage location(s) available`,
        );
      }

      if (unavailable.length > 0) {
        app.log.warn(
          {
            locations: unavailable.map((loc) => ({
              id: loc.id,
              path: loc.path,
            })),
          },
          `${unavailable.length} local storage location(s) UNAVAILABLE - directories may not exist or lack permissions`,
        );
      }

      if (locations.length === 0) {
        app.log.warn('No local storage locations configured');
      }
    })
    .catch((err) => {
      app.log.error({ err }, 'Failed to check local storage locations');
    });

  // Load CA bundle used in our API calls
  // tls-ca-bundle.pem is the default CA bundle used by the system in CentOS/RHEL
  // ca.crt is the default CA bundle provided by the service account for kubernetes
  // service-ca.crt is the CA bundle provided by the service account for kubernetes used by prometheus
  // odh-ca-bundle.crt and odh-trusted-ca-bundle.crt are the CA bundles provided by the ODH platform
  const caPaths = [
    '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
    '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    '/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt',
    '/etc/pki/tls/certs/odh-ca-bundle.crt',
    '/etc/pki/tls/certs/odh-trusted-ca-bundle.crt',
  ]
    .map(getCABundle)
    .filter((ca) => ca !== undefined);

  https.globalAgent.options.ca = caPaths as Buffer[];

  const address: AddressInfo = app.server.address() as AddressInfo;
  console.log('Fastify Connected...');
  console.log(`Server listening on >>>  ${address.address}:${address.port}`);
});

const getCABundle = (path: string) => {
  try {
    return fs.readFileSync(path);
  } catch (_e) {
    // ignore
  }
  return undefined;
};
