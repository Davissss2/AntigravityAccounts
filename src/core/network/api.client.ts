/**
 * API Client Base
 * 
 * Centralizes HTTP requests with the proper Antigravity User-Agent and headers.
 * Uses native fetch API (available in modern VS Code / Node.js).
 */

import { API } from '../constants/app.constants';
import { Logger } from '../utils/logger';
import { getAntigravityVersion } from '../utils/version.utils';

export class ApiError extends Error {
  constructor(public status: number, public statusText: string, message?: string) {
    super(message || `API Error: ${status} ${statusText}`);
    this.name = 'ApiError';
  }
}

interface ApiRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  accessToken?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class ApiClient {
  private static cachedUserAgent: string | null = null;

  /**
   * Constructs the required Antigravity User-Agent based on installed version and OS.
   */
  private static getUserAgent(): string {
    if (this.cachedUserAgent) {
      return this.cachedUserAgent;
    }

    let version: string = API.DEFAULT_VERSION;
    try {
      const detected = getAntigravityVersion();
      if (detected?.short) {
        version = detected.short;
      }
    } catch {
      // Fallback to default version
    }

    const platform = process.platform === 'win32' ? 'windows' : 
                     process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    
    this.cachedUserAgent = `antigravity/${version} ${platform}/${arch}`;
    return this.cachedUserAgent;
  }

  /**
   * Performs an HTTP request with standard Antigravity headers and configurable timeout.
   */
  static async request<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      'User-Agent': this.getUserAgent(),
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (options.accessToken) {
      headers['Authorization'] = `Bearer ${options.accessToken}`;
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 7000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let onCallerAbort: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new ApiError(499, 'Client Closed Request', 'Request cancelled by user');
      }
      onCallerAbort = () => {
        clearTimeout(timer);
        controller.abort();
      };
      options.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const fetchOptions: RequestInit = {
      method: options.method || 'GET',
      headers,
      signal: controller.signal,
    };

    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new ApiError(response.status, response.statusText, errBody || undefined);
      }

      const text = await response.text();
      // Handle empty responses
      if (!text) return {} as T;
      
      return JSON.parse(text) as T;
    } catch (error: any) {
      if (options.signal?.aborted) {
        throw new ApiError(499, 'Client Closed Request', 'Request cancelled by user');
      }
      if (error?.name === 'AbortError') {
        Logger.getInstance().warn(`API Request timed out after ${timeoutMs}ms for ${url}`);
        throw new ApiError(408, 'Request Timeout', `Request timed out after ${timeoutMs}ms`);
      }
      if (error instanceof ApiError) {
        Logger.getInstance().error(`API Request failed for ${url}`, `${error.status} ${error.statusText}`);
        throw error;
      }
      Logger.getInstance().error(`API Request failed for ${url}`, error.message);
      throw error;
    } finally {
      clearTimeout(timer);
      if (options.signal && onCallerAbort) {
        options.signal.removeEventListener('abort', onCallerAbort);
      }
    }
  }
}
