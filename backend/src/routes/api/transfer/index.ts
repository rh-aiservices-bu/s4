import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pipeline } from 'stream/promises';
import { Transform, Readable } from 'stream';
import { promises as fs } from 'fs';
import path from 'path';
import {
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getS3Config } from '../../../utils/config';
import { validatePath } from '../../../utils/localStorage';
import { transferQueue, TransferFileJob, TransferJob } from '../../../utils/transferQueue';
import { uploadWithCleanup } from '../../../utils/streamHelpers';
import { authenticateUser, authorizeLocation } from '../../../plugins/auth';
import { auditLog } from '../../../utils/auditLog';
import { checkRateLimit, getRateLimitResetTime } from '../../../utils/rateLimit';
import { logMemory } from '../../../utils/memoryProfiler';
import {
  listS3DirectoryRecursive,
  listLocalDirectoryRecursive,
  FileInfo,
  DirectoryListing,
} from '../../../utils/directoryListing';
import { sanitizeError, sanitizeErrorForLogging } from '../../../utils/errorLogging';
import { formatBytes } from '../../../utils/formatting';
import { transferRequestSchema, conflictCheckRequestSchema } from '../../../schemas';
import { HttpStatus } from '../../../utils/httpStatus';
import { createLogger } from '../../../utils/logger';

// Module-level logger for helper functions outside route context
const logger = createLogger(undefined, '[Transfer]');

/**
 * Represents an item (file or directory) to be transferred
 *
 * Path Format Examples:
 * - User navigates to: /bucket/datasets/
 * - User selects folder: "models/" → { path: "models", type: "directory" }
 * - User selects file: "readme.txt" → { path: "readme.txt", type: "file" }
 *
 * When "models" folder is expanded, child files become:
 * - { path: "models/config.json", type: "file" }
 * - { path: "models/weights/layer1.bin", type: "file" }
 */
interface TransferItem {
  /** Relative path from source.path (no leading slash) */
  path: string;
  /** Type of item - file or directory */
  type: 'file' | 'directory';
}

/**
 * Request body for transfer initiation
 * Updated to support both files and directories via items array
 */
interface TransferRequest {
  source: {
    type: 'local' | 's3';
    locationId: string;
    path: string;
  };
  destination: {
    type: 'local' | 's3';
    locationId: string;
    path: string;
  };
  items: TransferItem[];
  conflictResolution: 'overwrite' | 'skip' | 'rename';
}

/**
 * Request body for conflict check
 * Updated to support both files and directories via items array
 */
interface ConflictCheckRequest {
  source: {
    type: 'local' | 's3';
    locationId: string;
    path: string;
  };
  destination: {
    type: 'local' | 's3';
    locationId: string;
    path: string;
  };
  items: TransferItem[];
}

/**
 * Response from conflict check endpoint
 * Provides smart conflict resolution data and large folder warnings
 */
interface ConflictCheckResponse {
  /** Files that exist in both source and destination (user must decide) */
  conflicts: string[];
  /** Files that only exist in source (will be auto-copied without prompt) */
  nonConflicting: string[];
  /** Warning for large folders (>= 1000 files OR >= 10GB) */
  warning?: {
    type: 'large_folder';
    fileCount: number;
    totalSize: number;
    message: string;
  };
}

/**
 * Thresholds for large folder warnings
 * Warns users when folders exceed EITHER threshold (file count OR total size)
 */
const LARGE_FOLDER_FILE_THRESHOLD = 1000; // Number of files
const LARGE_FOLDER_SIZE_THRESHOLD = 10 * 1024 * 1024 * 1024; // 10GB in bytes

/**
 * Parse transfer path format: "type:locationId/path"
 */
