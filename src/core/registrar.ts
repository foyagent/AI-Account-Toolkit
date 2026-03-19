/**
 * core/registrar.ts
 * ================
 * Registrar 类 - 五步 HTTP 注册流程（完全按照 Python 原版翻译）
 */

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { createHttpClient, getCommonHeaders, getNavigateHeaders, USER_AGENT, OPENAI_AUTH_BASE } from '../utils/http.js';
import { generatePKCE } from '../utils/pkce.js';
import { generateDatadogTrace } from '../utils/datadog.js';
import { SentinelTokenGenerator, buildSentinelToken } from '../utils/sentinel.js';
import type { AxiosInstance } from 'axios';

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';

/**
 * 注册器（五步 HTTP 流程）
 */
export class Registrar {
  private session: AxiosInstance;
  private deviceId: string;
  private sentinelGen: SentinelTokenGenerator;
  private codeVerifier?: string;
  private state?: string;

  constructor(proxy: string = '') {
    this.session = createHttpClient({ proxy });
    this.deviceId = uuidv4();
    this.sentinelGen = new SentinelTokenGenerator(this.deviceId);
  }

  private headers(referer: string, withSentinel: boolean = false): Record<string, string> {
    const h: Record<string, string> = {
      ...getCommonHeaders(),
      referer: referer,
      'oai-device-id': this.deviceId,
    };
    Object.assign(h, generateDatadogTrace());

    if (withSentinel) {
      const sentinel = this.sentinelGen.generate();
      h['openai-sentinel-token'] = sentinel;
    }

    return h;
  }

