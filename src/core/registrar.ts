/**
 * core/registrar.ts
 * ================
 * Registrar 类 - 五步 HTTP 注册流程
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
      h['openai-sentinel-token'] = this.sentinelGen.generateToken();
    }

    return h;
  }

  /**
   * Step 0: 初始化 OAuth 会话
   */
  async step0InitOAuth(email: string): Promise<boolean> {
    // 设置 cookies
    const cookieJar = this.session.defaults.jar as any;
    if (cookieJar) {
      cookieJar.setCookieSync(`oai-did=${this.deviceId}`, OPENAI_AUTH_BASE);
      cookieJar.setCookieSync(`oai-did=${this.deviceId}`, 'auth.openai.com');
    }

    const { codeVerifier, codeChallenge } = generatePKCE();
    this.codeVerifier = codeVerifier;
    this.state = uuidv4();

    console.log('[注册] PKCE:', { 
      codeVerifier: codeVerifier.slice(0, 20) + '...', 
      codeChallenge: codeChallenge.slice(0, 20) + '...' 
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: 'openid profile email offline_access',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: this.state,
      screen_hint: 'signup',
      prompt: 'login',
    });

    const url = `${OPENAI_AUTH_BASE}/oauth/authorize?${params.toString()}`;
    console.log('[注册] OAuth URL:', url);
    console.log('[注册] OPENAI_AUTH_BASE:', OPENAI_AUTH_BASE);

    try {
      await this.session.get(url, {
        headers: getNavigateHeaders(),
        maxRedirects: 5,
      });
    } catch (error) {
      console.warn('[注册] step0a 失败:', error instanceof Error ? error.message : error);
      return false;
    }

    // 检查 login_session cookie
    const cookies = this.session.defaults.jar?.getCookieString?.(OPENAI_AUTH_BASE) || '';
    if (!cookies.includes('login_session')) {
      console.warn('[注册] step0a 未获取 login_session cookie');
      return false;
    }

    // 提交邮箱
    const h = this.headers(`${OPENAI_AUTH_BASE}/create-account`);
    const sentinel = await buildSentinelToken(this.session, this.deviceId, 'authorize_continue');
    if (sentinel) h['openai-sentinel-token'] = sentinel;

    try {
      const response = await this.session.post(
        `${OPENAI_AUTH_BASE}/api/accounts/authorize/continue`,
        {
          username: { kind: 'email', value: email },
          screen_hint: 'signup',
        },
        { headers: h }
      );
      return response.status === 200;
    } catch (error) {
      console.warn('[注册] step0b 异常:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * Step 2: 注册用户
   */
  async step2RegisterUser(email: string, password: string): Promise<boolean> {
    const h = this.headers(`${OPENAI_AUTH_BASE}/create-account/password`, true);

    try {
      const response = await this.session.post(
        `${OPENAI_AUTH_BASE}/api/accounts/user/register`,
        { username: email, password: password },
        { headers: h }
      );

      if (response.status === 200) return true;
      if ([301, 302].includes(response.status)) {
        const location = response.headers['location'] || '';
        return location.includes('email-otp') || location.includes('email-verification');
      }

      console.warn('[注册] step2 失败:', response.status, (response.data as string)?.slice(0, 200));
      return false;
    } catch (error) {
      console.warn('[注册] step2 异常:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * Step 3: 发送 OTP
   */
  async step3SendOTP(): Promise<boolean> {
    try {
      const h = { ...getNavigateHeaders(), referer: `${OPENAI_AUTH_BASE}/create-account/password` };
      await this.session.get(`${OPENAI_AUTH_BASE}/api/accounts/email-otp/send`, {
        headers: h,
        maxRedirects: 5,
      });
      await this.session.get(`${OPENAI_AUTH_BASE}/email-verification`, {
        headers: h,
        maxRedirects: 5,
      });
      return true;
    } catch (error) {
      console.warn('[注册] step3 异常:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * Step 4: 验证 OTP
   */
  async step4ValidateOTP(code: string): Promise<boolean> {
    const h = this.headers(`${OPENAI_AUTH_BASE}/email-verification`);

    try {
      const response = await this.session.post(
        `${OPENAI_AUTH_BASE}/api/accounts/email-otp/validate`,
        { code: code },
        { headers: h }
      );
      return response.status === 200;
    } catch (error) {
      console.warn('[注册] step4 异常:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * Step 5: 创建账号
   */
  async step5CreateAccount(firstName: string, lastName: string, birthdate: string): Promise<boolean> {
    const h = this.headers(`${OPENAI_AUTH_BASE}/about-you`);
    const body = { name: `${firstName} ${lastName}`, birthdate: birthdate };

    try {
      const response = await this.session.post(
        `${OPENAI_AUTH_BASE}/api/accounts/create_account`,
        body,
        { headers: h }
      );

      if (response.status === 200) return true;

      if (response.status === 403 && String(response.data).toLowerCase().includes('sentinel')) {
        h['openai-sentinel-token'] = new SentinelTokenGenerator(this.deviceId).generateToken();
        const response2 = await this.session.post(
          `${OPENAI_AUTH_BASE}/api/accounts/create_account`,
          body,
          { headers: h }
        );
        return [200, 301, 302].includes(response2.status);
      }

      return [301, 302].includes(response.status);
    } catch (error) {
      console.warn('[注册] step5 异常:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * 执行完整注册流程
   */
  async register(email: string, jwtToken: string, password: string): Promise<boolean> {
    const { generateRandomName, generateRandomBirthday } = await import('../utils/random.js');
    const { waitForOTP } = await import('../utils/temp-mail.js');
    const { loadConfig } = await import('../config.js');
    const httpSession = this.session;
    const TEMP_MAIL_WORKER_DOMAIN = loadConfig().temp_mail.worker_domain;

    const { firstName, lastName } = generateRandomName();
    const birthdate = generateRandomBirthday();

    console.log('[注册] step0 初始化 OAuth');
    if (!(await this.step0InitOAuth(email))) {
      console.warn('[注册] step0 失败');
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log('[注册] step2 提交注册表单');
    if (!(await this.step2RegisterUser(email, password))) {
      console.warn('[注册] step2 失败');
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log('[注册] step3 发送 OTP');
    if (!(await this.step3SendOTP())) {
      console.warn('[注册] step3 失败');
      return false;
    }

    console.log('[注册] 等待验证码...');
    const code = await waitForOTP(httpSession, TEMP_MAIL_WORKER_DOMAIN, jwtToken, 120);
    if (!code) {
      console.warn('[注册] 未收到验证码');
      return false;
    }

    console.log('[注册] step4 验证 OTP:', code);
    if (!(await this.step4ValidateOTP(code))) {
      console.warn('[注册] step4 失败');
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log('[注册] step5 创建账号');
    const ok = await this.step5CreateAccount(firstName, lastName, birthdate);
    if (!ok) {
      console.warn('[注册] step5 失败');
    }
    return ok;
  }
}
