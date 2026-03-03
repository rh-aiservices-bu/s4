import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { base64Decode } from '../../../utils/encoding';
import {
  validatePath,
  getStorageLocations,
  listDirectory,
  createDirectory,
  deleteFileOrDirectory,
  getFileMetadata,
  streamFile,
  checkFileSize,
  SecurityError,
  NotFoundError,
  PermissionError,
  StorageError,
} from '../../../utils/localStorage';
import { getMaxFileSizeBytes, getLocalStoragePaths } from '../../../utils/config';
import { logAccess } from '../../../utils/logAccess';
import { authenticateUser, authorizeLocation } from '../../../plugins/auth';
import { auditLog } from '../../../utils/auditLog';
import { validateFileType } from '../../../utils/fileValidation';
import { checkQuota, updateQuota } from '../../../utils/quotaManager';
import { checkRateLimit, getRateLimitResetTime } from '../../../utils/rateLimit';
import { HttpStatus } from '../../../utils/httpStatus';
import { LocalStorageParams, LocalQueryParams } from '../../../types';

/**
 * Error handler for local storage operations
 */
function handleError(error: any, reply: FastifyReply) {
  if (error instanceof SecurityError) {
    return reply.code(HttpStatus.FORBIDDEN).send({ error: 'Forbidden', message: error.message });
  }
  if (error instanceof NotFoundError) {
    return reply.code(HttpStatus.NOT_FOUND).send({ error: 'Not Found', message: error.message });
  }
  if (error instanceof PermissionError) {
    return reply.code(HttpStatus.FORBIDDEN).send({ error: 'Permission Denied', message: error.message });
  }
  if (error instanceof StorageError) {
    if (error.message.includes('Disk full')) {
      return reply
        .code(HttpStatus.INSUFFICIENT_STORAGE)
        .send({ error: 'Insufficient Storage', message: error.message });
    }
    if (error.message.includes('too large') || error.message.includes('File too large')) {
      return reply.code(HttpStatus.PAYLOAD_TOO_LARGE).send({ error: 'Payload Too Large', message: error.message });
    }
  }
  // Handle Node.js fs errors
  if (error.code === 'ENOENT') {
    return reply.code(HttpStatus.NOT_FOUND).send({ error: 'Not Found', message: error.message });
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return reply.code(HttpStatus.FORBIDDEN).send({ error: 'Permission Denied', message: error.message });
  }
  return reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: 'Internal Server Error', message: error.message });
}

