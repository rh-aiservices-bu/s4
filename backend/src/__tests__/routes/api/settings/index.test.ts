import { FastifyInstance } from 'fastify';
import { S3Client, ListBucketsCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import axios from 'axios';
import settingsRoutes from '../../../../routes/api/settings';
import * as configUtils from '../../../../utils/config';

// Mock config utilities
jest.mock('../../../../utils/config', () => ({
  getS3Config: jest.fn(),
  updateS3Config: jest.fn(),
  getHFConfig: jest.fn(),
  updateHFConfig: jest.fn(),
  getMaxConcurrentTransfers: jest.fn().mockReturnValue(2),
  updateMaxConcurrentTransfers: jest.fn(),
  getMaxFilesPerPage: jest.fn().mockReturnValue(100),
  updateMaxFilesPerPage: jest.fn(),
  getProxyConfig: jest.fn(),
  updateProxyConfig: jest.fn(),
  initializeS3Client: jest.fn(), // Mock S3 client initialization
}));

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock logAccess
jest.mock('../../../../utils/logAccess', () => ({
  logAccess: jest.fn(),
}));

// Mock transferQueue
jest.mock('../../../../utils/transferQueue', () => ({
  updateTransferQueueConcurrency: jest.fn(),
}));

describe('Settings Routes', () => {
  let fastify: FastifyInstance;
  const s3Mock = mockClient(S3Client);

  beforeEach(() => {
    s3Mock.reset();
    jest.clearAllMocks(); // Clear all mocks, including those from configUtils and axios

    // Default mock implementations for config getters
    (configUtils.getS3Config as jest.Mock).mockReturnValue({
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      defaultBucket: 'test-default-bucket',
    });
    (configUtils.getHFConfig as jest.Mock).mockReturnValue('test-hf-token');
    (configUtils.getMaxConcurrentTransfers as jest.Mock).mockReturnValue(5);
    (configUtils.getProxyConfig as jest.Mock).mockReturnValue({
      httpProxy: '',
      httpsProxy: '',
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Fastify = require('fastify');
    fastify = Fastify();
    fastify.register(settingsRoutes);
  });

  // S3 Settings Tests
  describe('S3 Settings', () => {
    // GET /s3
    describe('GET /s3', () => {
      it('should retrieve S3 settings successfully', async () => {
        const response = await fastify.inject({ method: 'GET', url: '/s3' });
        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.payload);
        // secretAccessKey is redacted for security
        expect(payload.settings).toEqual({
          accessKeyId: 'test-access-key',
          secretAccessKey: '***REDACTED***',
          region: 'us-east-1',
          endpoint: 'https://s3.us-east-1.amazonaws.com',
          defaultBucket: 'test-default-bucket',
        });
      });
    });

    // PUT /s3
    describe('PUT /s3', () => {
      it('should update S3 settings successfully', async () => {
        const newSettings = {
          accessKeyId: 'new-key',
          secretAccessKey: 'new-secret',
          region: 'us-west-2',
          endpoint: 'https://s3.us-west-2.amazonaws.com',
          defaultBucket: 'new-default-bucket',
        };
        const response = await fastify.inject({
          method: 'PUT',
          url: '/s3',
          payload: newSettings,
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({
          message: 'Settings updated successfully',
        });
        expect(configUtils.updateS3Config).toHaveBeenCalledWith(
          newSettings.accessKeyId,
          newSettings.secretAccessKey,
          newSettings.region,
          newSettings.endpoint,
          newSettings.defaultBucket,
        );
      });

      it('should keep the stored secret when the redacted placeholder is sent back', async () => {
        const response = await fastify.inject({
          method: 'PUT',
          url: '/s3',
          payload: {
            accessKeyId: 'test-access-key',
            secretAccessKey: '***REDACTED***',
            region: 'us-west-2',
            endpoint: 'https://s3.us-east-1.amazonaws.com',
            defaultBucket: 'test-default-bucket',
          },
        });
        expect(response.statusCode).toBe(200);
        expect(configUtils.updateS3Config).toHaveBeenCalledWith(
          'test-access-key',
          'test-secret-key',
          'us-west-2',
          'https://s3.us-east-1.amazonaws.com',
          'test-default-bucket',
        );
      });

      it('should handle errors when updating S3 settings', async () => {
        (configUtils.updateS3Config as jest.Mock).mockImplementationOnce(() => {
          throw new Error('Update failed');
        });
        // Must provide all required fields to pass schema validation
        const response = await fastify.inject({
          method: 'PUT',
          url: '/s3',
          payload: {
            accessKeyId: 'any',
            secretAccessKey: 'secret',
            region: 'us-east-1',
            endpoint: 'https://s3.amazonaws.com',
            defaultBucket: 'bucket',
          },
        });
        expect(response.statusCode).toBe(500);
        const payload = JSON.parse(response.payload);
        expect(payload.error).toBe('Error');
        expect(payload.message).toBe('Update failed');
      });
    });

    // POST /test-s3
    describe('POST /test-s3', () => {
      it('should test S3 connection successfully', async () => {
        s3Mock.on(ListBucketsCommand).resolves({}); // Mock S3 command success
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-s3',
          payload: {
            accessKeyId: 'test-key',
            secretAccessKey: 'test-secret',
            region: 'us-east-1',
            endpoint: 'https://s3.us-east-1.amazonaws.com',
          },
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({
          message: 'Connection successful',
        });
      });

      it('should use the stored secret when the redacted placeholder is sent back', async () => {
        s3Mock.on(ListBucketsCommand).resolves({});
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-s3',
          payload: {
            accessKeyId: 'test-access-key',
            secretAccessKey: '***REDACTED***',
            region: 'us-east-1',
            endpoint: 'https://s3.us-east-1.amazonaws.com',
          },
        });
        expect(response.statusCode).toBe(200);
        const client = s3Mock.call(0).thisValue as S3Client;
        const credentials = await client.config.credentials();
        expect(credentials.secretAccessKey).toBe('test-secret-key');
      });

      it('should use a newly typed secret as is', async () => {
        s3Mock.on(ListBucketsCommand).resolves({});
        await fastify.inject({
          method: 'POST',
          url: '/test-s3',
          payload: {
            accessKeyId: 'test-access-key',
            secretAccessKey: 'typed-secret',
            region: 'us-east-1',
            endpoint: 'https://s3.us-east-1.amazonaws.com',
          },
        });
        const client = s3Mock.call(0).thisValue as S3Client;
        const credentials = await client.config.credentials();
        expect(credentials.secretAccessKey).toBe('typed-secret');
      });

      it('should handle S3ServiceException during connection test', async () => {
        const s3Error = new S3ServiceException({
          name: 'InvalidAccessKeyId',
          $fault: 'client',
          message: 'The AWS Access Key Id you provided does not exist in our records.',
          $metadata: { httpStatusCode: 403 },
        });
        s3Mock.on(ListBucketsCommand).rejects(s3Error);
        // Must provide all required fields to pass schema validation
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-s3',
          payload: {
            accessKeyId: 'invalid-key',
            secretAccessKey: 'secret',
            region: 'us-east-1',
            endpoint: 'https://s3.amazonaws.com',
          },
        });
        expect(response.statusCode).toBe(403);
        const payload = JSON.parse(response.payload);
        expect(payload.error).toBe('InvalidAccessKeyId');
        expect(payload.message).toBe('The AWS Access Key Id you provided does not exist in our records.');
      });

      it('should handle other errors during S3 connection test', async () => {
        s3Mock.on(ListBucketsCommand).rejects(new Error('Network issue'));
        // Must provide all required fields to pass schema validation
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-s3',
          payload: {
            accessKeyId: 'any',
            secretAccessKey: 'secret',
            region: 'us-east-1',
            endpoint: 'https://s3.amazonaws.com',
          },
        });
        expect(response.statusCode).toBe(500);
        const payload = JSON.parse(response.payload);
        expect(payload.error).toBe('Error');
        expect(payload.message).toBe('Network issue');
      });
    });
  });

  // Hugging Face Settings Tests
  describe('Hugging Face Settings', () => {
    // GET /huggingface
    describe('GET /huggingface', () => {
      it('should retrieve Hugging Face token successfully', async () => {
        (configUtils.getHFConfig as jest.Mock).mockReturnValue('test-hf-token-retrieved');
        const response = await fastify.inject({
          method: 'GET',
          url: '/huggingface',
        });
        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.payload);
        expect(payload.settings).toEqual({
          hfToken: 'test-hf-token-retrieved',
        });
      });
    });

    // PUT /huggingface
    describe('PUT /huggingface', () => {
      it('should update Hugging Face token successfully', async () => {
        const newToken = 'new-hf-token';
        const response = await fastify.inject({
          method: 'PUT',
          url: '/huggingface',
          payload: { hfToken: newToken },
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({
          message: 'Settings updated successfully',
        });
        expect(configUtils.updateHFConfig).toHaveBeenCalledWith(newToken);
      });

      it('should handle errors when updating Hugging Face token', async () => {
        (configUtils.updateHFConfig as jest.Mock).mockImplementationOnce(() => {
          throw new Error('HF Update failed');
        });
        const response = await fastify.inject({
          method: 'PUT',
          url: '/huggingface',
          payload: { hfToken: 'any' },
        });
        expect(response.statusCode).toBe(500);
        const payload = JSON.parse(response.payload);
        expect(payload.error).toBe('Error');
        expect(payload.message).toBe('HF Update failed');
      });
    });

    // POST /test-huggingface
    describe('POST /test-huggingface', () => {
      it('should test Hugging Face connection successfully', async () => {
        mockedAxios.get.mockResolvedValueOnce({
          status: 200,
          data: { auth: { accessToken: { displayName: 'TestTokenName' } } },
        } as any);
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-huggingface',
          payload: { hfToken: 'valid-token' },
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({
          message: 'Connection successful',
          accessTokenDisplayName: 'TestTokenName',
        });
        // Updated to match implementation that passes proxy: false to axios.get
        expect(mockedAxios.get).toHaveBeenCalledWith('https://huggingface.co/api/whoami-v2?', {
          headers: { Authorization: 'Bearer valid-token' },
          proxy: false,
        });
      });

      it('should handle errors during Hugging Face connection test', async () => {
        mockedAxios.get.mockRejectedValueOnce({
          isAxiosError: true,
          response: { data: { error: 'Invalid token' }, status: 401 },
        });
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-huggingface',
          payload: { hfToken: 'invalid-token' },
        });
        expect(response.statusCode).toBe(500); // Route converts to 500
        const payload = JSON.parse(response.payload);
        expect(payload.error).toBe('Invalid token');
        expect(payload.message).toBe('Invalid token');
      });

      it('should handle non-Axios errors during Hugging Face connection test', async () => {
        mockedAxios.get.mockRejectedValueOnce(new Error('Network Error'));
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-huggingface',
          payload: { hfToken: 'any-token' },
        });
        expect(response.statusCode).toBe(500);
        const payload = JSON.parse(response.payload);
        // The route has specific error handling for axios errors vs others.
        // For a generic error, it might use the 'Error testing Hugging Face connection' message.
        expect(payload.error).toBe('Hugging Face API error');
        expect(payload.message).toBe('Error testing Hugging Face connection');
      });
    });
  });

  // Max Concurrent Transfers Settings Tests
  describe('Max Concurrent Transfers Settings', () => {
    // GET /max-concurrent-transfers
    describe('GET /max-concurrent-transfers', () => {
      it('should retrieve max concurrent transfers successfully', async () => {
        (configUtils.getMaxConcurrentTransfers as jest.Mock).mockReturnValue(10);
        const response = await fastify.inject({
          method: 'GET',
          url: '/max-concurrent-transfers',
        });
        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.payload);
        expect(payload.maxConcurrentTransfers).toBe(10);
      });
    });

    // PUT /max-concurrent-transfers
    describe('PUT /max-concurrent-transfers', () => {
      it('should update max concurrent transfers successfully', async () => {
        const newLimit = 15;
        const response = await fastify.inject({
          method: 'PUT',
          url: '/max-concurrent-transfers',
          payload: { maxConcurrentTransfers: newLimit },
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({
          message: 'Settings updated successfully',
        });
        expect(configUtils.updateMaxConcurrentTransfers).toHaveBeenCalledWith(newLimit);
      });

      it('should handle errors when updating max concurrent transfers', async () => {
        (configUtils.updateMaxConcurrentTransfers as jest.Mock).mockImplementationOnce(() => {
          throw new Error('Update MCT failed');
        });
        // Must provide valid number to pass schema validation (type: "number", minimum: 1)
        const response = await fastify.inject({
          method: 'PUT',
          url: '/max-concurrent-transfers',
          payload: { maxConcurrentTransfers: 5 },
        });
        expect(response.statusCode).toBe(500);
        const payload = JSON.parse(response.payload);
        expect(payload.error).toBe('Error');
        expect(payload.message).toBe('Update MCT failed');
      });
    });
  });

  // Proxy Settings Tests
  describe('Proxy Settings', () => {
    // GET /proxy
    describe('GET /proxy', () => {
      it('should retrieve proxy settings successfully', async () => {
        (configUtils.getProxyConfig as jest.Mock).mockReturnValue({
          httpProxy: 'http://proxy.example.com:8080',
          httpsProxy: 'https://secureproxy.example.com:8081',
        });
        const response = await fastify.inject({ method: 'GET', url: '/proxy' });
        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.payload);
        expect(payload.settings).toEqual({
          httpProxy: 'http://proxy.example.com:8080',
          httpsProxy: 'https://secureproxy.example.com:8081',
        });
      });
    });

    // PUT /proxy
    describe('PUT /proxy', () => {
      it('should update proxy settings successfully', async () => {
        // Mock implementation needed to prevent the route from throwing when updateProxyConfig is called
        (configUtils.updateProxyConfig as jest.Mock).mockImplementation(() => {
          // Successfully update proxy config (no-op for test)
        });

        const newProxySettings = {
          httpProxy: 'http://newproxy.example.com:8888',
          httpsProxy: 'https://newsecureproxy.example.com:8889',
        };
        const response = await fastify.inject({
          method: 'PUT',
          url: '/proxy',
          payload: newProxySettings,
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({
          message: 'Settings updated successfully',
        });
        expect(configUtils.updateProxyConfig).toHaveBeenCalledWith(
          newProxySettings.httpProxy,
          newProxySettings.httpsProxy,
        );
      });

      it('should handle errors when updating proxy settings', async () => {
        (configUtils.updateProxyConfig as jest.Mock).mockImplementationOnce(() => {
          throw new Error('Proxy Update failed');
        });
        // Must provide all required fields: httpProxy, httpsProxy
        const response = await fastify.inject({
          method: 'PUT',
          url: '/proxy',
          payload: { httpProxy: 'any', httpsProxy: '' },
        });
        expect(response.statusCode).toBe(500);
        const payload = JSON.parse(response.payload);
        expect(payload.error).toBe('Error');
        expect(payload.message).toBe('Proxy Update failed');
      });
    });

    // POST /test-proxy
    describe('POST /test-proxy', () => {
      it('should test proxy connection successfully for HTTP', async () => {
        mockedAxios.get.mockResolvedValueOnce({ status: 200 } as any);
        const testUrl = 'http://example.com';
        const httpProxy = 'http://myproxy:8080';
        // Must provide all required fields: httpProxy, httpsProxy, testUrl
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-proxy',
          payload: { httpProxy, httpsProxy: '', testUrl },
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({
          message: 'Connection successful',
        });
        expect(mockedAxios.get).toHaveBeenCalledWith(testUrl, expect.any(Object)); // Basic check for agent
      });

      it('should test proxy connection successfully for HTTPS', async () => {
        mockedAxios.get.mockResolvedValueOnce({ status: 200 } as any);
        const testUrl = 'https://example.com';
        const httpsProxy = 'https://myproxy:8080';
        // Must provide all required fields: httpProxy, httpsProxy, testUrl
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-proxy',
          payload: { httpProxy: '', httpsProxy, testUrl },
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({
          message: 'Connection successful',
        });
        expect(mockedAxios.get).toHaveBeenCalledWith(testUrl, expect.any(Object));
      });

      it('should handle connection failure during proxy test', async () => {
        mockedAxios.get.mockRejectedValueOnce({
          isAxiosError: true,
          response: { status: 404, statusText: 'Not Found' },
          name: 'AxiosError',
          message: 'Simulated connection failure',
        });
        // Must provide all required fields: httpProxy, httpsProxy, testUrl
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-proxy',
          payload: {
            httpProxy: '',
            httpsProxy: '',
            testUrl: 'http://nonexistent.example.com',
          },
        });
        expect(response.statusCode).toBe(404);
        const payload = JSON.parse(response.payload);
        expect(payload.error).toBe('AxiosError'); // from err.name
        expect(payload.message).toBe('Connection failed with status: 404 - Not Found');
      });

      it('should handle no response error during proxy test', async () => {
        mockedAxios.get.mockRejectedValueOnce({
          isAxiosError: true,
          request: {},
          name: 'AxiosError',
          message: 'Simulated no response',
        });
        // Must provide all required fields: httpProxy, httpsProxy, testUrl
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-proxy',
          payload: {
            httpProxy: '',
            httpsProxy: '',
            testUrl: 'http://unreachable.example.com',
          },
        });
        expect(response.statusCode).toBe(500);
        const payload = JSON.parse(response.payload);
        expect(payload.error).toBe('AxiosError');
        expect(payload.message).toBe('No response received from the server.');
      });

      it('should handle generic errors during proxy test', async () => {
        mockedAxios.get.mockRejectedValueOnce(new Error('Some network issue'));
        // Must provide all required fields: httpProxy, httpsProxy, testUrl
        const response = await fastify.inject({
          method: 'POST',
          url: '/test-proxy',
          payload: {
            httpProxy: '',
            httpsProxy: '',
            testUrl: 'http://example.com',
          },
        });
        expect(response.statusCode).toBe(500);
        const payload = JSON.parse(response.payload);
        expect(payload.error).toBe('Error');
        expect(payload.message).toBe('Some network issue');
      });
    });
  });
});