  /**
   * Step 0: 访问主页
   */
  async step0VisitHomepage(): Promise<boolean> {
    console.log('[注册] step0 访问主页');
    try {
      const response = await this.session.get('https://chatgpt.com', {
        headers: {
          ...getCommonHeaders(),
          'Upgrade-Insecure-Requests': '1',
        },
        maxRedirects: 5,
      });
      console.log('[注册] step0 成功，状态码:', response.status);
      return response.status < 400;
    } catch (error) {
      console.warn('[注册] step0 失败:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * Step 1: 获取 CSRF token
   */
  async step1GetCsrf(): Promise<string | null> {
    console.log('[注册] step1 获取 CSRF token');
    try {
      const response = await this.session.get('https://chatgpt.com/backend-api/csrf-protection', {
        headers: this.headers('https://chatgpt.com'),
        maxRedirects: 5,
      });
      console.log('[注册] step1 成功，状态码:', response.status);
      
      const csrfToken = response.headers['x-csrf-token'];
      if (!csrfToken) {
        console.warn('[注册] 未获取到 CSRF token');
        return null;
      }
      
      console.log('[注册] CSRF token:', csrfToken);
      return csrfToken;
    } catch (error) {
      console.warn('[注册] step1 失败:', error instanceof Error ? error.message : error);
      return null;
    }
  }

  /**
   * Step 2: Signin 获取 authorize URL
   */
  async step2Signin(email: string, csrf: string): Promise<string | null> {
    console.log('[注册] step2 Signin，email:', email);
    try {
      const response = await this.session.post(
        'https://chatgpt.com/backend-api/login',
        { email },
        {
          headers: {
            ...this.headers('https://chatgpt.com', true),
            'x-csrf-token': csrf,
          },
          maxRedirects: 5,
        }
      );
      console.log('[注册] step2 成功，状态码:', response.status);

      const data = response.data as any;
      const authorizeUrl = data?.authorize_url || data?.url;
      
      if (!authorizeUrl) {
        console.warn('[注册] 未获取到 authorize_url');
        console.log('[注册] 响应数据:', data);
        return null;
      }

      console.log('[注册] authorize_url:', authorizeUrl);
      return authorizeUrl;
    } catch (error) {
      console.warn('[注册] step2 失败:', error instanceof Error ? error.message : error);
      return null;
    }
  }

  /**
   * Step 3: Authorize（GET 授权 URL，允许重定向，返回最终 URL）
   */
  async step3Authorize(authorizeUrl: string): Promise<string> {
    console.log('[注册] step3 Authorize');
    console.log('[注册] authorize_url:', authorizeUrl);
    
    try {
      const response = await this.session.get(authorizeUrl, {
        headers: {
          ...getCommonHeaders(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': 'https://chatgpt.com/',
          'Upgrade-Insecure-Requests': '1',
        },
        maxRedirects: 5,
        validateStatus: () => true,
      });
      
      const finalUrl = response.request?.res?.responseUrl || authorizeUrl;
      console.log('[注册] step3 成功，最终 URL:', finalUrl);
      return finalUrl;
    } catch (error) {
      console.warn('[注册] step3 失败:', error instanceof Error ? error.message : error);
      return authorizeUrl;
    }
  }

  /**
   * Step 4: 注册用户（POST /api/accounts/user/register）
   */
  async step4RegisterUser(email: string, password: string): Promise<boolean> {
    console.log('[注册] step4 注册用户');
    try {
      const h = this.headers(`${OPENAI_AUTH_BASE}/create-account/password`);
      const sentinel = await buildSentinelToken(this.session, this.deviceId, 'register_user');
      if (sentinel) h['openai-sentinel-token'] = sentinel;

      const response = await this.session.post(
        `${OPENAI_AUTH_BASE}/api/accounts/user/register`,
        { username: email, password: password },
        { headers: h }
      );

      console.log('[注册] step4 状态码:', response.status);
      console.log('[注册] step4 响应:', response.data);

      return [200, 301, 302].includes(response.status);
    } catch (error) {
      console.warn('[注册] step4 失败:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * Step 5: 发送 OTP
   */
  async step5SendOTP(): Promise<boolean> {
    console.log('[注册] step5 发送 OTP');
    try {
      const response = await this.session.get(
        `${OPENAI_AUTH_BASE}/api/accounts/email-otp/send`,
        {
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': `${OPENAI_AUTH_BASE}/create-account/password`,
            'Upgrade-Insecure-Requests': '1',
          },
          maxRedirects: 5,
          validateStatus: () => true,
        }
      );

      console.log('[注册] step5 状态码:', response.status);
      console.log('[注册] step5 最终 URL:', response.request?.res?.responseUrl);

      return response.status < 400;
    } catch (error) {
      console.warn('[注册] step5 失败:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * Step 6: 验证 OTP
   */
  async step6ValidateOTP(code: string): Promise<boolean> {
    console.log('[注册] step6 验证 OTP:', code);
    try {
      const h = this.headers(`${OPENAI_AUTH_BASE}/email-verification`, true);
      const response = await this.session.post(
        `${OPENAI_AUTH_BASE}/api/accounts/email-otp/validate`,
        { code },
        { headers: h }
      );

      console.log('[注册] step6 状态码:', response.status);
      console.log('[注册] step6 响应:', response.data);

      return response.status === 200;
    } catch (error) {
      console.warn('[注册] step6 失败:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * Step 7: 创建账号（填写姓名和生日）
   */
  async step7CreateAccount(firstName: string, lastName: string, birthdate: string): Promise<boolean> {
    console.log('[注册] step7 创建账号');
    try {
      const h = this.headers(`${OPENAI_AUTH_BASE}/about-you`, true);
      const response = await this.session.post(
        `${OPENAI_AUTH_BASE}/api/accounts/create_account`,
        { name: `${firstName} ${lastName}`, birthdate: birthdate },
        { headers: h }
      );

      console.log('[注册] step7 状态码:', response.status);
      console.log('[注册] step7 响应:', response.data);

      const data = response.data as any;
      const continueUrl = data?.continue_url || data?.url || data?.redirect_url;
      
      if (continueUrl) {
        console.log('[注册] continue_url:', continueUrl);
      }

      return response.status === 200;
    } catch (error) {
      console.warn('[注册] step7 失败:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * Step 8: Callback（访问 continue_url）
   */
  async step8Callback(url: string): Promise<boolean> {
    console.log('[注册] step8 Callback');
    console.log('[注册] callback_url:', url);
    
    if (!url) {
      console.warn('[注册] 没有 callback_url，跳过');
      return true;
    }

    try {
      const response = await this.session.get(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Upgrade-Insecure-Requests': '1',
        },
        maxRedirects: 5,
        validateStatus: () => true,
      });

      const finalUrl = response.request?.res?.responseUrl || url;
      console.log('[注册] step8 最终 URL:', finalUrl);

      // 检查是否成功（最终 URL 包含 callback 或 chatgpt.com）
      return finalUrl.includes('callback') || finalUrl.includes('chatgpt.com');
    } catch (error) {
      console.warn('[注册] step8 失败:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * 执行完整注册流程（完全按照 Python 原版）
   */
  async register(email: string, jwtToken: string, password: string): Promise<boolean> {
    const { generateRandomName, generateRandomBirthday } = await import('../utils/random.js');
    const { waitForOTP } = await import('../utils/temp-mail.js');
    const { loadConfig } = await import('../config.js');
    const httpSession = this.session;
    const TEMP_MAIL_WORKER_DOMAIN = loadConfig().temp_mail.worker_domain;

    const { firstName, lastName } = generateRandomName();
    const birthdate = generateRandomBirthday();

    console.log('='.repeat(60));
    console.log('[注册] 开始完整注册流程');
    console.log('='.repeat(60));

    // Step 0: 访问主页
    console.log('[注册] --- Step 0: 访问主页 ---');
    if (!(await this.step0VisitHomepage())) {
      console.warn('[注册] step0 失败');
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Step 1: 获取 CSRF token
    console.log('[注册] --- Step 1: 获取 CSRF ---');
    const csrf = await this.step1GetCsrf();
    if (!csrf) {
      console.warn('[注册] step1 失败');
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Step 2: Signin 获取 authorize URL
    console.log('[注册] --- Step 2: Signin ---');
    const authorizeUrl = await this.step2Signin(email, csrf);
    if (!authorizeUrl) {
      console.warn('[注册] step2 失败');
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Step 3: Authorize（关键：返回最终 URL）
    console.log('[注册] --- Step 3: Authorize ---');
    const finalUrl = await this.step3Authorize(authorizeUrl);
    const finalPath = new URL(finalUrl).pathname;
    console.log('[注册] 最终路径:', finalPath);
    console.log('[注册] 最终 URL:', finalUrl);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 根据最终路径决定后续流程（完全按照 Python 原版）
    let needOTP = false;
    let continueUrl = '';

    if (finalPath.includes('/create-account/password')) {
      console.log('[注册] 检测到全新注册流程');
      
      // Step 4: 注册用户
      console.log('[注册] --- Step 4: 注册用户 ---');
      if (!(await this.step4RegisterUser(email, password))) {
        console.warn('[注册] step4 失败');
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 5: 发送 OTP
      console.log('[注册] --- Step 5: 发送 OTP ---');
      if (!(await this.step5SendOTP())) {
        console.warn('[注册] step5 失败');
        return false;
      }
      needOTP = true;

    } else if (finalPath.includes('/email-verification') || finalPath.includes('/email-otp')) {
      console.log('[注册] 跳到 OTP 验证阶段（authorize 已触发 OTP）');
      // 不需要调用 step5SendOTP，因为 authorize 已经触发了 OTP 发送
      needOTP = true;

    } else if (finalPath.includes('/about-you')) {
      console.log('[注册] 跳到填写信息阶段');
      
      // Step 7: 创建账号
      console.log('[注册] --- Step 7: 创建账号 ---');
      if (!(await this.step7CreateAccount(firstName, lastName, birthdate))) {
        console.warn('[注册] step7 失败');
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));

      // 获取 continue_url
      const response = await this.session.get(
        `${OPENAI_AUTH_BASE}/api/accounts/create_account`,
        {
          headers: this.headers(`${OPENAI_AUTH_BASE}/about-you`, true),
          validateStatus: () => true,
        }
      );
      const data = response.data as any;
      continueUrl = data?.continue_url || data?.url || data?.redirect_url || '';

      // Step 8: Callback
      console.log('[注册] --- Step 8: Callback ---');
      await this.step8Callback(continueUrl);
      
      console.log('[注册] 注册完成！');
      return true;

    } else if (finalPath.includes('/callback') || finalUrl.includes('chatgpt.com')) {
      console.log('[注册] 账号已完成注册');
      return true;

    } else {
      console.warn('[注册] 未知跳转:', finalUrl);
      // 尝试按照全新注册流程处理
      console.log('[注册] 尝试全新注册流程...');
      
      if (!(await this.step4RegisterUser(email, password))) {
        console.warn('[注册] step4 失败');
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));

      if (!(await this.step5SendOTP())) {
        console.warn('[注册] step5 失败');
        return false;
      }
      needOTP = true;
    }

    // 如果需要 OTP 验证
    if (needOTP) {
      console.log('[注册] --- 等待 OTP 验证码 ---');
      const code = await waitForOTP(httpSession, TEMP_MAIL_WORKER_DOMAIN, jwtToken, 120);
      if (!code) {
        console.warn('[注册] 未收到验证码');
        return false;
      }

      console.log('[注册] 收到验证码:', code);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 6: 验证 OTP
      console.log('[注册] --- Step 6: 验证 OTP ---');
      if (!(await this.step6ValidateOTP(code))) {
        console.warn('[注册] step6 失败');
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 7: 创建账号
      console.log('[注册] --- Step 7: 创建账号 ---');
      if (!(await this.step7CreateAccount(firstName, lastName, birthdate))) {
        console.warn('[注册] step7 失败');
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));

      // 获取 continue_url
      const response = await this.session.get(
        `${OPENAI_AUTH_BASE}/api/accounts/create_account`,
        {
          headers: this.headers(`${OPENAI_AUTH_BASE}/about-you`, true),
          validateStatus: () => true,
        }
      );
      const data = response.data as any;
      continueUrl = data?.continue_url || data?.url || data?.redirect_url || '';

      // Step 8: Callback
      console.log('[注册] --- Step 8: Callback ---');
      await this.step8Callback(continueUrl);
    }

    console.log('='.repeat(60));
    console.log('[注册] 注册流程完成！');
    console.log('='.repeat(60));
    return true;
  }
}