function parseTransferPath(transferPath: string): [string, string, string] {
  const colonIndex = transferPath.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid transfer path format: ${transferPath}`);
  }

  const type = transferPath.substring(0, colonIndex);
  const remainder = transferPath.substring(colonIndex + 1);
  const slashIndex = remainder.indexOf('/');

  if (slashIndex === -1) {
    throw new Error(`Invalid transfer path format: ${transferPath}`);
  }

  const locationId = remainder.substring(0, slashIndex);
  const filePath = remainder.substring(slashIndex + 1);

  return [type, locationId, filePath];
}

/**
 * Note: All S3 operations (metadata and data transfers) now share the same
 * concurrency limiter from transferQueue to prevent overwhelming S3 endpoints.
 * This ensures total concurrent S3 operations never exceed MAX_CONCURRENT_TRANSFERS.
 */

/**
 * Ensures a directory exists, creating it and all parent directories if needed
 * Handles EEXIST gracefully (already exists)
 *
 * @param dirPath - Absolute path to directory
 */
async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error: any) {
    // EEXIST is fine - directory already exists
    if (error.code !== 'EEXIST') {
      throw new Error(`Failed to create directory ${dirPath}: ${error.message}`);
    }
  }
}

/**
 * Check if a file exists at the given location
 */
async function checkExists(type: string, locationId: string, filePath: string): Promise<boolean> {
  try {
    if (type === 'local') {
      const absolutePath = await validatePath(locationId, filePath);
      await fs.access(absolutePath);
      return true;
    } else if (type === 's3') {
      const { s3Client } = getS3Config();
      const command = new HeadObjectCommand({
        Bucket: locationId,
        Key: filePath,
      });

      await transferQueue.getMetadataLimiter()(() => s3Client.send(command));
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Find a non-conflicting filename by appending -1, -2, etc.
 */
async function findNonConflictingName(type: string, locationId: string, filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);

  let counter = 1;
  let testPath = filePath;

  while (await checkExists(type, locationId, testPath)) {
    testPath = path.join(dir, `${baseName}-${counter}${ext}`);
    counter++;
  }

  return testPath;
}

/**
 * Retry helper for network operations with exponential backoff
 * Retries network errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EAI_AGAIN)
 * @param operation - Async function to retry
 * @param operationName - Name for logging
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param abortSignal - Optional abort signal to cancel the operation
 * @returns Result of the operation
 */
async function retryNetworkOperation<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = 3,
  abortSignal?: AbortSignal,
): Promise<T> {
  const retryableErrorCodes = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check if operation was aborted before attempting
    if (abortSignal?.aborted) {
      const abortError = new Error('Transfer cancelled by user');
      abortError.name = 'AbortError';
      throw abortError;
    }

    try {
      return await operation();
    } catch (error: any) {
      // Check if this is an abort error from the SDK
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        throw error;
      }

      const isRetryable = retryableErrorCodes.includes(error.code);
      const isLastAttempt = attempt === maxRetries;

      if (!isRetryable || isLastAttempt) {
        // Not a retryable error or exhausted retries - throw
        throw error;
      }

      // Calculate backoff delay: 1s, 2s, 4s
      const delayMs = 1000 * Math.pow(2, attempt);
      logger.warn(
        {
          operationName,
          errorCode: error.code,
          attempt: attempt + 1,
          maxRetries,
          delayMs,
        },
        'Retrying failed operation',
      );

      // Wait before retrying, but check abort signal during delay
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, delayMs);

        // If aborted during delay, cancel timeout and reject
        if (abortSignal) {
          const abortHandler = () => {
            clearTimeout(timeout);
            const abortError = new Error('Transfer cancelled by user');
            abortError.name = 'AbortError';
            reject(abortError);
          };

          abortSignal.addEventListener('abort', abortHandler, { once: true });

          // Clean up listener when timeout completes normally
          setTimeout(() => abortSignal.removeEventListener('abort', abortHandler), delayMs);
        }
      });
    }
  }

  // Should never reach here, but TypeScript doesn't know that
  throw new Error('Unexpected retry loop exit');
}

/**
 * Transfer S3 → Local
 *
 * Note: .s3keep marker files are skipped during S3→Local transfers.
 * Empty directories are created naturally on the local filesystem via mkdir -p.
 */
async function transferS3ToLocal(
  bucket: string,
  key: string,
  locationId: string,
  destPath: string,
  fileJob: TransferFileJob,
  onProgress: (loaded: number) => void,
  abortSignal: AbortSignal,
): Promise<void> {
  // Skip .s3keep marker files - local filesystem supports empty directories natively
  if (path.basename(key) === '.s3keep') {
    // Mark as completed with zero size - no actual transfer needed
    fileJob.size = 0;
    onProgress(0);
    return;
  }

  // Memory profiling: Start of S3→Local transfer
  const fileName = path.basename(key);
  logMemory(`[S3→Local] Start: ${fileName}`);

  const { s3Client } = getS3Config();

  // Get base path and construct full destination path
  const basePath = await validatePath(locationId, '');
  const fullDestPath = path.join(basePath, destPath);

  // Create parent directory structure BEFORE validatePath
  const destDir = path.dirname(fullDestPath);
  await ensureDirectoryExists(destDir);

  // NOW validate the full path (parent exists, so validation succeeds)
  const absolutePath = await validatePath(locationId, destPath);

  let response;
  try {
    // Wrap GetObject in retry logic for network errors
    response = await retryNetworkOperation(
      async () => {
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        return await s3Client.send(command, { abortSignal });
      },
      `GetObject: ${key}`,
      3, // Retry up to 3 times
      abortSignal, // Pass abort signal to retry logic
    );
  } catch (error: any) {
    // Throw a sanitized error without AWS SDK internals (socket/agent references with certificates)
    throw sanitizeError(error);
  }

  if (!response.Body) {
    throw new Error('S3 response body is empty');
  }

  // Get file size from response
  fileJob.size = response.ContentLength || 0;

  // Memory profiling: Metadata received
  const sizeInMB = (fileJob.size / (1024 * 1024)).toFixed(2);
  logMemory(`[S3→Local] Metadata received: ${fileName} (${sizeInMB} MB)`);

  // Progress throttling: only report every 1MB to reduce event frequency
  const PROGRESS_THRESHOLD = 1024 * 1024; // 1MB
  let loaded = 0;
  let lastReported = 0;
  const progressTransform = new Transform({
    transform(chunk, encoding, callback) {
      loaded += chunk.length;
      // Only report progress every 1MB
      if (loaded - lastReported >= PROGRESS_THRESHOLD) {
        onProgress(loaded);
        lastReported = loaded;
      }
      callback(null, chunk);
    },
    flush(callback) {
      // Ensure final progress is always reported (100%)
      if (loaded > lastReported) {
        onProgress(loaded);
      }
      callback();
    },
  });

  // Add abort handling to both streams
  if (abortSignal) {
    const abortHandler = () => {
      const abortError = new Error('Transfer cancelled');
      // Destroy both the source stream and transform stream
      // JUSTIFICATION: AWS SDK types `response.Body` as their internal Readable type,
      // but runtime object is Node.js Readable with destroy() method. SDK types don't
      // expose destroy() despite actual runtime support. Runtime type check ensures safety.
      if (response.Body && typeof (response.Body as any).destroy === 'function') {
        (response.Body as any).destroy(abortError);
      }
      progressTransform.destroy(abortError);
    };
    abortSignal.addEventListener('abort', abortHandler);
    progressTransform.on('close', () => {
      abortSignal.removeEventListener('abort', abortHandler);
    });
  }

  // Memory profiling: Before pipeline
  logMemory(`[S3→Local] Before pipeline: ${fileName}`);

  const { createWriteStream } = await import('fs');
  await pipeline(response.Body as Readable, progressTransform, createWriteStream(absolutePath));

  // Memory profiling: Transfer complete
  logMemory(`[S3→Local] Complete: ${fileName}`);
}

/**
 * Transfer Local → S3
 */
async function transferLocalToS3(
  locationId: string,
  sourcePath: string,
  bucket: string,
  key: string,
  fileJob: TransferFileJob,
  onProgress: (loaded: number) => void,
): Promise<void> {
  const { s3Client } = getS3Config();

  // NOTE: S3 doesn't need directory creation - object keys preserve structure
  // The key itself can contain '/' characters which act as virtual directories

  // Check if this is a .s3keep marker file
  if (fileJob.isMarker || path.basename(key) === '.s3keep') {
    // Create empty .s3keep marker in S3
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: '',
      ContentLength: 0,
    });

    await s3Client.send(command);
    fileJob.size = 0;
    onProgress(0);
    return;
  }

  // Memory profiling: Start of Local→S3 transfer
  const fileName = path.basename(sourcePath);
  logMemory(`[Local→S3] Start: ${fileName}`);

  // Otherwise, proceed with normal file upload
  const absolutePath = await validatePath(locationId, sourcePath);

  // Get file size
  const stats = await fs.stat(absolutePath);
  fileJob.size = stats.size;
  const sizeInMB = (fileJob.size / (1024 * 1024)).toFixed(2);

  // Memory profiling: File size obtained
  logMemory(`[Local→S3] File size: ${fileName} (${sizeInMB} MB)`);

  const { createReadStream } = await import('fs');
  const fileStream = createReadStream(absolutePath);

  const upload = new Upload({
    client: s3Client,
    params: { Bucket: bucket, Key: key, Body: fileStream },
  });

  // Throttled progress tracking to prevent memory leaks
  const PROGRESS_THRESHOLD = 1024 * 1024; // 1MB
  let lastReported = 0;

  const throttledProgress = (loaded: number) => {
    // Only update progress every 1MB
    if (loaded - lastReported >= PROGRESS_THRESHOLD) {
      onProgress(loaded);
      lastReported = loaded;
    }
  };

  // Memory profiling: Before upload
  logMemory(`[Local→S3] Before upload: ${fileName}`);

  // Use uploadWithCleanup to ensure event listeners are removed
  await uploadWithCleanup(upload, throttledProgress);

  // Ensure 100% progress is reported at completion
  if (fileJob.size > lastReported) {
    onProgress(fileJob.size);
  }

  // Memory profiling: Upload complete
  logMemory(`[Local→S3] Complete: ${fileName}`);
}

/**
 * Transfer Local → Local
 */
async function transferLocalToLocal(
  sourceLoc: string,
  sourcePath: string,
  destLoc: string,
  destPath: string,
  fileJob: TransferFileJob,
  onProgress: (loaded: number) => void,
  abortSignal: AbortSignal,
): Promise<void> {
  // Memory profiling: Start of Local→Local transfer
  const fileName = path.basename(sourcePath);
  logMemory(`[Local→Local] Start: ${fileName}`);

  const sourceAbsolute = await validatePath(sourceLoc, sourcePath);

  // Get base path and construct full destination path
  const destBasePath = await validatePath(destLoc, '');
  const fullDestPath = path.join(destBasePath, destPath);

  // Create parent directory structure BEFORE validatePath
  const destDir = path.dirname(fullDestPath);
  await ensureDirectoryExists(destDir);

  // NOW validate the full path (parent exists, so validation succeeds)
  const destAbsolute = await validatePath(destLoc, destPath);

  // Get file size
  const stats = await fs.stat(sourceAbsolute);
  fileJob.size = stats.size;

  // Memory profiling: File size obtained
  const sizeInMB = (fileJob.size / (1024 * 1024)).toFixed(2);
  logMemory(`[Local→Local] File size: ${fileName} (${sizeInMB} MB)`);

  // Progress throttling: only report every 1MB to reduce event frequency
  const PROGRESS_THRESHOLD = 1024 * 1024; // 1MB
  let loaded = 0;
  let lastReported = 0;
  const progressTransform = new Transform({
    transform(chunk, encoding, callback) {
      loaded += chunk.length;
      // Only report progress every 1MB
      if (loaded - lastReported >= PROGRESS_THRESHOLD) {
        onProgress(loaded);
        lastReported = loaded;
      }
      callback(null, chunk);
    },
    flush(callback) {
      // Ensure final progress is always reported (100%)
      if (loaded > lastReported) {
        onProgress(loaded);
      }
      callback();
    },
  });

  // Memory profiling: Before pipeline
  logMemory(`[Local→Local] Before pipeline: ${fileName}`);

  const { createReadStream, createWriteStream } = await import('fs');
  const readStream = createReadStream(sourceAbsolute);
  const writeStream = createWriteStream(destAbsolute);

  // Add abort handling to all streams
  if (abortSignal) {
    const abortHandler = () => {
      const abortError = new Error('Transfer cancelled');
      // Destroy all streams in the pipeline
      readStream.destroy(abortError);
      progressTransform.destroy(abortError);
      writeStream.destroy(abortError);
    };
    abortSignal.addEventListener('abort', abortHandler);
    progressTransform.on('close', () => {
      abortSignal.removeEventListener('abort', abortHandler);
    });
  }

  await pipeline(readStream, progressTransform, writeStream);

  // Memory profiling: Transfer complete
  logMemory(`[Local→Local] Complete: ${fileName}`);
}

/**
 * Transfer S3 → S3
 *
 * Note: .s3keep marker files are transferred normally to preserve empty directories.
 * S3 doesn't have real directories, so .s3keep files maintain the structure.
 */
async function transferS3ToS3(
  sourceBucket: string,
  sourceKey: string,
  destBucket: string,
  destKey: string,
  fileJob: TransferFileJob,
  onProgress: (loaded: number) => void,
  abortSignal: AbortSignal,
): Promise<void> {
  // Memory profiling: Start of S3→S3 transfer
  const fileName = path.basename(sourceKey);
  logMemory(`[S3→S3] Start: ${fileName}`);

  const { s3Client } = getS3Config();

  // NOTE: S3 doesn't need directory creation - object keys preserve structure
  // .s3keep files are copied as regular objects to preserve empty directories

  // Get source object size (limit concurrent HEAD requests)
  const headCommand = new HeadObjectCommand({
    Bucket: sourceBucket,
    Key: sourceKey,
  });
  const headResponse = await transferQueue.getMetadataLimiter()(() => s3Client.send(headCommand));
  fileJob.size = headResponse.ContentLength || 0;

  // Memory profiling: File size obtained
  const sizeInMB = (fileJob.size / (1024 * 1024)).toFixed(2);
  logMemory(`[S3→S3] File size: ${fileName} (${sizeInMB} MB)`);

  // Stream from source bucket via GetObject (with retry + abort support)
  let response;
  try {
    response = await retryNetworkOperation(
      async () => {
        const command = new GetObjectCommand({ Bucket: sourceBucket, Key: sourceKey });
        return await s3Client.send(command, { abortSignal });
      },
      `GetObject: ${sourceKey}`,
      3,
      abortSignal,
    );
  } catch (error: any) {
    throw sanitizeError(error);
  }

  if (!response.Body) {
    throw new Error('S3 response body is empty');
  }

  // Memory profiling: Before upload
  logMemory(`[S3→S3] Before upload: ${fileName}`);

  // Upload to destination bucket using stream-through pattern
  const upload = new Upload({
    client: s3Client,
    params: { Bucket: destBucket, Key: destKey, Body: response.Body as Readable },
  });

  // Throttled progress tracking to prevent memory leaks
  const PROGRESS_THRESHOLD = 1024 * 1024; // 1MB
  let lastReported = 0;

  const throttledProgress = (loaded: number) => {
    if (loaded - lastReported >= PROGRESS_THRESHOLD) {
      onProgress(loaded);
      lastReported = loaded;
    }
  };

  await uploadWithCleanup(upload, throttledProgress);

  // Ensure 100% progress is reported at completion
  if (fileJob.size > lastReported) {
    onProgress(fileJob.size);
  }

  // Memory profiling: Transfer complete
  logMemory(`[S3→S3] Complete: ${fileName}`);
}

/**
 * Execute transfer based on source and destination types
 */
async function executeTransfer(
  fileJob: TransferFileJob,
  source: TransferRequest['source'],
  destination: TransferRequest['destination'],
  conflictResolution: string,
  onProgress: (loaded: number) => void,
  abortSignal: AbortSignal,
): Promise<void> {
  // Parse source and destination paths
  const [sourceType, sourceLoc, sourcePath] = parseTransferPath(fileJob.sourcePath);
  const [destType, destLoc, destPath] = parseTransferPath(fileJob.destinationPath);

  // Handle conflict resolution
  let finalDestPath = destPath;
  if (conflictResolution === 'skip') {
    const exists = await checkExists(destType, destLoc, destPath);
    if (exists) {
      // Skip this file - mark as completed
      fileJob.size = 0;
      return;
    }
  } else if (conflictResolution === 'rename') {
    finalDestPath = await findNonConflictingName(destType, destLoc, destPath);
  }

  // Execute transfer based on source/destination types
  if (sourceType === 's3' && destType === 'local') {
    await transferS3ToLocal(sourceLoc, sourcePath, destLoc, finalDestPath, fileJob, onProgress, abortSignal);
  } else if (sourceType === 'local' && destType === 's3') {
    await transferLocalToS3(sourceLoc, sourcePath, destLoc, finalDestPath, fileJob, onProgress);
  } else if (sourceType === 'local' && destType === 'local') {
    await transferLocalToLocal(sourceLoc, sourcePath, destLoc, finalDestPath, fileJob, onProgress, abortSignal);
  } else if (sourceType === 's3' && destType === 's3') {
    await transferS3ToS3(sourceLoc, sourcePath, destLoc, finalDestPath, fileJob, onProgress, abortSignal);
  } else {
    throw new Error(`Unsupported transfer combination: ${sourceType} → ${destType}`);
  }
}

/**
 * Expands transfer items (files and directories) into a flat list of files with sizes
 * Calculates file sizes upfront for accurate progress tracking
 *
 * @param items - Array of items to transfer (files and/or directories)
 * @param source - Source location configuration
 * @param destination - Destination location configuration (for .s3keep marker detection)
 * @param logger - Fastify logger for warnings
 * @returns Array of FileInfo objects with paths and sizes
 */
async function expandItemsToFiles(
  items: TransferItem[],
  source: TransferRequest['source'],
  destination: TransferRequest['destination'],
  logger: any,
): Promise<FileInfo[]> {
  const allFiles: FileInfo[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (item.type === 'file') {
      // Individual file - get size upfront for accurate progress tracking
      let size = 0;

      if (source.type === 's3') {
        const { s3Client } = getS3Config();

        // S3 always uses forward slashes (POSIX paths) regardless of OS
        const key = source.path ? path.posix.join(source.path, item.path) : item.path;

        try {
          // Limit concurrent HEAD requests to prevent overwhelming S3 endpoint
          const response = await transferQueue.getMetadataLimiter()(async () => {
            return await s3Client.send(
              new HeadObjectCommand({
                Bucket: source.locationId,
                Key: key,
              }),
            );
          });

          size = response.ContentLength || 0;
        } catch (error: any) {
          if (error instanceof S3ServiceException) {
            const statusCode = error.$metadata?.httpStatusCode || 500;
            if (error.name === 'NotFound' || error.name === 'NoSuchKey' || statusCode === 404) {
              throw new Error(`File not found in S3: ${key}`);
            }
            if (error.name === 'AccessDenied' || error.name === 'Forbidden' || statusCode === 403) {
              throw new Error(`Access denied to S3 file: ${key} in bucket ${source.locationId}`);
            }
            if (error.name === 'NoSuchBucket') {
              throw new Error(`S3 bucket not found: ${source.locationId}`);
            }
            throw new Error(`S3 error accessing file ${key}: ${error.message} (HTTP ${statusCode})`);
          }
          throw new Error(`Failed to get file size for ${key}: ${error.message}`);
        }
      } else {
        // Local storage
        const fullPath = await validatePath(source.locationId, path.join(source.path, item.path));

        try {
          const stats = await fs.stat(fullPath);

          if (!stats.isFile()) {
            throw new Error(`Path is not a file: ${item.path}`);
          }
          size = stats.size;
        } catch (error: any) {
          if (error.code === 'ENOENT') {
            throw new Error(`File not found in local storage: ${item.path}`);
          }
          if (error.code === 'EACCES' || error.code === 'EPERM') {
            throw new Error(`Permission denied accessing file: ${item.path}`);
          }
          if (error.code === 'EISDIR') {
            throw new Error(`Path is a directory, not a file: ${item.path}`);
          }
          throw new Error(`Filesystem error accessing ${item.path}: ${error.message}`);
        }
      }

      allFiles.push({ path: item.path, size });
    } else if (item.type === 'directory') {
      // Directory - expand to file list with sizes
      let dirListing: DirectoryListing;

      if (source.type === 's3') {
        const { s3Client } = getS3Config();
        // S3 always uses forward slashes (POSIX paths) regardless of OS
        const prefix = source.path ? path.posix.join(source.path, item.path) : item.path;

        try {
          dirListing = await listS3DirectoryRecursive(
            s3Client,
            source.locationId,
            prefix,
            transferQueue.getMetadataLimiter(),
          );
        } catch (error: any) {
          if (error instanceof S3ServiceException) {
            const statusCode = error.$metadata?.httpStatusCode || 500;
            if (error.name === 'NoSuchBucket') {
              throw new Error(`S3 bucket not found: ${source.locationId}`);
            }
            if (error.name === 'AccessDenied' || error.name === 'Forbidden' || statusCode === 403) {
              throw new Error(`Access denied to S3 directory: ${prefix} in bucket ${source.locationId}`);
            }
            throw new Error(`S3 error listing directory ${prefix}: ${error.message} (HTTP ${statusCode})`);
          }
          throw new Error(`Failed to list S3 directory ${prefix}: ${error.message}`);
        }

        // Make paths relative to source.path
        // S3 keys come back as full paths, need to strip source.path prefix
        // Remove any trailing slashes before adding one to avoid double slashes
        const normalizedSourcePath = source.path?.replace(/\/+$/, '') || '';
        const sourcePrefix = normalizedSourcePath ? `${normalizedSourcePath}/` : '';
        dirListing.files = dirListing.files.map((f) => {
          if (sourcePrefix && !f.path.startsWith(sourcePrefix)) {
            throw new Error(`Unexpected S3 path format: "${f.path}" doesn't start with prefix "${sourcePrefix}"`);
          }
          return {
            ...f,
            path: sourcePrefix ? f.path.substring(sourcePrefix.length) : f.path,
          };
        });
      } else {
        // Local storage - use OS-specific separators (handled by path.join)
        const relativePath = path.join(source.path, item.path);

        try {
          const basePath = await validatePath(source.locationId, '');
          dirListing = await listLocalDirectoryRecursive(basePath, relativePath);
        } catch (error: any) {
          if (error.code === 'ENOENT') {
            throw new Error(`Directory not found in local storage: ${item.path}`);
          }
          if (error.code === 'EACCES' || error.code === 'EPERM') {
            throw new Error(`Permission denied accessing directory: ${item.path}`);
          }
          if (error.code === 'ENOTDIR') {
            throw new Error(`Path is not a directory: ${item.path}`);
          }
          throw new Error(`Filesystem error listing directory ${item.path}: ${error.message}`);
        }

        // Make paths relative to source.path
        // Remove any trailing slashes before adding one to avoid double slashes
        const normalizedSourcePath = source.path?.replace(/\/+$/, '') || '';
        const sourcePrefix = normalizedSourcePath ? `${normalizedSourcePath}/` : '';
        dirListing.files = dirListing.files.map((f) => {
          if (sourcePrefix && !f.path.startsWith(sourcePrefix)) {
            throw new Error(`Unexpected local path format: "${f.path}" doesn't start with prefix "${sourcePrefix}"`);
          }
          return {
            ...f,
            path: sourcePrefix ? f.path.substring(sourcePrefix.length) : f.path,
          };
        });

        // If destination is S3, add .s3keep markers for empty directories
        if (destination.type === 's3') {
          for (const emptyDir of dirListing.emptyDirectories) {
            // Adjust path to be relative to source.path
            if (sourcePrefix && !emptyDir.startsWith(sourcePrefix)) {
              throw new Error(
                `Unexpected empty dir path format: "${emptyDir}" doesn't start with prefix "${sourcePrefix}"`,
              );
            }
            const relativeEmptyDir = sourcePrefix ? emptyDir.substring(sourcePrefix.length) : emptyDir;

            allFiles.push({
              path: `${relativeEmptyDir}/.s3keep`,
              size: 0,
              isMarker: true,
            });
          }
        }

        // Log warning about skipped symlinks if any
        if (dirListing.skippedSymlinks.length > 0) {
          logger.warn(
            `Skipped ${dirListing.skippedSymlinks.length} symbolic links in ${
              item.path
            }: ${dirListing.skippedSymlinks.slice(0, 5).join(', ')}${
              dirListing.skippedSymlinks.length > 5 ? '...' : ''
            }`,
          );
        }
      }

      // Add all files from directory
      allFiles.push(...dirListing.files);
    }
  }

  return allFiles;
}

