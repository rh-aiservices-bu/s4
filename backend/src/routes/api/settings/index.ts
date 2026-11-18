import { ListBucketsCommand } from '@aws-sdk/client-s3';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { S3Client } from '@aws-sdk/client-s3';
import { NodeJsClient } from '@smithy/types';
import axios, { AxiosRequestConfig } from 'axios';

import {
  updateS3Config,
  getS3Config,
  getHFConfig,
  updateHFConfig,
  getMaxConcurrentTransfers,
  updateMaxConcurrentTransfers,
  getMaxFilesPerPage,
  updateMaxFilesPerPage,
  getProxyConfig,
  updateProxyConfig,
  initializeS3Client,
} from '../../../utils/config';
import { updateTransferQueueConcurrency } from '../../../utils/transferQueue';
import { sanitizeErrorForLogging } from '../../../utils/errorLogging';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { NodeHttpHandler } from '@aws-sdk/node-http-handler';
import { logAccess } from '../../../utils/logAccess';
import {
  updateS3ConfigSchema,
  testS3ConfigSchema,
  updateProxyConfigSchema,
  testProxyConfigSchema,
  updateHFConfigSchema,
  testHFConfigSchema,
  updateConcurrencyConfigSchema,
  updateMaxFilesConfigSchema,
} from '../../../schemas';
import {
  S3ConfigBody,
  TestS3ConfigBody,
  ProxyConfigBody,
  TestProxyConfigBody,
  HFConfigBody,
  ConcurrencyConfigBody,
  MaxFilesConfigBody,
} from '../../../types';
import { handleS3Error, handleError } from '../../../utils/errorHandler';
import { HttpStatus } from '../../../utils/httpStatus';
import { auditLogExtended, AuditEventType } from '../../../utils/auditLog';

// GET /s3 sends this placeholder instead of the stored secret. The settings
// page posts it back unchanged unless the user types a new secret, so treat it
// as "keep the current one".
const REDACTED_SECRET = '***REDACTED***';

const resolveSecretAccessKey = (secretAccessKey: string): string =>
  secretAccessKey === REDACTED_SECRET ? getS3Config().secretAccessKey : secretAccessKey;

