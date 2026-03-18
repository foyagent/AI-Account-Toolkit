import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';
import type { TempMailConfig } from '../types/config.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const OPENAI_AUTH_BASE = 'https://auth.openai.com';

export interface HttpClientOptions {
  proxy?: string;
  timeout?: number;
}

/**
 * 创建 HTTP 客户端实例
 */
export function createHttpClient(options: HttpClientOptions = {}): AxiosInstance {
  const config: AxiosRequestConfig = {
    timeout: options.timeout || 30000,
    validateStatus: () => true, // 不自动抛出错误
  };

  if (options.proxy) {
    config.proxy = false; // Axios proxy handling in Node.js
    config.httpAgent = undefined;
    config.httpsAgent = undefined;
  }

  const instance = axios.create(config);

  // 拦截器：添加默认请求头
  instance.interceptors.request.use((req) => {
    req.headers['User-Agent'] = USER_AGENT;
    req.headers['Accept-Language'] = 'en-US,en;q=0.9';
    return req;
  });

  // 重试拦截器
  instance.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const config = error.config as AxiosRequestConfig & { __retryCount?: number };
      if (!config) return Promise.reject(error);

      config.__retryCount = config.__retryCount || 0;
      const shouldRetry = config.__retryCount < 3 && [429, 500, 502, 503, 504].includes(error.response?.status || 0);

      if (shouldRetry) {
        config.__retryCount++;
        await new Promise((resolve) => setTimeout(resolve, 1000 * config.__retryCount!));
        return instance(config);
      }

      return Promise.reject(error);
    }
  );

  return instance;
}

/**
 * 通用请求头
 */
export function getCommonHeaders(): Record<string, string> {
  return {
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    origin: OPENAI_AUTH_BASE,
    'user-agent': USER_AGENT,
    'sec-ch-ua': '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

/**
 * 导航请求头（用于 HTML 页面）
 */
export function getNavigateHeaders(): Record<string, string> {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': USER_AGENT,
    'sec-ch-ua': '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  };
}

export { USER_AGENT, OPENAI_AUTH_BASE };
