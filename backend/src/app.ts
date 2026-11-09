import * as fs from 'fs';
import * as path from 'path';
import { LOG_DIR, NB_PREFIX } from './utils/constants';
import fastifyStatic from '@fastify/static';
import fastifyAutoload from '@fastify/autoload';
import fastifySensible from '@fastify/sensible';
import fastifyWebsocket from '@fastify/websocket';
import fastifyAccepts from '@fastify/accepts';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import { FastifyInstance } from 'fastify/types/instance';
import type { FastifyReply } from 'fastify';
import { authenticateUser, isPublicRoute } from './plugins/auth';
import 'dotenv/config';

/**
 * Loads and templates the index.html file with runtime NB_PREFIX configuration.
 * Injects NB_PREFIX as data attribute (CSP-safe) and updates base href for proper client-side routing.
 */
function loadTemplatedIndexHtml(): string {
  const indexPath = path.join(__dirname, '../../frontend/dist/index.html');

  if (!fs.existsSync(indexPath)) {
    throw new Error(`index.html not found at ${indexPath}`);
  }

  let html = fs.readFileSync(indexPath, 'utf-8');

  // Calculate the base href and public path (with trailing slash for assets)
  const baseHref = NB_PREFIX ? `${NB_PREFIX}/` : '/';

  // Inject NB_PREFIX as data attribute on <html> element (CSP-safe, no inline script)
  // This avoids Content Security Policy violations
  html = html.replace(/<html\s+([^>]*)>/, `<html $1 data-nb-prefix="${NB_PREFIX || ''}">`);

  // Remove the placeholder comment (no longer needed with data attribute approach)
  html = html.replace('<!-- NB_PREFIX_INJECT_PLACEHOLDER -->', '');

  // Update the base href to use the actual runtime value
  // The webpack template may have a placeholder, we need to replace it
  html = html.replace(/<base href="[^"]*">/, `<base href="${baseHref}">`);

  return html;
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const initializeApp = async (fastify: FastifyInstance, opts: any): Promise<void> => {
  if (!fs.existsSync(LOG_DIR)) {
    fastify.log.info(`${LOG_DIR} does not exist. Creating`);
    fs.mkdirSync(LOG_DIR);
    const accessLogPath = path.join(LOG_DIR, 'access.log');
    fs.writeFileSync(accessLogPath, '', { flag: 'w' });
    fastify.log.info(`Created empty access.log file at ${accessLogPath}`);
  }

  fastify.register(fastifySensible);

  fastify.register(fastifyWebsocket);

  fastify.register(FastifySSEPlugin);

  // Register plugins (no prefix needed)
  fastify.register(fastifyAutoload, {
    dir: path.join(__dirname, 'plugins'),
    options: Object.assign({}, opts),
  });

  // Global authentication hook for API routes
  // This runs before all route handlers to enforce authentication
  fastify.addHook('onRequest', async (request, reply) => {
    // Skip OPTIONS preflight requests - let CORS plugin handle them
    if (request.method === 'OPTIONS') {
      return;
    }

    // Get the URL path, stripping the NB_PREFIX if present
    let urlPath = request.url;
    if (NB_PREFIX && urlPath.startsWith(NB_PREFIX)) {
      urlPath = urlPath.substring(NB_PREFIX.length);
    }

    // Only apply authentication to API routes
    if (!urlPath.startsWith('/api')) {
      return;
    }

    // Skip authentication for public routes (auth info, login)
    if (isPublicRoute(urlPath)) {
      return;
    }

    // If authentication is not enabled, skip the check
    // The authenticateUser function handles this internally by creating a mock user
    // but we call it anyway for consistency
    try {
      await authenticateUser(request, reply);
    } catch (error) {
      request.log.error(error, 'Authentication error');
      // Don't re-throw - authenticateUser already sent error response
    }
  });

  // Register routes with prefix if NB_PREFIX is set
  if (NB_PREFIX) {
    await fastify.register(
      async (fastifyWithPrefix) => {
        await fastifyWithPrefix.register(fastifyAutoload, {
          dir: path.join(__dirname, 'routes'),
          options: Object.assign({}, opts),
        });
      },
      { prefix: NB_PREFIX },
    );
  } else {
    await fastify.register(fastifyAutoload, {
      dir: path.join(__dirname, 'routes'),
      options: Object.assign({}, opts),
    });
  }

  // Load and template the index.html with runtime NB_PREFIX
  const templatedIndexHtml = loadTemplatedIndexHtml();
  fastify.log.info(`Loaded templated index.html with NB_PREFIX: ${NB_PREFIX || '(root deployment)'}`);

  // Explicit root route handler to serve templated index.html
  // This MUST be registered BEFORE @fastify/static to take precedence
  if (NB_PREFIX) {
    fastify.get(NB_PREFIX, async (req, res) => {
      res.type('text/html').send(templatedIndexHtml);
    });
    fastify.get(`${NB_PREFIX}/`, async (req, res) => {
      res.type('text/html').send(templatedIndexHtml);
    });
  } else {
    fastify.get('/', async (req, res) => {
      res.type('text/html').send(templatedIndexHtml);
    });
  }

  // Register static file serving with prefix
  // CRITICAL: Set index to false to prevent @fastify/static from serving index.html
  // automatically. We handle index.html explicitly via the root route handler above.
  const staticOptions: any = {
    root: path.join(__dirname, '../../frontend/dist'),
    wildcard: false,
    index: false, // Disable automatic index.html serving
    setHeaders: (res: FastifyReply, filePath: string, _stat: fs.Stats) => {
      // Explicitly set MIME types for font files to ensure proper decoding
      // This is critical in container environments where MIME type mappings may differ
      if (filePath.endsWith('.woff2')) {
        res.header('Content-Type', 'font/woff2');
      } else if (filePath.endsWith('.woff')) {
        res.header('Content-Type', 'font/woff');
      } else if (filePath.endsWith('.ttf')) {
        res.header('Content-Type', 'font/ttf');
      } else if (filePath.endsWith('.eot')) {
        res.header('Content-Type', 'application/vnd.ms-fontobject');
      }
    },
  };
  if (NB_PREFIX) {
    staticOptions.prefix = NB_PREFIX;
  }
  fastify.register(fastifyStatic, staticOptions);

  // Set NotFoundHandler to serve templated index.html for client-side routing
  fastify.setNotFoundHandler((req, res) => {
    res.type('text/html').send(templatedIndexHtml);
  });

  fastify.register(fastifyAccepts);
};