export default async (fastify: FastifyInstance): Promise<void> => {
  // 🔐 SECURITY: Rate limiting for expensive operations
  const RATE_LIMIT_UPLOAD = 20; // requests per minute
  const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute

  /**
   * Authentication hook - authenticates all requests to /api/local/*
   */
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticateUser(request, reply);
  });

  /**
   * Authorization hook - checks locationId access for routes with locationId parameter
   */
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as Partial<LocalStorageParams>;
    if (params.locationId && request.user) {
      try {
        authorizeLocation(request.user, params.locationId);
      } catch (error: any) {
        auditLog(request.user, 'access', `local:${params.locationId}`, 'denied', error.message);
        return reply.code(HttpStatus.FORBIDDEN).send({
          error: 'Forbidden',
          message: error.message,
        });
      }
    }
  });

  /**
   * Audit logging hook - logs all requests after completion
   */
  fastify.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user) {
      const params = request.params as Partial<LocalStorageParams>;
      const resource = params.locationId ? `local:${params.locationId}/${params['*'] || ''}` : 'local:locations';
      const status = reply.statusCode >= 200 && reply.statusCode < 300 ? 'success' : 'failure';
      const action = request.method.toLowerCase();
      auditLog(request.user, action, resource, status);
    }
  });

  /**
   * GET /api/local/debug
   * Returns detailed debugging information about local storage configuration
   * Admin-only endpoint for troubleshooting
   */
  fastify.get('/debug', async (req: FastifyRequest, reply: FastifyReply) => {
    logAccess(req);

    // Require admin role for debug endpoint
    if (!req.user || !req.user.roles.includes('admin')) {
      return reply.code(HttpStatus.FORBIDDEN).send({
        error: 'Forbidden',
        message: 'Debug endpoint requires admin role',
      });
    }

    const rawEnvVar = process.env.LOCAL_STORAGE_PATHS;
    const parsedPaths = getLocalStoragePaths();
    const locations = await getStorageLocations(req.log);

    // Check each directory with detailed stats
    const directoryChecks = await Promise.all(
      parsedPaths.map(async (dirPath: string, index: number) => {
        const check: {
          index: number;
          locationId: string;
          path: string;
          exists: boolean;
          isDirectory: boolean;
          isReadable: boolean;
          isWritable: boolean;
          error: { code: string; message: string } | null;
          isFile?: boolean;
          isSymlink?: boolean;
          size?: number;
          mode?: string;
          uid?: number;
          gid?: number;
        } = {
          index,
          locationId: `local-${index}`,
          path: dirPath,
          exists: false,
          isDirectory: false,
          isReadable: false,
          isWritable: false,
          error: null,
        };

        try {
          const stats = await fs.stat(dirPath);
          check.exists = true;
          check.isDirectory = stats.isDirectory();
          check.isFile = stats.isFile();
          check.isSymlink = stats.isSymbolicLink();
          check.size = stats.size;
          // Convert mode to octal string for debugging (e.g., 0755)
          // eslint-disable-next-line no-restricted-syntax -- toString(8) is the standard way to format file permissions in octal
          check.mode = `0${(stats.mode & 0o777).toString(8)}`;
          check.uid = stats.uid;
          check.gid = stats.gid;
        } catch (error: any) {
          check.error = {
            code: error.code,
            message: error.message,
          };
        }

        // Check read permission
        if (check.exists) {
          try {
            await fs.access(dirPath, fs.constants.R_OK);
            check.isReadable = true;
          } catch {
            check.isReadable = false;
          }

          // Check write permission
          try {
            await fs.access(dirPath, fs.constants.W_OK);
            check.isWritable = true;
          } catch {
            check.isWritable = false;
          }
        }

        return check;
      }),
    );

    return {
      configuration: {
        rawEnvVar,
        parsedPaths,
        pathCount: parsedPaths.length,
      },
      locations: locations.map((loc) => ({
        id: loc.id,
        name: loc.name,
        path: loc.path,
        type: loc.type,
        available: loc.available,
      })),
      directoryChecks,
      authentication: {
        disabled: process.env.DISABLE_AUTH !== 'false',
        user: req.user
          ? {
              id: req.user.id,
              username: req.user.username,
              roles: req.user.roles,
              allowedLocations: req.user.allowedLocations,
            }
          : null,
      },
      recommendations: directoryChecks
        .filter((check: (typeof directoryChecks)[0]) => !check.exists || !check.isDirectory || !check.isReadable)
        .map((check: (typeof directoryChecks)[0]): string | null => {
          if (!check.exists) {
            return `Create directory: mkdir -p ${check.path}`;
          }
          if (!check.isDirectory) {
            return `Path is not a directory: ${check.path}`;
          }
          if (!check.isReadable) {
            return `Grant read permission: chmod +r ${check.path}`;
          }
          if (!check.isWritable) {
            return `Grant write permission: chmod +w ${check.path}`;
          }
          return null;
        })
        .filter((item): item is string => item !== null),
    };
  });

  /**
   * GET /api/local/locations
   * Returns all configured storage locations with availability status
   * Filtered by user's allowedLocations (unless user has admin role)
   */
  fastify.get('/locations', async (req: FastifyRequest) => {
    logAccess(req);
    const allLocations = await getStorageLocations(req.log);

    // Filter locations based on user permissions
    if (!req.user) {
      return { locations: [] };
    }

    // Admin role gets all locations
    if (req.user.roles.includes('admin')) {
      return { locations: allLocations };
    }

    // Filter to only allowed locations
    const filteredLocations = allLocations.filter((location) => req.user!.allowedLocations.includes(location.id));

    return { locations: filteredLocations };
  });

  /**
   * GET /api/local/files/:locationId/*
   * List files at the given path with pagination support
   */
  fastify.get<{
    Params: LocalStorageParams;
    Querystring: LocalQueryParams;
  }>('/files/:locationId/*', async (req, reply) => {
    logAccess(req);
    const { locationId } = req.params;
    const encodedPath = req.params['*'] || '';
    const query = req.query;
    const limit = query.limit ? parseInt(query.limit, 10) : undefined;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;

    try {
      // Decode base64-encoded path from frontend (consistent with other routes)
      const relativePath = encodedPath ? base64Decode(encodedPath) : '';

      const absolutePath = await validatePath(locationId, relativePath);
      const { files, totalCount } = await listDirectory(absolutePath, limit, offset);

      let parentPath = null;
      if (relativePath) {
        const parent = path.dirname(relativePath);
        // path.dirname('subdir') returns '.', which we keep
        // path.dirname('a/b') returns 'a'
        // Only set to null if we're at root
        parentPath = parent === relativePath ? null : parent;
      }

      // Prepend currentPath to each file's path for proper full paths relative to location root
      // This ensures that files in subfolders have their full path (e.g., "test/article.pdf" not just "article.pdf")
      const filesWithFullPaths = files.map((file) => ({
        ...file,
        path: relativePath ? path.join(relativePath, file.path) : file.path,
      }));

      return {
        files: filesWithFullPaths,
        currentPath: relativePath,
        parentPath,
        totalCount,
      };
    } catch (error: any) {
      return handleError(error, reply);
    }
  });

  /**
   * POST /api/local/files/:locationId/*
   * Upload a file with multipart streaming and size validation
   */
  fastify.post<{
    Params: LocalStorageParams;
  }>('/files/:locationId/*', async (req, reply) => {
    logAccess(req);

    // 🔐 SECURITY: Rate limiting for upload requests (expensive operation)
    const clientIp = req.ip || 'unknown';
    const rateLimitKey = `upload:${clientIp}`;

    if (checkRateLimit(rateLimitKey, RATE_LIMIT_UPLOAD, RATE_LIMIT_WINDOW_MS)) {
      const retryAfter = getRateLimitResetTime(rateLimitKey);
      return reply.code(HttpStatus.TOO_MANY_REQUESTS).send({
        error: 'RateLimitExceeded',
        message: `Too many upload requests. Maximum ${RATE_LIMIT_UPLOAD} per minute.`,
        retryAfter,
      });
    }

    const { locationId } = req.params;
    const encodedPath = req.params['*'] || '';

    try {
      // Decode base64-encoded path from frontend
      const relativePath = encodedPath ? base64Decode(encodedPath) : '';

      // For local storage, relativePath is the full file path (including filename)
      // This matches the S3 API behavior where the path specifies the exact destination

      // First, ensure parent directory structure exists (before validation)
      // This is critical for folder uploads with nested paths like "folderA/subfolderB/file.ext"
      const parentRelativePath = path.dirname(relativePath);

      if (parentRelativePath && parentRelativePath !== '.') {
        // Get validated base path
        const basePath = await validatePath(locationId, '.');

        // Construct parent absolute path
        const normalizedParent = path.normalize(parentRelativePath);
        const parentAbsolutePath = path.join(basePath, normalizedParent);

        // Security check: ensure parent doesn't escape base
        if (!parentAbsolutePath.startsWith(basePath + path.sep) && parentAbsolutePath !== basePath) {
          throw new SecurityError(`Path escapes allowed directory: ${parentRelativePath}`);
        }

        // Create directory structure recursively
        await fs.mkdir(parentAbsolutePath, { recursive: true });
      }

      // Now validate the full file path (will succeed because parent exists)
      const absolutePath = await validatePath(locationId, relativePath);

      let data;
      try {
        data = await req.file();
      } catch (_fileError: any) {
        return reply.code(HttpStatus.BAD_REQUEST).send({ error: 'Bad Request', message: 'No file provided' });
      }

      if (!data) {
        return reply.code(HttpStatus.BAD_REQUEST).send({ error: 'Bad Request', message: 'No file provided' });
      }

      // Validate file type using the filename from the path
      const filename = path.basename(absolutePath);
      const { allowed, reason } = validateFileType(filename);
      if (!allowed) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: 'InvalidFileType',
          message: reason,
        });
      }

      // Use absolutePath directly as the full file path (not joining with data.filename)
      const filePath = absolutePath;

      // Check if file exists (conflict detection)
      try {
        await fs.access(filePath);
        return reply.code(HttpStatus.CONFLICT).send({ error: 'Conflict', message: 'File already exists' });
      } catch {
        // File doesn't exist, continue with upload
      }

      // Stream upload with size validation
      let totalSize = 0;
      const maxSize = getMaxFileSizeBytes();

      // Check quota before upload (conservative estimate - we'll update with actual size after)
      const quotaCheck = checkQuota(locationId, maxSize, 1);
      if (!quotaCheck.allowed) {
        return reply.code(HttpStatus.PAYLOAD_TOO_LARGE).send({
          error: 'QuotaExceeded',
          message: quotaCheck.reason,
        });
      }

      await pipeline(
        data.file,
        new Transform({
          transform(chunk, encoding, callback) {
            totalSize += chunk.length;
            if (totalSize > maxSize) {
              callback(new StorageError('File too large'));
            } else {
              callback(null, chunk);
            }
          },
          flush(callback) {
            // Ensure stream is properly finalized
            callback();
          },
        }),
        createWriteStream(filePath),
      );

      // Update quota after successful upload with actual file size
      updateQuota(locationId, totalSize, 1);

      return { uploaded: true, path: relativePath };
    } catch (error: any) {
      return handleError(error, reply);
    }
  });

  /**
   * GET /api/local/view/:locationId/*
   * View a file with streaming (for preview/inline display)
   */
  fastify.get<{
    Params: LocalStorageParams;
  }>('/view/:locationId/*', async (req, reply) => {
    logAccess(req);
    const { locationId } = req.params;
    const encodedPath = req.params['*'] || '';

    try {
      // Decode base64-encoded path from frontend
      const relativePath = encodedPath ? base64Decode(encodedPath) : '';

      const absolutePath = await validatePath(locationId, relativePath);
      await checkFileSize(absolutePath);

      const stream = await streamFile(absolutePath);

      return stream;
    } catch (error: any) {
      return handleError(error, reply);
    }
  });

  /**
   * GET /api/local/download/:locationId/*
   * Download a file with streaming and proper headers
   */
  fastify.get<{
    Params: LocalStorageParams;
  }>('/download/:locationId/*', async (req, reply) => {
    logAccess(req);
    const { locationId } = req.params;
    const encodedPath = req.params['*'] || '';

    try {
      // Decode base64-encoded path from frontend
      const relativePath = encodedPath ? base64Decode(encodedPath) : '';

      const absolutePath = await validatePath(locationId, relativePath);
      await checkFileSize(absolutePath);

      const metadata = await getFileMetadata(absolutePath);
      const stream = await streamFile(absolutePath);

      reply
        .type('application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${metadata.name}"`)
        .header('Content-Length', metadata.size || 0)
        .send(stream);
    } catch (error: any) {
      return handleError(error, reply);
    }
  });

  /**
   * DELETE /api/local/files/:locationId/*
   * Delete a file or directory recursively
   */
  fastify.delete<{
    Params: LocalStorageParams;
  }>('/files/:locationId/*', async (req, reply) => {
    logAccess(req);
    const { locationId } = req.params;
    const encodedPath = req.params['*'] || '';

    try {
      // Decode base64-encoded path from frontend
      const relativePath = encodedPath ? base64Decode(encodedPath) : '';

      const absolutePath = await validatePath(locationId, relativePath);

      // Get file/directory size before deletion for quota update
      let totalSize = 0;
      let fileCount = 0;

      const stats = await fs.stat(absolutePath);
      if (stats.isDirectory()) {
        // Calculate total size of directory contents
        const entries = await fs.readdir(absolutePath, {
          recursive: true,
          withFileTypes: true,
        });
        for (const entry of entries) {
          // entry.parentPath is the absolute path to the parent directory (Node.js 18+)
          // entry.path is undefined when using recursive with withFileTypes
          const entryPath = path.join(entry.parentPath, entry.name);
          try {
            const entryStat = await fs.stat(entryPath);
            if (entryStat.isFile()) {
              totalSize += entryStat.size;
              fileCount++;
            }
          } catch {
            // Skip inaccessible files
          }
        }
        fileCount++; // Count the directory itself
      } else {
        totalSize = stats.size;
        fileCount = 1;
      }

      const itemCount = await deleteFileOrDirectory(absolutePath);

      // Update quota after successful deletion (negative values)
      updateQuota(locationId, -totalSize, -fileCount);

      return { deleted: true, itemCount };
    } catch (error: any) {
      return handleError(error, reply);
    }
  });

  /**
   * POST /api/local/directories/:locationId/*
   * Create a directory (mkdir -p behavior)
   */
  fastify.post<{
    Params: LocalStorageParams;
  }>('/directories/:locationId/*', async (req, reply) => {
    logAccess(req);
    const { locationId } = req.params;
    const encodedPath = req.params['*'] || '';

    try {
      // Decode base64-encoded path from frontend
      const relativePath = encodedPath ? base64Decode(encodedPath) : '';

      const absolutePath = await validatePath(locationId, relativePath);
      await createDirectory(absolutePath);

      return { created: true, path: relativePath };
    } catch (error: any) {
      return handleError(error, reply);
    }
  });
};
