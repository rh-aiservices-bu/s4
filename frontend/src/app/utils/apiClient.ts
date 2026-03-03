import axios, { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import config from '@app/config';
import Emitter from './emitter';

// Token storage key
const AUTH_TOKEN_KEY = 's4_auth_token';

// Module-level token cache
let authToken: string | null = null;

/**
 * Set the authentication token
 * Stores in both memory and sessionStorage
 */
export const setAuthToken = (token: string | null): void => {
  authToken = token;
  if (token) {
    sessionStorage.setItem(AUTH_TOKEN_KEY, token);
  } else {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
  }
};

/**
 * Get the current authentication token
 * Reads from memory first, falls back to sessionStorage
 */
export const getAuthToken = (): string | null => {
  if (!authToken) {
    authToken = sessionStorage.getItem(AUTH_TOKEN_KEY);
  }
  return authToken;
};

/**
 * Clear the authentication token
 */
export const clearAuthToken = (): void => {
  authToken = null;
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
};

/**
 * Create a configured axios instance for API calls
 */
const createApiClient = (): AxiosInstance => {
  const client = axios.create({
    baseURL: config.backend_api_url,
    headers: {
      'Content-Type': 'application/json',
    },
    withCredentials: true, // Enable sending cookies in cross-origin requests
  });

  // Request interceptor - add auth token to requests
  client.interceptors.request.use(
    (requestConfig: InternalAxiosRequestConfig) => {
      const token = getAuthToken();
      if (token && requestConfig.headers) {
        requestConfig.headers.Authorization = `Bearer ${token}`;
      }
      return requestConfig;
    },
    (error: AxiosError) => {
      return Promise.reject(error);
    },
  );

  // Request interceptor - strip Content-Type on DELETE with no body
  // Fastify 5 rejects Content-Type: application/json with empty body (FST_ERR_CTP_EMPTY_JSON_BODY)
  client.interceptors.request.use(
    (requestConfig: InternalAxiosRequestConfig) => {
      if (requestConfig.method === 'delete' && !requestConfig.data) {
        delete requestConfig.headers['Content-Type'];
      }
      return requestConfig;
    },
    (error: AxiosError) => {
      return Promise.reject(error);
    },
  );

  // Response interceptor - handle 401 responses
  client.interceptors.response.use(
    (response: AxiosResponse) => response,
    (error: AxiosError) => {
      if (error.response?.status === 401) {
        // Clear token and emit unauthorized event
        clearAuthToken();
        Emitter.emit('auth:unauthorized', {
          message: 'Session expired. Please log in again.',
        });
      }
      return Promise.reject(error);
    },
  );

  return client;
};

// Create and export the API client instance
const apiClient = createApiClient();

export default apiClient;
