import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  DeleteObjectTaggingCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import axios, { AxiosRequestConfig } from 'axios';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Readable, pipeline, PassThrough } from 'stream';
import { URL } from 'url';
import { promisify } from 'util';
import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import { base64Decode } from '../../../utils/encoding';
import { getHFConfig, getProxyConfig, getS3Config } from '../../../utils/config';
import { logAccess } from '../../../utils/logAccess';
import { validatePath, SecurityError } from '../../../utils/localStorage';
import { logMemory } from '../../../utils/memoryProfiler';
import { transferQueue, TransferFileJob } from '../../../utils/transferQueue';
import { uploadWithCleanup, createProgressTransform } from '../../../utils/streamHelpers';
import { sanitizeErrorForLogging } from '../../../utils/errorLogging';
import {
  validateBucketName,
  validateContinuationToken,
  validateQuery,
  validateAndDecodePrefix,
} from '../../../utils/validation';
import { authenticateUser } from '../../../plugins/auth';
import { auditLog } from '../../../utils/auditLog';
import { checkRateLimit, getRateLimitResetTime } from '../../../utils/rateLimit';
import { sanitizeFileName } from '../../../utils/sanitization';
import { HttpStatus } from '../../../utils/httpStatus';
import { BucketParams, ObjectParams, ObjectPrefixParams, ObjectQueryParams, ObjectTagsBody } from '../../../types';
import { handleS3Error } from '../../../utils/errorHandler';
import { putObjectTagsSchema } from '../../../schemas';

const pipelineAsync = promisify(pipeline);

interface UploadProgress {
  loaded: number;
  status: 'idle' | 'queued' | 'uploading' | 'completed';
  total?: number;
}

interface UploadProgresses {
  [key: string]: UploadProgress;
}

type Sibling = {
  rfilename: string;
};

type Siblings = Sibling[];

const createRef = (initialValue: any) => {
  return {
    current: initialValue,
  };
};

const abortUploadController = createRef(null);