export default async (fastify: FastifyInstance): Promise<void> => {
  // Note: Authentication is handled by the global auth hook in app.ts

  // Retrieve S3 settings
  fastify.get('/s3', async (req: FastifyRequest, reply: FastifyReply) => {
    logAccess(req);
    const { accessKeyId, secretAccessKey, region, endpoint, defaultBucket } = getS3Config();
    const settings = {
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey ? REDACTED_SECRET : '',
      region: region,
      endpoint: endpoint,
      defaultBucket: defaultBucket,
    };
    reply.send({ settings });
  });

  // Update S3 settings
  fastify.put<{ Body: S3ConfigBody }>('/s3', { schema: updateS3ConfigSchema }, async (req, reply) => {
    logAccess(req);
    const { accessKeyId, region, endpoint, defaultBucket } = req.body;
    const secretAccessKey = resolveSecretAccessKey(req.body.secretAccessKey);
    try {
      updateS3Config(accessKeyId, secretAccessKey, region, endpoint, defaultBucket);

      // Audit log: S3 config updated
      if (req.user) {
        auditLogExtended({
          user: req.user,
          eventType: AuditEventType.CONFIG_S3_UPDATE,
          action: 'update',
          resource: 'settings/s3',
          status: 'success',
          details: `Endpoint: ${endpoint}, Region: ${region}`,
          clientIp: req.ip || 'unknown',
        });
      }

      reply.send({ message: 'Settings updated successfully' });
    } catch (error) {
      // Audit log: S3 config update failed
      if (req.user) {
        auditLogExtended({
          user: req.user,
          eventType: AuditEventType.CONFIG_S3_UPDATE,
          action: 'update',
          resource: 'settings/s3',
          status: 'failure',
          details: error instanceof Error ? error.message : 'Unknown error',
          clientIp: req.ip || 'unknown',
        });
      }

      await handleS3Error(error, reply);
    }
  });

  // Test S3 connection
  fastify.post<{ Body: TestS3ConfigBody }>('/test-s3', { schema: testS3ConfigSchema }, async (req, reply) => {
    logAccess(req);
    const { accessKeyId, region, endpoint } = req.body;
    const secretAccessKey = resolveSecretAccessKey(req.body.secretAccessKey);
    try {
      const { httpProxy, httpsProxy } = getProxyConfig();
      const s3ClientOptions: any = {
        region: region,
        endpoint: endpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: accessKeyId,
          secretAccessKey: secretAccessKey,
        },
      };

      const agentConfig: {
        httpAgent?: HttpProxyAgent<string>;
        httpsAgent?: HttpsProxyAgent<string>;
      } = {};

      if (httpProxy) {
        try {
          agentConfig.httpAgent = new HttpProxyAgent<string>(httpProxy);
        } catch (e: any) {
          // Log only error message, not full error object which may contain agent config
          req.log.error({ error: e?.message || String(e) }, 'Failed to create HttpProxyAgent');
        }
      }

      if (httpsProxy) {
        try {
          agentConfig.httpsAgent = new HttpsProxyAgent<string>(httpsProxy);
        } catch (e: any) {
          // Log only error message, not full error object which may contain agent config
          req.log.error({ error: e?.message || String(e) }, 'Failed to create HttpsProxyAgent');
        }
      }

      if (agentConfig.httpAgent || agentConfig.httpsAgent) {
        s3ClientOptions.requestHandler = new NodeHttpHandler({
          ...(agentConfig.httpAgent && { httpAgent: agentConfig.httpAgent }),
          ...(agentConfig.httpsAgent && {
            httpsAgent: agentConfig.httpsAgent,
          }),
        });
      }
      const s3ClientTest = new S3Client(s3ClientOptions) as NodeJsClient<S3Client>;
      await s3ClientTest.send(new ListBucketsCommand({}));
      reply.send({ message: 'Connection successful' });
    } catch (error) {
      await handleS3Error(error, reply);
    }
  });

  // Retrieve Hugging Face settings
  fastify.get('/huggingface', async (req: FastifyRequest, reply: FastifyReply) => {
    logAccess(req);
    const hfToken = getHFConfig();
    const settings = {
      hfToken: hfToken,
    };
    reply.send({ settings });
  });

  // Update Hugging Face settings
  fastify.put<{ Body: HFConfigBody }>('/huggingface', { schema: updateHFConfigSchema }, async (req, reply) => {
    logAccess(req);
    const { hfToken } = req.body;
    try {
      updateHFConfig(hfToken);

      // Audit log: HuggingFace config updated
      if (req.user) {
        auditLogExtended({
          user: req.user,
          eventType: AuditEventType.CONFIG_HF_UPDATE,
          action: 'update',
          resource: 'settings/huggingface',
          status: 'success',
          clientIp: req.ip || 'unknown',
        });
      }

      reply.send({ message: 'Settings updated successfully' });
    } catch (error) {
      // Audit log: HuggingFace config update failed
      if (req.user) {
        auditLogExtended({
          user: req.user,
          eventType: AuditEventType.CONFIG_HF_UPDATE,
          action: 'update',
          resource: 'settings/huggingface',
          status: 'failure',
          details: error instanceof Error ? error.message : 'Unknown error',
          clientIp: req.ip || 'unknown',
        });
      }

      await handleError(error, reply, 500, req.log);
    }
  });

  // Test Hugging Face connection
  fastify.post<{ Body: HFConfigBody }>('/test-huggingface', { schema: testHFConfigSchema }, async (req, reply) => {
    logAccess(req);
    const { hfToken } = req.body;
    try {
      const { httpsProxy } = getProxyConfig();
      const axiosOptions: AxiosRequestConfig = {
        headers: {
          Authorization: `Bearer ${hfToken}`,
        },
        proxy: false, // Disable axios default proxy handling
      };

      if (httpsProxy) {
        axiosOptions.httpsAgent = new HttpsProxyAgent(httpsProxy);
      }

      const response = await axios.get('https://huggingface.co/api/whoami-v2?', axiosOptions);
      if (response.status === 200) {
        reply.send({
          message: 'Connection successful',
          accessTokenDisplayName: response.data.auth.accessToken.displayName,
        });
      }
    } catch (error: any) {
      req.log.error(sanitizeErrorForLogging(error), 'HuggingFace connection test failed');
      reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({
        error: error.response?.data?.error || 'Hugging Face API error',
        message: error.response?.data?.error || 'Error testing Hugging Face connection',
      });
    }
  });

  // Retrieve max concurrent transfers
  fastify.get('/max-concurrent-transfers', async (req: FastifyRequest, reply: FastifyReply) => {
    logAccess(req);
    const maxConcurrentTransfers = getMaxConcurrentTransfers();
    reply.send({ maxConcurrentTransfers });
  });

  // Update max concurrent transfers
  fastify.put<{ Body: ConcurrencyConfigBody }>(
    '/max-concurrent-transfers',
    { schema: updateConcurrencyConfigSchema },
    async (req, reply) => {
      logAccess(req);
      const { maxConcurrentTransfers } = req.body;
      try {
        updateMaxConcurrentTransfers(maxConcurrentTransfers);
        // Update the transfer queue concurrency limit immediately
        updateTransferQueueConcurrency(maxConcurrentTransfers);

        // Audit log: concurrency config updated
        if (req.user) {
          auditLogExtended({
            user: req.user,
            eventType: AuditEventType.CONFIG_CONCURRENCY_UPDATE,
            action: 'update',
            resource: 'settings/max-concurrent-transfers',
            status: 'success',
            details: `maxConcurrentTransfers: ${maxConcurrentTransfers}`,
            clientIp: req.ip || 'unknown',
          });
        }

        reply.send({ message: 'Settings updated successfully' });
      } catch (error) {
        await handleError(error, reply, 500, req.log);
      }
    },
  );

  // Retrieve max files per page
  fastify.get('/max-files-per-page', async (req: FastifyRequest, reply: FastifyReply) => {
    logAccess(req);
    const maxFilesPerPage = getMaxFilesPerPage();
    reply.send({ maxFilesPerPage });
  });

  // Update max files per page
  fastify.put<{ Body: MaxFilesConfigBody }>(
    '/max-files-per-page',
    { schema: updateMaxFilesConfigSchema },
    async (req, reply) => {
      logAccess(req);
      const { maxFilesPerPage } = req.body;
      try {
        updateMaxFilesPerPage(maxFilesPerPage);

        // Audit log: max files config updated
        if (req.user) {
          auditLogExtended({
            user: req.user,
            eventType: AuditEventType.CONFIG_MAX_FILES_UPDATE,
            action: 'update',
            resource: 'settings/max-files-per-page',
            status: 'success',
            details: `maxFilesPerPage: ${maxFilesPerPage}`,
            clientIp: req.ip || 'unknown',
          });
        }

        reply.send({ message: 'Settings updated successfully' });
      } catch (error) {
        await handleError(error, reply, 500, req.log);
      }
    },
  );

  // Retrieve proxy settings
  fastify.get('/proxy', async (req: FastifyRequest, reply: FastifyReply) => {
    logAccess(req);
    const { httpProxy, httpsProxy } = getProxyConfig();
    const settings = {
      httpProxy: httpProxy,
      httpsProxy: httpsProxy,
    };
    reply.send({ settings });
  });

  // Update proxy settings
  fastify.put<{ Body: ProxyConfigBody }>('/proxy', { schema: updateProxyConfigSchema }, async (req, reply) => {
    logAccess(req);
    const { httpProxy, httpsProxy } = req.body;
    try {
      updateProxyConfig(httpProxy, httpsProxy);
      // Reinitialize the S3 client to apply new proxy settings
      initializeS3Client();

      // Audit log: proxy config updated
      if (req.user) {
        auditLogExtended({
          user: req.user,
          eventType: AuditEventType.CONFIG_PROXY_UPDATE,
          action: 'update',
          resource: 'settings/proxy',
          status: 'success',
          details: 'Proxy configuration updated',
          clientIp: req.ip || 'unknown',
        });
      }

      reply.send({ message: 'Settings updated successfully' });
    } catch (error) {
      await handleError(error, reply, 500, req.log);
    }
  });

  // Test proxy connection
  fastify.post<{ Body: TestProxyConfigBody }>('/test-proxy', { schema: testProxyConfigSchema }, async (req, reply) => {
    logAccess(req);
    const { httpProxy, httpsProxy, testUrl } = req.body;
    req.log.info(
      {
        httpProxy: httpProxy ? '[REDACTED]' : 'none',
        httpsProxy: httpsProxy ? '[REDACTED]' : 'none',
        testUrlHost: testUrl ? new URL(testUrl).host : 'none',
      },
      'Testing proxy connection',
    );
    let httpAgentInstance;
    let httpsAgentInstance;
    try {
      const url = new URL(testUrl);
      if (url.protocol === 'https:') {
        if (httpsProxy) {
          httpsAgentInstance = new HttpsProxyAgent(httpsProxy);
        }
      } else if (url.protocol === 'http:') {
        if (httpProxy) {
          httpAgentInstance = new HttpProxyAgent(httpProxy);
        }
      }

      const axiosOptions: AxiosRequestConfig = { proxy: false };

      if (httpAgentInstance) {
        axiosOptions.httpAgent = httpAgentInstance;
      }
      if (httpsAgentInstance) {
        axiosOptions.httpsAgent = httpsAgentInstance;
      }

      const response = await axios.get(testUrl, axiosOptions);
      if (response.status >= 200 && response.status < 300) {
        reply.send({ message: 'Connection successful' });
      } else {
        reply.code(response.status).send({
          message: `Connection failed with status: ${response.status}`,
        });
      }
    } catch (error: any) {
      req.log.error(sanitizeErrorForLogging(error), 'Error testing proxy connection');
      const err = error as Error;

      // Check for response field first (more specific)
      if (error && typeof error === 'object' && 'response' in error && error.response) {
        const axiosResponseError = error as any; // Type assertion
        const status = axiosResponseError.response.status;
        const responseMessage = `Connection failed with status: ${status} - ${
          axiosResponseError.response.statusText || ''
        }`;
        reply
          .code(status || 500) // Ensure status is a number, default to 500 if not
          .send({
            error: axiosResponseError.name || 'ProxyTestError',
            message: responseMessage,
          });
        // Check for request field if no response field (less specific)
      } else if (error && typeof error === 'object' && 'request' in error && error.request) {
        const axiosRequestError = error as any; // Type assertion
        reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({
          error: axiosRequestError.name || 'ProxyTestError',
          message: 'No response received from the server.',
        });
        // Fallback generic error
      } else {
        reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({
          error: err.name || 'ProxyTestError',
          message: err.message || 'An unexpected error occurred',
        });
      }
    }
  });
};