/**
 * Lists all files at the destination path
 * Used for conflict detection
 *
 * @param destination - Destination location configuration
 * @returns Array of file paths (relative to destination.path)
 */
async function listDestinationFiles(destination: ConflictCheckRequest['destination']): Promise<string[]> {
  const { s3Client } = getS3Config();

  let files: string[] = [];

  if (destination.type === 's3') {
    // List all objects at destination path
    let continuationToken: string | undefined;
    // Normalize prefix - ensure it ends with '/' if non-empty, but avoid double slashes
    const prefix = destination.path ? (destination.path.endsWith('/') ? destination.path : `${destination.path}/`) : '';

    do {
      const response = await transferQueue.getMetadataLimiter()(async () => {
        return await s3Client.send(
          new ListObjectsV2Command({
            Bucket: destination.locationId,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
      });

      for (const obj of response.Contents || []) {
        // Remove prefix to get relative path
        const relativePath = obj.Key!.substring(prefix.length);
        if (relativePath) {
          files.push(relativePath);
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
  } else {
    // Local or PVC storage
    const fullPath = await validatePath(destination.locationId, destination.path);

    // Check if destination directory exists
    try {
      const stats = await fs.stat(fullPath);

      if (!stats.isDirectory()) {
        // Destination is a file, not a directory - no conflicts
        return [];
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Destination doesn't exist - no conflicts
        return [];
      }
      throw error;
    }

    // List all files recursively
    const basePath = await validatePath(destination.locationId, '');
    const listing = await listLocalDirectoryRecursive(basePath, destination.path);

    files = listing.files.map((f) => f.path);

    // Remove source.path prefix to get relative paths
    const prefix = destination.path ? `${destination.path}/` : '';
    if (prefix) {
      files = files.map((f) => (f.startsWith(prefix) ? f.substring(prefix.length) : f));
    }
  }

  return files;
}

/**
 * Delete a file from S3 or local storage
 */
async function deleteFile(type: string, locationId: string, filePath: string): Promise<void> {
  if (type === 's3') {
    const { s3Client } = getS3Config();
    const command = new DeleteObjectCommand({
      Bucket: locationId,
      Key: filePath,
    });
    await s3Client.send(command);
  } else if (type === 'local') {
    try {
      const absolutePath = await validatePath(locationId, filePath);
      await fs.unlink(absolutePath);
    } catch (error: any) {
      // Ignore if file doesn't exist or already deleted
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

/**
 * Transfer routes plugin
 */
export default async (fastify: FastifyInstance): Promise<void> => {
  // 🔐 SECURITY: Rate limiting for expensive operations
  const RATE_LIMIT_TRANSFER = 10; // requests per minute
  const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute

  /**
   * Authentication hook - authenticates all requests to /api/transfer/*
   */
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticateUser(request, reply);
  });

  /**
   * Authorization hook - checks locationId access for transfer routes
   * Validates both source and destination locationIds
   */
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return;
    }

    const body = request.body as Partial<TransferRequest & ConflictCheckRequest>;

    // For transfer POST requests, check both source and destination
    const isTransferRoute =
      request.method === 'POST' && request.routeOptions.url === '/' && body.source && body.destination;

    if (isTransferRoute) {
      try {
        // Check source location access
        if (body.source.type === 'local') {
          authorizeLocation(request.user, body.source.locationId);
        }
        // Check destination location access
        if (body.destination.type === 'local') {
          authorizeLocation(request.user, body.destination.locationId);
        }
      } catch (error: any) {
        const resource = `transfer:${body.source.type}:${body.source.locationId} -> ${body.destination.type}:${body.destination.locationId}`;
        auditLog(request.user, 'transfer', resource, 'denied', error.message);
        return reply.code(HttpStatus.FORBIDDEN).send({
          error: 'Forbidden',
          message: error.message,
        });
      }
    }

    // For conflict check requests, check destination
    const isConflictCheckRoute =
      request.method === 'POST' && request.routeOptions.url === '/check-conflicts' && body.destination;

    if (isConflictCheckRoute) {
      try {
        if (body.destination.type === 'local') {
          authorizeLocation(request.user, body.destination.locationId);
        }
      } catch (error: any) {
        const resource = `conflict-check:${body.destination.type}:${body.destination.locationId}`;
        auditLog(request.user, 'conflict-check', resource, 'denied', error.message);
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
      const body = request.body as Partial<TransferRequest & ConflictCheckRequest>;
      let resource = 'transfer:unknown';

      if (body?.source && body?.destination) {
        resource = `transfer:${body.source.type}:${body.source.locationId} -> ${body.destination.type}:${body.destination.locationId}`;
      } else if (body?.destination) {
        resource = `conflict-check:${body.destination.type}:${body.destination.locationId}`;
      }

      const status = reply.statusCode >= 200 && reply.statusCode < 300 ? 'success' : 'failure';
      const action = request.method.toLowerCase();
      auditLog(request.user, action, resource, status);
    }
  });

  /**
   * POST /
   * Initiate cross-storage transfer
   */
  fastify.post<{ Body: TransferRequest }>('/', { schema: transferRequestSchema }, async (request, reply) => {
    // 🔐 SECURITY: Rate limiting for transfer requests (expensive operation)
    const clientIp = request.ip || 'unknown';
    const rateLimitKey = `transfer:${clientIp}`;

    if (checkRateLimit(rateLimitKey, RATE_LIMIT_TRANSFER, RATE_LIMIT_WINDOW_MS)) {
      const retryAfter = getRateLimitResetTime(rateLimitKey);
      return reply.code(HttpStatus.TOO_MANY_REQUESTS).send({
        error: 'RateLimitExceeded',
        message: `Too many transfer requests. Maximum ${RATE_LIMIT_TRANSFER} per minute.`,
        retryAfter,
      });
    }

    const { source, destination, items, conflictResolution } = request.body;

    try {
      // Validate request
      if (!source || !destination || !items || !conflictResolution) {
        return reply.code(HttpStatus.BAD_REQUEST).send({ error: 'Missing required fields' });
      }

      if (items.length === 0) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: 'Bad Request',
          message: 'At least one item (file or directory) must be specified',
        });
      }

      // Expand items (files and directories) to flat file list with sizes
      const allFilesWithSizes = await expandItemsToFiles(items, source, destination, fastify.log);

      // 🔐 SECURITY: Validate that no paths attempt directory traversal
      for (const fileInfo of allFilesWithSizes) {
        // Normalize path and check for traversal attempts
        const normalizedPath = path.normalize(fileInfo.path);
        if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
          return reply.code(HttpStatus.BAD_REQUEST).send({
            error: 'Bad Request',
            message: `Invalid file path detected (path traversal attempt): ${fileInfo.path}`,
          });
        }
      }

      // Check if expansion resulted in no files
      if (allFilesWithSizes.length === 0) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: 'Bad Request',
          message: 'Selected items contain no files to transfer',
        });
      }

      // Create transfer jobs with actual file sizes
      const transferJobs = allFilesWithSizes.map((fileInfo) => ({
        sourcePath: `${source.type}:${source.locationId}/${path.join(source.path, fileInfo.path)}`,
        destinationPath: `${destination.type}:${destination.locationId}/${path.join(destination.path, fileInfo.path)}`,
        size: fileInfo.size, // Now populated with actual file size
        isMarker: fileInfo.isMarker, // Propagate marker flag for .s3keep files
      }));

      // Queue job
      const jobId = transferQueue.queueJob('cross-storage', transferJobs, async (fileJob, onProgress, abortSignal) => {
        await executeTransfer(fileJob, source, destination, conflictResolution, onProgress, abortSignal);
      });

      return reply.code(HttpStatus.OK).send({
        jobId,
        sseUrl: `/transfer/progress/${jobId}`,
        fileCount: transferJobs.length,
        totalSize: allFilesWithSizes.reduce((sum, f) => sum + f.size, 0),
      });
    } catch (error: any) {
      fastify.log.error(sanitizeErrorForLogging(error));
      return reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: error.message || 'Transfer failed' });
    }
  });

  /**
   * GET /progress/:jobId
   * SSE endpoint for real-time progress updates
   *
   * AUTHENTICATION:
   * - One-time ticket via query parameter (?ticket=...)
   *   Request ticket via POST /api/auth/sse-ticket with { resource: jobId, resourceType: 'transfer' }
   *
   * SECURITY:
   * - Tickets are single-use and expire after 60 seconds
   * - Tickets are scoped to specific jobId (cannot be reused for different jobs)
   * - EventSource cannot set custom headers, so authentication is via query parameter
   */
  fastify.get<{ Params: { jobId: string } }>('/progress/:jobId', (request, reply) => {
    const { jobId } = request.params;

    // Set CORS headers for EventSource
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.raw.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    // Set SSE headers
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    const sendEvent = (data: any) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Get initial job state
    const job = transferQueue.getJob(jobId);
    if (!job) {
      sendEvent({ error: 'Job not found' });
      reply.raw.end();
      return;
    }

    // Send initial state
    sendEvent({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      files: job.files.map((f) => ({
        file: f.destinationPath,
        loaded: f.loaded,
        total: f.size,
        status: f.status,
        error: f.error,
      })),
    });

    // Close stream immediately if job is already in terminal state
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      reply.raw.end();
      return;
    }

    // Send keepalive comments every 15 seconds to prevent proxy timeouts
    const keepaliveInterval = setInterval(() => {
      if (!reply.raw.destroyed) {
        reply.raw.write(': keepalive\n\n');
      } else {
        clearInterval(keepaliveInterval);
      }
    }, 15000);

    // Listen for job updates
    const updateListener = (updatedJob: TransferJob) => {
      if (updatedJob.id === jobId) {
        sendEvent({
          jobId: updatedJob.id,
          status: updatedJob.status,
          progress: updatedJob.progress,
          files: updatedJob.files.map((f) => ({
            file: f.destinationPath,
            loaded: f.loaded,
            total: f.size,
            status: f.status,
            error: f.error,
          })),
        });

        // Close stream when job complete
        if (updatedJob.status === 'completed' || updatedJob.status === 'failed' || updatedJob.status === 'cancelled') {
          clearInterval(keepaliveInterval);
          transferQueue.off('job-updated', updateListener);
          reply.raw.end();
        }
      }
    };

    transferQueue.on('job-updated', updateListener);

    // Clean up on connection close
    request.raw.on('close', () => {
      clearInterval(keepaliveInterval);
      transferQueue.off('job-updated', updateListener);
    });
  });

  /**
   * GET /:jobId
   * Get transfer job details
   */
  fastify.get<{ Params: { jobId: string } }>('/:jobId', async (request, reply) => {
    const { jobId } = request.params;

    try {
      const job = transferQueue.getJob(jobId);
      if (!job) {
        return reply.code(HttpStatus.NOT_FOUND).send({ error: 'Job not found' });
      }

      return reply.code(HttpStatus.OK).send({
        jobId: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        files: job.files.map((f) => ({
          sourcePath: f.sourcePath,
          destinationPath: f.destinationPath,
          size: f.size,
          loaded: f.loaded,
          status: f.status,
          error: f.error,
        })),
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
      });
    } catch (error: any) {
      fastify.log.error(sanitizeErrorForLogging(error));
      return reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: error.message || 'Failed to get job details' });
    }
  });

  /**
   * DELETE /:jobId
   * Cancel transfer
   */
  fastify.delete<{ Params: { jobId: string } }>('/:jobId', async (request, reply) => {
    const { jobId } = request.params;

    try {
      const cancelled = transferQueue.cancelJob(jobId);
      return reply.code(HttpStatus.OK).send({ cancelled });
    } catch (error: any) {
      fastify.log.error(sanitizeErrorForLogging(error));
      return reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: error.message || 'Cancel failed' });
    }
  });

  /**
   * POST /:jobId/cleanup
   * Delete all files from a cancelled job
   */
  fastify.post<{ Params: { jobId: string } }>('/:jobId/cleanup', async (request, reply) => {
    const { jobId } = request.params;

    try {
      const job = transferQueue.getJob(jobId);
      if (!job) {
        return reply.code(HttpStatus.NOT_FOUND).send({ error: 'Job not found' });
      }

      if (job.status !== 'cancelled') {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: 'InvalidStatus',
          message: 'Job must be cancelled to cleanup files',
        });
      }

      // Delete all files from this job (both completed and partial)
      const errors: string[] = [];
      for (const file of job.files) {
        try {
          const [type, locationId, filePath] = parseTransferPath(file.destinationPath);
          await deleteFile(type, locationId, filePath);
        } catch (error: any) {
          fastify.log.error(sanitizeErrorForLogging(error), `Failed to delete file ${file.destinationPath}:`);
          errors.push(`${file.destinationPath}: ${error.message}`);
        }
      }

      if (errors.length > 0) {
        return reply.code(HttpStatus.MULTI_STATUS).send({
          message: 'Cleanup completed with errors',
          errors,
        });
      }

      return reply.code(HttpStatus.OK).send({
        message: 'All files cleaned up successfully',
        filesDeleted: job.files.length,
      });
    } catch (error: any) {
      fastify.log.error(sanitizeErrorForLogging(error));
      return reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: error.message || 'Cleanup failed' });
    }
  });

  /**
   * POST /check-conflicts
   * Pre-flight conflict check with smart conflict resolution and large folder warnings
   */
  fastify.post<{ Body: ConflictCheckRequest }>(
    '/check-conflicts',
    { schema: conflictCheckRequestSchema },
    async (request, reply) => {
      const { source, destination, items } = request.body;

      try {
        // Validate request
        if (!source || !destination || !items) {
          return reply.code(HttpStatus.BAD_REQUEST).send({ error: 'Missing required fields' });
        }

        if (items.length === 0) {
          return reply.code(HttpStatus.BAD_REQUEST).send({
            error: 'Bad Request',
            message: 'At least one item (file or directory) must be specified',
          });
        }

        // Expand items to full file list with sizes
        const sourceFiles = await expandItemsToFiles(items, source, destination, fastify.log);

        // List destination files
        const destFiles = await listDestinationFiles(destination);

        // Create set for O(1) lookup
        const destFileSet = new Set(destFiles);

        // Separate conflicting from non-conflicting files
        const conflicts: string[] = [];
        const nonConflicting: string[] = [];

        for (const sourceFile of sourceFiles) {
          // Skip .s3keep markers from conflict detection
          if (sourceFile.path.endsWith('.s3keep')) {
            continue;
          }

          if (destFileSet.has(sourceFile.path)) {
            conflicts.push(sourceFile.path);
          } else {
            nonConflicting.push(sourceFile.path);
          }
        }

        // Calculate totals for warning check
        const totalFileCount = sourceFiles.length;
        const totalSize = sourceFiles.reduce((sum, f) => sum + f.size, 0);

        // Check for large folder warning
        let warning: ConflictCheckResponse['warning'] = undefined;

        if (totalFileCount >= LARGE_FOLDER_FILE_THRESHOLD || totalSize >= LARGE_FOLDER_SIZE_THRESHOLD) {
          warning = {
            type: 'large_folder',
            fileCount: totalFileCount,
            totalSize: totalSize,
            message: `This operation will transfer ${totalFileCount} files (${formatBytes(
              totalSize,
            )}). This may take significant time.`,
          };
        }

        const response: ConflictCheckResponse = {
          conflicts,
          nonConflicting,
          warning,
        };

        return reply.code(HttpStatus.OK).send(response);
      } catch (error: any) {
        fastify.log.error(sanitizeErrorForLogging(error));
        return reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({
          error: 'Internal Server Error',
          message: error.message,
        });
      }
    },
  );
};