export default async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Authentication hook - authenticates all requests to /api/objects/*
   */
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticateUser(request, reply);
  });

  /**
   * Audit logging hook - logs all requests after completion
   */
  fastify.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user) {
      const params = request.params as Partial<ObjectParams>;
      const bucketName = params.bucketName || 'unknown';
      const encodedKey = params.encodedKey || '';
      const resource = `s3:${bucketName}/${encodedKey ? base64Decode(encodedKey) : ''}`;
      const status = reply.statusCode >= 200 && reply.statusCode < 300 ? 'success' : 'failure';
      const action = request.method.toLowerCase();
      auditLog(request.user, action, resource, status);
    }
  });

  // Server-side listing enhancements configuration
  const DEFAULT_MAX_KEYS = 500; // friendlier cadence for UI
  const MAX_ALLOWED_KEYS = 2000; // hard upper bound

  // 🔐 SECURITY: DoS Prevention - Reduced from 40 to 5
  const MAX_CONTAINS_SCAN_PAGES = 5; // CHANGED FROM 40

  // 🔐 SECURITY: Rate limiting for expensive operations
  const RATE_LIMIT_CONTAINS_SEARCH = 5; // requests per minute
  const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute

  interface FilterMeta {
    q?: string;
    mode?: 'startsWith' | 'contains';
    partialResult?: boolean; // true when search stopped before exhausting bucket
    scanPages?: number; // number of S3 pages scanned (contains or broadened)
    objectsExamined?: number; // total objects examined across all pages
    scanStoppedReason?: 'maxKeysReached' | 'bucketExhausted' | 'scanCap' | 'examinedCap' | 'timeout';
    autoBroaden?: boolean; // true when startsWith broadened to contains
    originalMode?: 'startsWith';
    matches?: {
      objects: Record<string, [number, number][]>;
      prefixes: Record<string, [number, number][]>;
    };
  }

  const normalizeMaxKeys = (raw?: any): number => {
    const n = parseInt(raw, 10);
    if (isNaN(n)) return DEFAULT_MAX_KEYS;
    return Math.min(Math.max(1, n), MAX_ALLOWED_KEYS);
  };

  interface EnhancedResult {
    objects: any[] | undefined;
    prefixes: any[] | undefined;
    nextContinuationToken: string | null;
    isTruncated: boolean;
    filter?: FilterMeta;
  }

  const buildResponse = (reply: FastifyReply, payload: EnhancedResult) => {
    reply.send(payload);
  };

  const applyFilter = (
    Contents: any[] | undefined,
    CommonPrefixes: any[] | undefined,
    qLower: string,
    mode: 'startsWith' | 'contains' = 'contains',
  ) => {
    const matchFn =
      mode === 'startsWith'
        ? (text: string) => text.toLowerCase().startsWith(qLower)
        : (text: string) => text.toLowerCase().includes(qLower);

    const filteredObjects = Contents?.filter((o) => {
      const key: string = o.Key || '';
      const last = key.split('/').pop() || key;
      return matchFn(last);
    });
    const filteredPrefixes = CommonPrefixes?.filter((p) => {
      const pref: string = p.Prefix || '';
      const last = pref.endsWith('/') ? pref.slice(0, -1).split('/').pop() : pref.split('/').pop();
      return matchFn(last || '');
    });
    return { filteredObjects, filteredPrefixes };
  };

  const computeMatchRanges = (leaf: string, qLower: string): [number, number][] => {
    const ranges: [number, number][] = [];
    if (!qLower) return ranges;
    const leafLower = leaf.toLowerCase();
    let idx = 0;
    while (idx <= leafLower.length) {
      const found = leafLower.indexOf(qLower, idx);
      if (found === -1) break;
      ranges.push([found, found + qLower.length]);
      idx = found + 1; // allow overlaps (unlikely needed, but safe)
    }
    return ranges;
  };

  const addMatchMetadata = (
    objects: any[] | undefined,
    prefixes: any[] | undefined,
    qLower: string,
  ): FilterMeta['matches'] => {
    const objMatches: Record<string, [number, number][]> = {};
    const prefMatches: Record<string, [number, number][]> = {};
    if (objects) {
      for (const o of objects) {
        const key: string = o.Key || '';
        const leaf = key.split('/').pop() || key;
        const ranges = computeMatchRanges(leaf, qLower);
        if (ranges.length) objMatches[key] = ranges;
      }
    }
    if (prefixes) {
      for (const p of prefixes) {
        const pref: string = p.Prefix || '';
        const leaf = (pref.endsWith('/') ? pref.slice(0, -1) : pref).split('/').pop() || pref;
        const ranges = computeMatchRanges(leaf, qLower);
        if (ranges.length) prefMatches[pref] = ranges;
      }
    }
    return { objects: objMatches, prefixes: prefMatches };
  };

  const runContainsScan = async (
    s3Client: S3Client,
    bucketName: string,
    decoded_prefix: string | undefined,
    continuationToken: string | undefined,
    qLower: string,
    effectiveMaxKeys: number,
    mode: 'startsWith' | 'contains' = 'contains',
  ) => {
    let nextToken: string | undefined = continuationToken || undefined;
    let aggregatedObjects: any[] = [];
    const aggregatedPrefixes: any[] = [];
    let underlyingTruncated = false;
    let lastUnderlyingToken: string | undefined = undefined;
    let pagesScanned = 0;

    while (pagesScanned < MAX_CONTAINS_SCAN_PAGES) {
      const page = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Delimiter: '/',
          Prefix: decoded_prefix || undefined,
          ContinuationToken: nextToken,
          MaxKeys: DEFAULT_MAX_KEYS,
        }),
      );
      pagesScanned += 1;
      const { filteredObjects, filteredPrefixes } = applyFilter(page.Contents, page.CommonPrefixes, qLower, mode);
      if (filteredObjects) aggregatedObjects.push(...filteredObjects);
      if (filteredPrefixes) aggregatedPrefixes.push(...filteredPrefixes);
      underlyingTruncated = !!page.IsTruncated;
      lastUnderlyingToken = page.NextContinuationToken || undefined;

      if (aggregatedObjects.length >= effectiveMaxKeys) break; // reached collection goal
      if (!underlyingTruncated || !page.NextContinuationToken) break; // exhausted bucket
      nextToken = page.NextContinuationToken;
    }

    if (aggregatedObjects.length > effectiveMaxKeys) {
      aggregatedObjects = aggregatedObjects.slice(0, effectiveMaxKeys);
    }

    let scanStoppedReason: 'maxKeysReached' | 'bucketExhausted' | 'scanCap';
    if (pagesScanned >= MAX_CONTAINS_SCAN_PAGES && underlyingTruncated && aggregatedObjects.length < effectiveMaxKeys) {
      scanStoppedReason = 'scanCap';
    } else if (aggregatedObjects.length >= effectiveMaxKeys) {
      scanStoppedReason = 'maxKeysReached';
    } else {
      scanStoppedReason = 'bucketExhausted';
    }

    const morePossible =
      underlyingTruncated && (aggregatedObjects.length >= effectiveMaxKeys || scanStoppedReason === 'scanCap');
    const responseToken = morePossible ? lastUnderlyingToken || null : null;

    return {
      aggregatedObjects,
      aggregatedPrefixes,
      morePossible,
      responseToken,
      pagesScanned,
      scanStoppedReason,
    };
  };
  const handleListRequest = async (
    req: FastifyRequest<{ Querystring: ObjectQueryParams }>,
    reply: FastifyReply,
    bucketName: string,
    encodedPrefix: string | undefined,
  ) => {
    logAccess(req);
    const { s3Client } = getS3Config();
    const { continuationToken, q, mode, maxKeys, autoBroaden } = req.query;

    // Input validation using secure validation functions
    const bucketError = validateBucketName(bucketName);
    if (bucketError) {
      reply.code(HttpStatus.BAD_REQUEST).send({
        error: 'InvalidBucketName',
        message: bucketError,
      });
      return;
    }

    const tokenError = validateContinuationToken(continuationToken);
    if (tokenError) {
      reply.code(HttpStatus.BAD_REQUEST).send({
        error: 'InvalidContinuationToken',
        message: tokenError,
      });
      return;
    }

    const queryError = validateQuery(q);
    if (queryError) {
      reply.code(HttpStatus.BAD_REQUEST).send({
        error: 'InvalidQuery',
        message: queryError,
      });
      return;
    }

    // Validate and decode prefix
    const { decoded: decoded_prefix, error: prefixError } = validateAndDecodePrefix(encodedPrefix);
    if (prefixError) {
      reply.code(HttpStatus.BAD_REQUEST).send({
        error: 'InvalidPrefix',
        message: prefixError,
      });
      return;
    }

    const effectiveMaxKeys = normalizeMaxKeys(maxKeys);
    const requestedMode: 'startsWith' | 'contains' | undefined = q
      ? mode === 'startsWith'
        ? 'startsWith'
        : 'contains'
      : undefined;

    if (!q) {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Delimiter: '/',
        Prefix: decoded_prefix || undefined,
        ContinuationToken: continuationToken || undefined,
        MaxKeys: effectiveMaxKeys,
      });
      try {
        const { Contents, CommonPrefixes, NextContinuationToken, IsTruncated } = await s3Client.send(command);
        buildResponse(reply, {
          objects: Contents,
          prefixes: CommonPrefixes,
          nextContinuationToken: NextContinuationToken || null,
          isTruncated: !!IsTruncated,
        });
      } catch (error) {
        await handleS3Error(error, reply, req.log);
      }
      return;
    }

    const qLower = (q as string).toLowerCase();

    if (requestedMode === 'startsWith') {
      try {
        const command = new ListObjectsV2Command({
          Bucket: bucketName,
          Delimiter: '/',
          Prefix: decoded_prefix || undefined,
          ContinuationToken: continuationToken || undefined,
          MaxKeys: effectiveMaxKeys,
        });
        const { Contents, CommonPrefixes, NextContinuationToken, IsTruncated } = await s3Client.send(command);
        const { filteredObjects, filteredPrefixes } = applyFilter(Contents, CommonPrefixes, qLower, requestedMode);

        const shouldBroaden =
          autoBroaden === 'true' &&
          (!filteredObjects || filteredObjects.length === 0) &&
          (!filteredPrefixes || filteredPrefixes.length === 0);
        if (shouldBroaden) {
          const scan = await runContainsScan(
            s3Client,
            bucketName,
            decoded_prefix,
            continuationToken,
            qLower,
            effectiveMaxKeys,
            requestedMode,
          );
          const matches = addMatchMetadata(scan.aggregatedObjects, scan.aggregatedPrefixes, qLower);
          buildResponse(reply, {
            objects: scan.aggregatedObjects,
            prefixes: scan.aggregatedPrefixes,
            nextContinuationToken: scan.responseToken,
            isTruncated: scan.morePossible,
            filter: {
              q,
              mode: 'contains',
              originalMode: 'startsWith',
              autoBroaden: true,
              partialResult: scan.morePossible,
              scanPages: scan.pagesScanned,
              scanStoppedReason: scan.scanStoppedReason,
              matches,
            },
          });
          return;
        }

        const matches = addMatchMetadata(filteredObjects, filteredPrefixes, qLower);
        buildResponse(reply, {
          objects: filteredObjects,
          prefixes: filteredPrefixes,
          nextContinuationToken: NextContinuationToken || null,
          isTruncated: !!IsTruncated,
          filter: { q, mode: 'startsWith', partialResult: false, matches },
        });
      } catch (error) {
        await handleS3Error(error, reply, req.log);
      }
      return;
    }

    // 🔐 SECURITY: Rate limiting for contains searches (expensive operation)
    const clientIp = req.ip || 'unknown';
    const rateLimitKey = `contains-search:${clientIp}`;

    if (checkRateLimit(rateLimitKey, RATE_LIMIT_CONTAINS_SEARCH, RATE_LIMIT_WINDOW_MS)) {
      const retryAfter = getRateLimitResetTime(rateLimitKey);
      reply.code(HttpStatus.TOO_MANY_REQUESTS).send({
        error: 'RateLimitExceeded',
        message: `Too many search requests. Maximum ${RATE_LIMIT_CONTAINS_SEARCH} per minute.`,
        retryAfter,
      });
      return;
    }

    try {
      const scan = await runContainsScan(
        s3Client,
        bucketName,
        decoded_prefix,
        continuationToken,
        qLower,
        effectiveMaxKeys,
        requestedMode || 'contains',
      );
      const matches = addMatchMetadata(scan.aggregatedObjects, scan.aggregatedPrefixes, qLower);
      buildResponse(reply, {
        objects: scan.aggregatedObjects,
        prefixes: scan.aggregatedPrefixes,
        nextContinuationToken: scan.responseToken,
        isTruncated: scan.morePossible,
        filter: {
          q,
          mode: 'contains',
          partialResult: scan.morePossible,
          scanPages: scan.pagesScanned,
          scanStoppedReason: scan.scanStoppedReason,
          matches,
        },
      });
    } catch (error) {
      await handleS3Error(error, reply, req.log);
    }
  };

  // List objects routes
  // Note: bucketName does NOT need decodeURIComponent - it's validated to URL-safe [a-z0-9-]
  // (see validateBucketName in utils/validation.ts). Fastify auto-decodes URL params anyway.
  // Prefix IS base64-encoded and is decoded within handleListRequest via validateAndDecodePrefix.
  fastify.get<{ Params: BucketParams; Querystring: ObjectQueryParams }>('/:bucketName', async (req, reply) => {
    const { bucketName } = req.params;
    await handleListRequest(req, reply, bucketName, undefined);
  });

  fastify.get<{ Params: ObjectPrefixParams; Querystring: ObjectQueryParams }>(
    '/:bucketName/:prefix',
    async (req, reply) => {
      const { bucketName, prefix } = req.params;
      await handleListRequest(req, reply, bucketName, prefix);
    },
  );

  // Get an object to view it in the client
  fastify.get<{ Params: ObjectParams }>('/view/:bucketName/:encodedKey', async (req, reply) => {
    logAccess(req);
    const { s3Client } = getS3Config();
    const { bucketName, encodedKey } = req.params;
    const key = base64Decode(encodedKey);

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    try {
      const item = await s3Client.send(command);
      return item.Body;
    } catch (error) {
      await handleS3Error(error, reply, req.log);
      return reply;
    }
  });

  // Download an object, streaming it to the client
  fastify.get<{ Params: ObjectParams }>('/download/:bucketName/:encodedKey', async (req, reply) => {
    logAccess(req);
    const { s3Client } = getS3Config();
    const { bucketName, encodedKey } = req.params;
    const key = base64Decode(encodedKey);
    const fileName = key.split('/').pop();

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    try {
      const item = await s3Client.send(command);

      const s3Stream = item.Body as Readable;

      // Set the appropriate headers for the response
      reply.header('Content-Disposition', `attachment; filename="${sanitizeFileName(fileName)}"`);
      reply.header('Access-Control-Expose-Headers', 'Content-Disposition');
      reply.header('Content-Type', 'application/octet-stream');

      // Pipe the S3 stream to the response
      reply.raw.on('close', () => {
        s3Stream.destroy();
      });

      reply.send(s3Stream);

      return reply;
    } catch (error) {
      await handleS3Error(error, reply, req.log);
      return reply;
    }
  });

  // Delete an object or objects with given prefix (folder) from the bucket
  fastify.delete<{ Params: ObjectParams }>('/:bucketName/:encodedKey', async (req, reply) => {
    logAccess(req);
    const { s3Client } = getS3Config();
    const { bucketName, encodedKey } = req.params;
    const objectName = base64Decode(encodedKey); // This can also be the prefix

    try {
      // Collect all objects to delete with pagination support
      const objectsToDelete: { Key: string }[] = [];
      let continuationToken: string | undefined;

      // Paginate through all objects with the given prefix
      do {
        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: objectName,
          ContinuationToken: continuationToken,
          MaxKeys: 1000, // S3 maximum per request
        });

        const listResponse = await s3Client.send(listCommand);

        if (listResponse.Contents && listResponse.Contents.length > 0) {
          objectsToDelete.push(...listResponse.Contents.map((item: any) => ({ Key: item.Key })));
        }

        continuationToken = listResponse.NextContinuationToken;
      } while (continuationToken);

      // If no objects found, try deleting as a single object
      if (objectsToDelete.length === 0) {
        const deleteCommand = new DeleteObjectCommand({
          Bucket: bucketName,
          Key: objectName,
        });
        await s3Client.send(deleteCommand);
        reply.send({ message: 'Object deleted successfully' });
        return;
      }

      // Delete objects in batches of 1000 (S3 limit for bulk delete)
      const batchSize = 1000;
      let totalDeleted = 0;

      for (let i = 0; i < objectsToDelete.length; i += batchSize) {
        const batch = objectsToDelete.slice(i, i + batchSize);

        const deleteCommand = new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: batch,
            Quiet: true, // Don't return deleted object details (reduces response size)
          },
        });

        const deleteResponse = await s3Client.send(deleteCommand);
        totalDeleted += batch.length;

        // Log any errors (even in Quiet mode, errors are still returned)
        if (deleteResponse.Errors && deleteResponse.Errors.length > 0) {
          req.log.error({ batch: i / batchSize + 1, errors: deleteResponse.Errors }, 'Delete batch had errors');
        }
      }

      reply.send({
        message: `Successfully deleted ${totalDeleted} object(s)`,
        count: totalDeleted,
      });
    } catch (error) {
      await handleS3Error(error, reply, req.log);
    }
  });

  // Progress tracking for uploads
  const uploadProgresses: UploadProgresses = {};

  /**
   * GET /upload-progress/:encodedKey
   * SSE endpoint for real-time upload progress updates
   *
   * AUTHENTICATION:
   * - One-time ticket via query parameter (?ticket=...)
   *   Request ticket via POST /api/auth/sse-ticket with { resource: encodedKey, resourceType: 'upload' }
   *
   * SECURITY:
   * - Tickets are single-use and expire after 60 seconds
   * - Tickets are scoped to specific encodedKey (cannot be reused for different uploads)
   * - EventSource cannot set custom headers, so authentication is via query parameter
   */
  fastify.get<{ Params: { encodedKey: string } }>('/upload-progress/:encodedKey', (req, reply) => {
    const { encodedKey } = req.params;

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

    const interval = setInterval(() => {
      if (uploadProgresses[encodedKey]) {
        sendEvent({
          loaded: uploadProgresses[encodedKey].loaded,
          status: uploadProgresses[encodedKey].status,
        });
        if (uploadProgresses[encodedKey].status === 'completed') {
          req.log.info({ key: encodedKey }, 'Upload completed');
          clearInterval(interval);
          delete uploadProgresses[encodedKey];
          reply.raw.end();
        }
      }
    }, 1000);

    // Handle client disconnect
    req.raw.on('close', () => {
      delete uploadProgresses[encodedKey];
      clearInterval(interval);
    });
  });

  // Abort an ongoing upload
  fastify.get<{ Params: { encodedKey: string } }>('/abort-upload/:encodedKey', (req, reply) => {
    const { encodedKey } = req.params;
    if (abortUploadController.current) {
      (abortUploadController.current as AbortController).abort();
      delete uploadProgresses[encodedKey];
      reply.send({ message: 'Upload aborted' });
    } else {
      reply.send({ message: 'No upload to abort' });
    }
  });

  // Upload an object to a bucket
  fastify.post<{ Params: ObjectParams }>('/upload/:bucketName/:encodedKey', async (req, reply) => {
    logAccess(req);
    const { bucketName, encodedKey } = req.params;
    const { s3Client } = getS3Config();
    const key = base64Decode(encodedKey);

    const data = await req.file({
      limits: {
        fileSize: 10 * 1024 * 1024 * 1024, // 10Gb limit
      },
    });

    if (!data) {
      reply.status(400).send({
        error: 'File not found',
        message: 'File not found in request',
      });
      req.log.warn('File not found in request');
      return;
    }

    const fileStream = data.file;

    abortUploadController.current = new AbortController();

    uploadProgresses[encodedKey] = { loaded: 0, status: 'uploading' };

    const target = {
      Bucket: bucketName,
      Key: key,
      Body: fileStream,
    };

    try {
      const upload = new Upload({
        client: s3Client,
        queueSize: 4, // optional concurrency configuration
        leavePartsOnError: false, // optional manually handle dropped parts
        params: target,
        abortController: abortUploadController.current as AbortController,
      });

      // Throttled progress tracking to prevent memory leaks
      const PROGRESS_THRESHOLD = 1024 * 1024; // 1MB
      let lastReported = 0;

      const throttledProgress = (loaded: number) => {
        // Only update progress every 1MB
        if (loaded - lastReported >= PROGRESS_THRESHOLD) {
          uploadProgresses[encodedKey] = { loaded, status: 'uploading' };
          lastReported = loaded;
        }
      };

      // Use uploadWithCleanup to ensure event listeners are removed
      await uploadWithCleanup(upload, throttledProgress);
      uploadProgresses[encodedKey] = { loaded: 0, status: 'completed' };
      abortUploadController.current = null;
      reply.send({ message: 'Object uploaded successfully' });
    } catch (e: any) {
      req.log.error({ error: sanitizeErrorForLogging(e) }, 'Upload failed');
      abortUploadController.current = null;
      delete uploadProgresses[encodedKey];
      if (e.name === 'AbortError') {
        await reply.code(HttpStatus.CLIENT_CLOSED_REQUEST).send({
          error: e.name || 'AbortError',
          message: e.message || 'Upload aborted by client',
        });
      } else {
        await handleS3Error(e, reply, req.log);
      }
    }
  });

  // NOTE: Old HuggingFace import implementation removed to fix memory leaks
  // Use POST /huggingface-import with transferQueue instead

  // Interface for HuggingFace import request
  interface HuggingFaceImportRequest {
    destinationType?: 's3' | 'local'; // Optional for backward compatibility, defaults to 's3'
    localLocationId?: string; // Required if destinationType === 'local'
    localPath?: string; // Required if destinationType === 'local'
    bucketName?: string; // Required if destinationType === 's3'
    modelId: string;
    hfToken?: string;
    prefix?: string;
  }

  // Helper function to download a HuggingFace file to S3 or local storage
  async function downloadHuggingFaceFile(
    fileJob: TransferFileJob,
    destinationType: 's3' | 'local',
    hfToken: string | undefined,
    onProgress: (loaded: number) => void,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const { sourcePath, destinationPath } = fileJob;

    // Memory profiling: Start of HF download
    const fileName = path.basename(sourcePath);
    logMemory(`[HF] Start download: ${fileName}`);

    // Parse destination path
    // Format: "s3:bucketName/path" or "local:locationId/path"
    const colonIndex = destinationPath.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`Invalid destination path format: ${destinationPath}`);
    }

    const destRemainder = destinationPath.substring(colonIndex + 1);
    const firstSlash = destRemainder.indexOf('/');
    if (firstSlash === -1) {
      throw new Error(`Invalid destination path format: ${destinationPath}`);
    }

    const destLoc = destRemainder.substring(0, firstSlash);
    const destPath = destRemainder.substring(firstSlash + 1);

    // Fetch from HuggingFace with native https module (zero buffering)
    const { httpProxy, httpsProxy } = getProxyConfig();

    // Recursive function to follow redirects
    const makeRequest = (
      currentUrl: string,
      redirectCount = 0,
    ): Promise<{ stream: Readable; contentLength: number }> => {
      // Prevent infinite redirect loops
      if (redirectCount > 10) {
        return Promise.reject(new Error('Too many redirects (max 10)'));
      }

      const url = new URL(currentUrl);

      // Prepare request options
      const requestOptions: any = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: hfToken ? { Authorization: `Bearer ${hfToken}` } : {},
        signal: abortSignal, // Add abort signal to cancel HTTP request
      };

      // Add proxy agent if configured
      if (url.protocol === 'https:' && httpsProxy) {
        requestOptions.agent = new HttpsProxyAgent(httpsProxy);
      } else if (url.protocol === 'http:' && httpProxy) {
        requestOptions.agent = new HttpProxyAgent(httpProxy);
      }

      return new Promise<{ stream: Readable; contentLength: number }>((resolve, reject) => {
        const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(requestOptions, (res) => {
          const statusCode = res.statusCode || 0;

          // Handle redirects (301, 302, 307, 308)
          if (statusCode >= 300 && statusCode < 400) {
            const location = res.headers.location;
            if (!location) {
              reject(new Error(`Redirect response missing Location header (${statusCode})`));
              return;
            }

            // Consume redirect response body to free memory
            res.resume();

            // Resolve relative URLs against current URL (e.g., '/api/cache/file')
            const redirectUrl = new URL(location, currentUrl);

            // Follow redirect recursively
            makeRequest(redirectUrl.href, redirectCount + 1)
              .then(resolve)
              .catch(reject);
            return;
          }

          // Handle success (200)
          if (statusCode === 200) {
            const contentLength = parseInt(res.headers['content-length'] || '0', 10);
            resolve({ stream: res, contentLength });
            return;
          }

          // Handle errors (non-200, non-redirect)
          reject(new Error(`HTTP request failed: ${statusCode} ${res.statusMessage || 'Unknown error'}`));
        });

        req.on('error', reject);
        req.end();
      });
    };

    // Make initial request (will follow redirects automatically)
    const { stream, contentLength } = await makeRequest(sourcePath);

    fileJob.size = contentLength;

    // Memory profiling: HTTP response received
    const sizeInMB = (contentLength / (1024 * 1024)).toFixed(2);
    logMemory(`[HF] Response received: ${fileName} (${sizeInMB} MB)`);

    // Track progress with throttling to prevent memory leaks
    const progressTransform = createProgressTransform(onProgress);

    // Add abort handling to progress transform
    if (abortSignal) {
      const abortHandler = () => {
        progressTransform.destroy(new Error('Transfer cancelled'));
      };
      abortSignal.addEventListener('abort', abortHandler);
      progressTransform.on('close', () => {
        abortSignal.removeEventListener('abort', abortHandler);
      });
    }

    // Memory profiling: Before pipeline setup
    logMemory(`[HF] Before pipeline: ${fileName}`);

    try {
      // Write to destination
      if (destinationType === 's3') {
        // Upload to S3
        const { s3Client } = getS3Config();

        // Use PassThrough stream to combine axios stream with progress tracking
        // while maintaining backpressure control
        const passThrough = new PassThrough({
          highWaterMark: 64 * 1024, // 64KB chunks - prevents excessive buffering
        });

        // Pipeline with native backpressure: http → progress → passthrough
        const pipelinePromise = pipelineAsync(stream, progressTransform, passThrough);

        // Upload reads from passthrough with proper backpressure
        const upload = new Upload({
          client: s3Client,
          params: {
            Bucket: destLoc,
            Key: destPath,
            Body: passThrough,
          },
        });

        // Wait for both to complete
        await Promise.all([upload.done(), pipelinePromise]);

        // Memory profiling: S3 upload complete
        logMemory(`[HF] S3 upload complete: ${fileName}`);
      } else {
        // Write to local storage
        // First, ensure parent directory structure exists
        const parentRelativePath = path.dirname(destPath);

        // Get validated base path
        const basePath = await validatePath(destLoc, '.');

        // Construct parent absolute path
        const normalizedParent = path.normalize(parentRelativePath || '.');
        const parentAbsolutePath = path.join(basePath, normalizedParent);

        // Security check: ensure parent doesn't escape base
        if (!parentAbsolutePath.startsWith(basePath + path.sep) && parentAbsolutePath !== basePath) {
          throw new SecurityError(`Path escapes allowed directory: ${parentRelativePath}`);
        }

        // Create directory structure recursively
        await fs.mkdir(parentAbsolutePath, { recursive: true });

        // Now validate the full file path (will succeed because parent exists)
        const absolutePath = await validatePath(destLoc, destPath);

        // Stream to file with native backpressure
        await pipelineAsync(stream, progressTransform, createWriteStream(absolutePath));

        // Memory profiling: Local file write complete
        logMemory(`[HF] Local write complete: ${fileName}`);
      }
    } catch (error) {
      // Memory profiling: Error occurred
      logMemory(`[HF] Error during transfer: ${fileName}`);

      // Critical: Destroy streams on error to prevent memory leaks
      stream.destroy();
      progressTransform.destroy();
      throw error;
    }
  }

  // New POST route for HuggingFace import with local storage support
  fastify.post<{ Body: HuggingFaceImportRequest }>(
    '/huggingface-import',
    async (req: FastifyRequest, reply: FastifyReply) => {
      logAccess(req);
      const body = req.body as HuggingFaceImportRequest;
      const {
        destinationType = 's3', // Default to 's3' for backward compatibility
        localLocationId,
        localPath,
        bucketName,
        modelId,
        hfToken: requestHfToken,
        prefix,
      } = body;

      // Use HF token from request or fall back to configured token
      const hfToken = requestHfToken || getHFConfig();

      // Validate destination parameters
      if (destinationType === 's3' && !bucketName) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: 'ValidationError',
          message: 'bucketName is required for S3 destination',
        });
      }

      if (destinationType === 'local') {
        if (!localLocationId || localPath === undefined) {
          return reply.code(HttpStatus.BAD_REQUEST).send({
            error: 'ValidationError',
            message: 'localLocationId and localPath are required for local destination',
          });
        }

        // Validate local path
        try {
          await validatePath(localLocationId, localPath);
        } catch (error: any) {
          return reply.code(HttpStatus.BAD_REQUEST).send({
            error: 'ValidationError',
            message: `Invalid local storage path: ${error.message}`,
          });
        }
      }

      // Fetch model info from HuggingFace
      let modelInfo: any;
      try {
        const { httpProxy, httpsProxy } = getProxyConfig();
        const modelInfoUrl = 'https://huggingface.co/api/models/' + modelId;
        const axiosOptions: AxiosRequestConfig = {
          headers: hfToken ? { Authorization: `Bearer ${hfToken}` } : {},
        };

        if (modelInfoUrl.startsWith('https://') && httpsProxy) {
          axiosOptions.httpsAgent = new HttpsProxyAgent(httpsProxy);
          axiosOptions.proxy = false;
        } else if (modelInfoUrl.startsWith('http://') && httpProxy) {
          axiosOptions.httpAgent = new HttpProxyAgent(httpProxy);
          axiosOptions.proxy = false;
        }

        modelInfo = await axios.get(modelInfoUrl, axiosOptions);
      } catch (error: any) {
        return reply.code(error.response?.status || 500).send({
          error: error.response?.data?.error || 'HuggingFace API error',
          message: error.response?.data?.error || 'Error fetching model info from HuggingFace',
        });
      }

      // Check if model is gated and user is authorized
      const modelGated = modelInfo.data.gated;
      if (modelGated !== false && hfToken) {
        try {
          const { httpProxy, httpsProxy } = getProxyConfig();
          const whoAmIUrl = 'https://huggingface.co/api/whoami-v2';
          const axiosOptions: AxiosRequestConfig = {
            headers: { Authorization: `Bearer ${hfToken}` },
          };

          if (whoAmIUrl.startsWith('https://') && httpsProxy) {
            axiosOptions.httpsAgent = new HttpsProxyAgent(httpsProxy);
            axiosOptions.proxy = false;
          } else if (whoAmIUrl.startsWith('http://') && httpProxy) {
            axiosOptions.httpAgent = new HttpProxyAgent(httpProxy);
            axiosOptions.proxy = false;
          }

          await axios.get(whoAmIUrl, axiosOptions);
        } catch (_error) {
          return reply.code(HttpStatus.UNAUTHORIZED).send({
            error: 'Unauthorized',
            message: 'This model requires a valid HuggingFace token to be downloaded, or you are not authorized.',
          });
        }
      } else if (modelGated !== false && !hfToken) {
        return reply.code(HttpStatus.UNAUTHORIZED).send({
          error: 'Unauthorized',
          message: 'This model is gated and requires a HuggingFace token.',
        });
      }

      // Get model files
      const modelFiles: Siblings = modelInfo.data.siblings;

      // Create transfer jobs
      const files = modelFiles.map((file) => {
        const fileUrl = `https://huggingface.co/${modelId}/resolve/main/${file.rfilename}`;

        // Normalize paths to remove trailing slashes to avoid double-slash issues
        const normalizedPrefix = prefix ? prefix.replace(/\/$/, '') : '';
        const normalizedLocalPath = localPath ? localPath.replace(/\/$/, '') : '';

        const destinationPath =
          destinationType === 's3'
            ? `s3:${bucketName}/${normalizedPrefix ? `${normalizedPrefix}/` : ''}${modelId}/${file.rfilename}`
            : `local:${localLocationId}/${
                normalizedLocalPath ? `${normalizedLocalPath}/` : ''
              }${modelId}/${file.rfilename}`;

        return {
          sourcePath: fileUrl,
          destinationPath,
          size: 0, // Will be tracked during transfer
        };
      });

      // Queue transfer job
      const jobId = transferQueue.queueJob('huggingface', files, async (fileJob, onProgress, abortSignal) => {
        await downloadHuggingFaceFile(fileJob, destinationType, hfToken, onProgress, abortSignal);
      });

      // Return job ID and SSE URL
      // SSE endpoint is at /api/transfer/progress/:jobId
      // Return relative path (frontend prepends backend_api_url which includes /api)
      return reply.send({
        message: 'Model import started',
        jobId,
        sseUrl: `/transfer/progress/${jobId}`,
      });
    },
  );

  // NOTE: Old GET /hf-import and /import-model-progress routes removed to fix memory leaks
  // Use POST /huggingface-import with /transfer/progress/:jobId instead

  // ========== Object Metadata Endpoints ==========

  /**
   * GET /metadata/:bucketName/:encodedKey
   * Returns object metadata (size, last modified, content type, etag, etc.)
   */
  fastify.get<{ Params: ObjectParams }>('/metadata/:bucketName/:encodedKey', async (req, reply) => {
    logAccess(req);
    const { s3Client } = getS3Config();
    const { bucketName, encodedKey } = req.params;
    const key = base64Decode(encodedKey);

    try {
      const command = new HeadObjectCommand({
        Bucket: bucketName,
        Key: key,
      });

      const response = await s3Client.send(command);

      reply.send({
        key,
        size: response.ContentLength || 0,
        lastModified: response.LastModified?.toISOString() || null,
        etag: response.ETag || null,
        contentType: response.ContentType || 'application/octet-stream',
        metadata: response.Metadata || {},
        storageClass: response.StorageClass || 'STANDARD',
      });
    } catch (error) {
      await handleS3Error(error, reply, req.log);
    }
  });

  /**
   * GET /tags/:bucketName/:encodedKey
   * Returns object tags
   */
  fastify.get<{ Params: ObjectParams }>('/tags/:bucketName/:encodedKey', async (req, reply) => {
    logAccess(req);
    const { s3Client } = getS3Config();
    const { bucketName, encodedKey } = req.params;
    const key = base64Decode(encodedKey);

    try {
      const command = new GetObjectTaggingCommand({
        Bucket: bucketName,
        Key: key,
      });

      const response = await s3Client.send(command);

      reply.send({
        tags: response.TagSet || [],
      });
    } catch (error) {
      await handleS3Error(error, reply, req.log);
    }
  });

  /**
   * PUT /tags/:bucketName/:encodedKey
   * Sets object tags (replaces all existing tags)
   */
  fastify.put<{ Params: ObjectParams; Body: ObjectTagsBody }>(
    '/tags/:bucketName/:encodedKey',
    { schema: putObjectTagsSchema },
    async (req, reply) => {
      logAccess(req);
      const { s3Client } = getS3Config();
      const { bucketName, encodedKey } = req.params;
      const key = base64Decode(encodedKey);
      const { tags } = req.body;

      try {
        const command = new PutObjectTaggingCommand({
          Bucket: bucketName,
          Key: key,
          Tagging: {
            TagSet: tags,
          },
        });

        await s3Client.send(command);

        reply.send({
          message: 'Tags updated successfully',
          tags,
        });
      } catch (error) {
        await handleS3Error(error, reply, req.log);
      }
    },
  );

  /**
   * DELETE /tags/:bucketName/:encodedKey
   * Removes all tags from an object
   */
  fastify.delete<{ Params: ObjectParams }>('/tags/:bucketName/:encodedKey', async (req, reply) => {
    logAccess(req);
    const { s3Client } = getS3Config();
    const { bucketName, encodedKey } = req.params;
    const key = base64Decode(encodedKey);

    try {
      const command = new DeleteObjectTaggingCommand({
        Bucket: bucketName,
        Key: key,
      });

      await s3Client.send(command);

      reply.send({
        message: 'Tags deleted successfully',
      });
    } catch (error) {
      await handleS3Error(error, reply, req.log);
    }
  });
};
