/**
 * API Client Base
 * 
 * Centralizes HTTP requests with the proper Antigravity User-Agent and headers.
 * Uses native fetch API (available in modern VS Code / Node.js).
 */

import { API } from '../constants/app.constants';
import { Logger } from '../utils/logger';

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
}

export class ApiClient {
  /**
   * Constructs the required Antigravity User-Agent based on OS.
   */
  private static getUserAgent(): string {
    const version = API.DEFAULT_VERSION;
    const platform = process.platform === 'win32' ? 'windows' : 
                     process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    
    return `antigravity/${version} ${platform}/${arch}`;
  }

  /**
   * Performs an HTTP request with standard Antigravity headers.
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

    const fetchOptions: RequestInit = {
      method: options.method || 'GET',
      headers,
    };

    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        throw new ApiError(response.status, response.statusText);
      }

      const text = await response.text();
      // Handle empty responses
      if (!text) return {} as T;
      
      return JSON.parse(text) as T;
    } catch (error: any) {
      if (error instanceof ApiError) {
        Logger.getInstance().error(`API Request failed for ${url}`, `${error.status} ${error.statusText}`);
        throw error;
      }
      Logger.getInstance().error(`API Request failed for ${url}`, error.message);
      throw error;
    }
  }
}
