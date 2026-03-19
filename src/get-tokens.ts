/**
 * get-tokens.ts
 * =============
 * 简化版：只做注册 + 获取 access_token
 * 输出格式（results.txt）：email|email_jwt|password|access_token
 * 配置文件：config.yaml（与 gpt-team.ts 共用）
 */

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig } from './config.js';
import { createHttpClient, getCommonHeaders, getNavigateHeaders, USER_AGENT, OPENAI_AUTH_BASE } from './utils/http.js';
import { generatePKCE } from './utils/pkce.js';
import { generateDatadogTrace } from './utils/datadog.js';
import { SentinelTokenGenerator, buildSentinelToken } from './utils/sentinel.js';
import { createTempEmail, fetchEmailsList, extractOTP, waitForOTP } from './utils/temp-mail.js';
import { generateRandomName, generateRandomBirthday, generateRandomPassword } from './utils/random.js';
import type { AppConfig } from './types/config.js';
import type { AxiosInstance } from 'axios';

// ============================================================
// 常量
// ============================================================
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';

// ============================================================
// 配置加载
// ============================================================
let _config: AppConfig | null = null;

function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

const TOTAL_ACCOUNTS = () => getConfig().total_accounts;
const TEMP_MAIL_WORKER_DOMAIN = () => getConfig().temp_mail.worker_domain;
const TEMP_MAIL_EMAIL_DOMAINS = () => getConfig().temp_mail.email_domains;
const TEMP_MAIL_ADMIN_PASSWORD = () => getConfig().temp_mail.admin_password;
const RESULTS_FILE = () => getConfig().output.results_file;
const PROXY = () => getConfig().proxy || '';

console.log(`配置已加载 | 目标数量: ${getConfig().total_accounts} | 邮箱域名: ${getConfig().temp_mail.email_domains}`);

// ============================================================
// HTTP 客户端
// ============================================================
const httpSession = createHttpClient({ proxy: PROXY() });

// ============================================================
// 工具函数
// ============================================================

/**
 * 从 URL 中提取 OAuth code
 */
function extractCodeFromUrl(url: string | null): string | null {
  if (!url || !url.includes('code=')) return null;

  try {
    const urlObj = new URL(url);
    return urlObj.searchParams.get('code');
  } catch {
    return null;
  }
}

/**
 * 跟随重定向提取 OAuth code
 */
async function followRedirectsForCode(
  session: AxiosInstance,
  url: string,
  maxDepth: number = 10
): Promise<string | null> {
  if (maxDepth <= 0) return null;

  try {
    const response = await session.get(url, {
      headers: getNavigateHeaders(),
      maxRedirects: 0,
      validateStatus: () => true,
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers['location'] || '';
      const code = extractCodeFromUrl(location);
      if (code) return code;

      const nextUrl = location.startsWith('/') ? OPENAI_AUTH_BASE + location : location;
      return followRedirectsForCode(session, nextUrl, maxDepth - 1);
    }

    if (response.status === 200) {
      return extractCodeFromUrl(response.request?.res?.responseUrl || url);
    }
  } catch (error: any) {
    // 处理 ConnectionError，从错误消息中提取 localhost URL
    const match = error?.message?.match(/(https?:\/\/localhost[^\s'"]+)/);
    if (match) {
      return extractCodeFromUrl(match[1]);
    }
  }

  return null;
}

// ============================================================
// 注册器（五步 HTTP 流程）
// ============================================================
class Registrar {
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
    const cookieJar = this.session.defaults.jar || new axios.CookieJar?.();
    if (cookieJar) {
      cookieJar.setCookieSync(`oai-did=${this.deviceId}`, OPENAI_AUTH_BASE);
      cookieJar.setCookieSync(`oai-did=${this.deviceId}`, 'auth.openai.com');
    }

    const { codeVerifier, codeChallenge } = generatePKCE();
    this.codeVerifier = codeVerifier;
    this.state = uuidv4();

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
    const code = await waitForOTP(httpSession, TEMP_MAIL_WORKER_DOMAIN(), jwtToken, 120);
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

// ============================================================
// OAuth 登录获取 access_token
// ============================================================
async function oauthLogin(
  email: string,
  password: string,
  jwtToken: string,
  proxy: string = ''
): Promise<string | null> {
  const session = createHttpClient({ proxy });
  const deviceId = uuidv4();

  const cookieJar = session.defaults.jar || new axios.CookieJar?.();
  if (cookieJar) {
    cookieJar.setCookieSync(`oai-did=${deviceId}`, OPENAI_AUTH_BASE);
    cookieJar.setCookieSync(`oai-did=${deviceId}`, 'auth.openai.com');
  }

  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = uuidv4();

  // Step A: 获取 login_session
  console.log('[登录] Step A: authorize');
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: 'openid profile email offline_access',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: state,
  });

  try {
    await session.get(
      `${OPENAI_AUTH_BASE}/oauth/authorize?${authParams.toString()}`,
      { headers: getNavigateHeaders(), maxRedirects: 5 }
    );
  } catch (error) {
    console.warn('[登录] Step A 失败:', error instanceof Error ? error.message : error);
    return null;
  }

  // Step B: 提交邮箱
  console.log('[登录] Step B: 提交邮箱');
  let h: Record<string, string> = {
    ...getCommonHeaders(),
    referer: `${OPENAI_AUTH_BASE}/log-in`,
    'oai-device-id': deviceId,
  };
  Object.assign(h, generateDatadogTrace());

  const sentinel = await buildSentinelToken(session, deviceId, 'authorize_continue');
  if (sentinel) h['openai-sentinel-token'] = sentinel;

  try {
    const response = await session.post(
      `${OPENAI_AUTH_BASE}/api/accounts/authorize/continue`,
      { username: { kind: 'email', value: email } },
      { headers: h }
    );

    if (response.status !== 200) {
      console.warn('[登录] Step B 失败: HTTP', response.status);
      return null;
    }

    let continueUrl = response.data?.continue_url || '';
    let pageType = response.data?.page?.type || '';

    // Step C: 提交密码
    console.log('[登录] Step C: 提交密码');
    h['referer'] = `${OPENAI_AUTH_BASE}/log-in/password`;
    Object.assign(h, generateDatadogTrace());

    const sentinel2 = await buildSentinelToken(session, deviceId, 'password_verify');
    if (sentinel2) h['openai-sentinel-token'] = sentinel2;

    const responseC = await session.post(
      `${OPENAI_AUTH_BASE}/api/accounts/password/verify`,
      { password: password },
      { headers: h, maxRedirects: 0 }
    );

    if (responseC.status !== 200) {
      console.warn('[登录] Step C 失败: HTTP', responseC.status);
      return null;
    }

    continueUrl = responseC.data?.continue_url || continueUrl;
    pageType = responseC.data?.page?.type || pageType;

    // Step D: OTP 验证（可选）
    if (pageType === 'email_otp_verification' || continueUrl.includes('email-verification')) {
      console.log('[登录] Step D: 需要 OTP 验证');

      const h_v: Record<string, string> = {
        ...getCommonHeaders(),
        referer: `${OPENAI_AUTH_BASE}/email-verification`,
        'oai-device-id': deviceId,
      };
      Object.assign(h_v, generateDatadogTrace());

      // 触发 OTP 发送
      const sentinelOtp = await buildSentinelToken(session, deviceId, 'email_otp');
      if (sentinelOtp) h_v['openai-sentinel-token'] = sentinelOtp;

      try {
        await session.post(`${OPENAI_AUTH_BASE}/api/accounts/email-otp/init`, {}, { headers: h_v });
      } catch {
        // Ignore
      }

      // 等待并提交验证码
      const tried = new Set<string>();
      const startTime = Date.now();
      let got = false;

      while (Date.now() - startTime < 120000) {
        const emails = await fetchEmailsList(httpSession, TEMP_MAIL_WORKER_DOMAIN(), jwtToken);

        for (const email of emails) {
          if (tried.has(email.id)) continue;
          tried.add(email.id);

          const c = extractOTP(email.raw || '');
          if (c && !tried.has(c)) {
            tried.add(c);
            const rv = await session.post(
              `${OPENAI_AUTH_BASE}/api/accounts/email-otp/validate`,
              { code: c },
              { headers: h_v }
            );

            if (rv.status === 200) {
              continueUrl = rv.data?.continue_url || continueUrl;
              pageType = rv.data?.page?.type || pageType;
              got = true;
              console.log('[登录] OTP 验证成功:', c);
              break;
            }
          }
        }

        if (got) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      if (!got) {
        console.warn('[登录] OTP 超时');
        return null;
      }

      // about-you 页面处理
      if (continueUrl.includes('about-you')) {
        const fullAbout = continueUrl.startsWith('http')
          ? continueUrl
          : `${OPENAI_AUTH_BASE}${continueUrl}`;

        try {
          const respAbout = await session.get(fullAbout, {
            headers: getNavigateHeaders(),
            maxRedirects: 5,
          });

          const aboutUrl = respAbout.request?.res?.responseUrl || fullAbout;
          if (aboutUrl.includes('consent') || aboutUrl.includes('organization')) {
            continueUrl = aboutUrl;
          } else {
            const { firstName, lastName } = generateRandomName();
            const bd = generateRandomBirthday();

            const h_create: Record<string, string> = {
              ...getCommonHeaders(),
              referer: fullAbout,
              'oai-device-id': deviceId,
            };
            Object.assign(h_create, generateDatadogTrace());

            const r_create = await session.post(
              `${OPENAI_AUTH_BASE}/api/accounts/create_account`,
              { name: `${firstName} ${lastName}`, birthdate: bd },
              { headers: h_create }
            );

            if (r_create.status === 200) {
              continueUrl = r_create.data?.continue_url || continueUrl;
            } else if (
              r_create.status === 400 &&
              String(r_create.data).includes('already_exists')
            ) {
              continueUrl = `${OPENAI_AUTH_BASE}/sign-in-with-chatgpt/codex/consent`;
            }
          }
        } catch (error) {
          console.warn('[登录] about-you 处理异常:', error instanceof Error ? error.message : error);
        }
      }

      if (pageType === 'consent') {
        continueUrl = `${OPENAI_AUTH_BASE}/sign-in-with-chatgpt/codex/consent`;
      }
    }

    // Step E: 跟随 consent 重定向获取 auth code
    if (!continueUrl) {
      console.warn('[登录] 无 continue_url');
      return null;
    }

    const consentUrl = continueUrl.startsWith('http')
      ? continueUrl
      : `${OPENAI_AUTH_BASE}${continueUrl}`;
    console.log('[登录] Step E: 获取 auth code | consent_url=', consentUrl.slice(0, 80));

    let authCode: string | null = null;

    try {
      const respC = await session.get(consentUrl, {
        headers: getNavigateHeaders(),
        maxRedirects: 0,
      });

      console.log(
        '[登录] consent GET: HTTP',
        respC.status,
        '| Location=',
        (respC.headers['location'] || '').slice(0, 100)
      );

      if ([301, 302, 303, 307, 308].includes(respC.status)) {
        const loc = respC.headers['location'] || '';
        authCode = extractCodeFromUrl(loc);

        if (!authCode) {
          const nextUrl = loc.startsWith('http') ? loc : `${OPENAI_AUTH_BASE}${loc}`;
          authCode = await followRedirectsForCode(session, nextUrl);
        }
      } else if (respC.status === 200) {
        const html = respC.data as string;
        const consentH: Record<string, string> = {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          origin: OPENAI_AUTH_BASE,
          referer: consentUrl,
          'user-agent': USER_AGENT,
          'oai-device-id': deviceId,
        };

        const consentPayload: Record<string, string> = { action: 'allow' };

        const stateMatch = html.match(/["']state["']:\s*["']([^"'\\s]+)["']/);
        const nonceMatch = html.match(/["']nonce["']:\s*["']([^"'\\s]+)["']/);

        if (stateMatch) consentPayload['state'] = stateMatch[1];
        if (nonceMatch) consentPayload['nonce'] = nonceMatch[1];

        console.log('[登录] consent POST to consent_url | payload=', consentPayload);

        try {
          const rPost = await session.post(consentUrl, consentPayload, {
            headers: consentH,
            maxRedirects: 0,
          });

          console.log(
            '[登录] consent POST: HTTP',
            rPost.status,
            '| Location=',
            (rPost.headers['location'] || '').slice(0, 100),
            '| body=',
            (rPost.data as string)?.slice(0, 300)
          );

          if ([301, 302, 303, 307, 308].includes(rPost.status)) {
            const loc2 = rPost.headers['location'] || '';
            authCode = extractCodeFromUrl(loc2);

            if (!authCode) {
              const nextUrl = loc2.startsWith('http') ? loc2 : `${OPENAI_AUTH_BASE}${loc2}`;
              authCode = await followRedirectsForCode(session, nextUrl);
            }
          } else if (rPost.status === 200) {
            const rd = rPost.data as any;
            const redir = rd?.redirectTo || rd?.redirect_url || rd?.continue_url || '';
            console.log('[登录] consent POST 200 redir=', redir.slice(0, 100));

            if (redir) {
              authCode =
                extractCodeFromUrl(redir) ||
                (await followRedirectsForCode(
                  session,
                  redir.startsWith('http') ? redir : `${OPENAI_AUTH_BASE}${redir}`
                ));
            }
          }
        } catch (error: any) {
          const match = error?.message?.match(/(https?:\/\/localhost[^\s'"]+)/);
          if (match) {
            authCode = extractCodeFromUrl(match[1]);
          }
        }
      } else {
        authCode = extractCodeFromUrl(respC.request?.res?.responseUrl || consentUrl);
        if (!authCode) {
          authCode = await followRedirectsForCode(session, respC.request?.res?.responseUrl || consentUrl);
        }
      }
    } catch (error: any) {
      const match = error?.message?.match(/(https?:\/\/localhost[^\s'"]+)/);
      if (match) {
        authCode = extractCodeFromUrl(match[1]);
      }
    }

    if (!authCode) {
      console.warn('[登录] 未能获取 auth_code');
      return null;
    }

    // Step F: code 换 token
    console.log('[登录] Step F: code 换 token');

    try {
      const respTok = await createHttpClient({ proxy }).post(
        `${OPENAI_AUTH_BASE}/oauth/token`,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: OAUTH_REDIRECT_URI,
          client_id: OAUTH_CLIENT_ID,
          code_verifier: codeVerifier,
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 60000,
        }
      );

      if (respTok.status === 200) {
        const data = respTok.data as any;
        const accessToken = data.access_token || '';
        if (accessToken) {
          console.log('[登录] access_token 获取成功');
          return accessToken;
        }
      }

      console.warn('[登录] token 交换失败: HTTP', respTok.status);
    } catch (error) {
      console.warn('[登录] token 交换异常:', error instanceof Error ? error.message : error);
    }
  } catch (error) {
    console.warn('[登录] 异常:', error instanceof Error ? error.message : error);
  }

  return null;
}

// ============================================================
// 结果保存
// ============================================================
import { writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function saveResult(email: string, emailJwt: string, password: string, accessToken: string): void {
  const line = `${email}|${emailJwt}|${password}|${accessToken}\n`;
  appendFileSync(join(__dirname, '..', RESULTS_FILE()), line, 'utf-8');
  console.log('已保存:', email, '→', RESULTS_FILE());
}

// ============================================================
// 单账号完整流程
// ============================================================
async function processOne(proxy: string = ''): Promise<boolean> {
  // 1. 创建临时邮箱
  const { email, jwt } = await createTempEmail(httpSession, getConfig().temp_mail);
  if (!email) {
    console.error('创建临时邮箱失败，跳过');
    return false;
  }

  const password = generateRandomPassword();
  console.log('='.repeat(50));
  console.log('邮箱:', email);

  // 2. 注册
  const reg = new Registrar(proxy);
  const emailJwt = jwt || '';
  const registered = await reg.register(email, emailJwt, password);

  if (!registered) {
    console.error('注册失败:', email);
    return false;
  }
  console.log('注册成功:', email);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 3. 登录获取 access_token（最多重试 3 次）
  let accessToken: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    accessToken = await oauthLogin(email, password, emailJwt, proxy);
    if (accessToken) break;

    if (attempt < 3) {
      console.warn(`登录第 ${attempt} 次失败，15s 后重试...`);
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }

  if (!accessToken) {
    console.warn('获取 access_token 失败（注册已成功）:', email);
    // 仍保存邮箱和 jwt，access_token 留空
    saveResult(email, emailJwt, password, '');
    return false;
  }

  // 4. 保存
  saveResult(email, emailJwt, password, accessToken);
  console.log('完成:', email);
  return true;
}

// ============================================================
// 批量入口
// ============================================================
import { randomInt } from 'crypto';

async function run(): Promise<void> {
  console.log('='.repeat(50));
  console.log('开始批量处理，目标数量:', TOTAL_ACCOUNTS());
  console.log('结果将保存到:', RESULTS_FILE());
  console.log('='.repeat(50));

  // 清空结果文件
  writeFileSync(join(__dirname, '..', RESULTS_FILE()), '', 'utf-8');

  let success = 0;
  let fail = 0;

  for (let i = 0; i < TOTAL_ACCOUNTS(); i++) {
    console.log(`\n[${i + 1}/${TOTAL_ACCOUNTS()}] 开始处理`);
    const ok = await processOne(PROXY());

    if (ok) {
      success++;
    } else {
      fail++;
    }

    console.log(
      `进度: ${i + 1}/${TOTAL_ACCOUNTS()} | 成功: ${success} | 失败: ${fail}`
    );

    if (i < TOTAL_ACCOUNTS() - 1) {
      const wait = randomInt(5, 16);
      console.log(`等待 ${wait}s...`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  }

  console.log('='.repeat(50));
  console.log(`完成 | 总计: ${TOTAL_ACCOUNTS()} | 成功: ${success} | 失败: ${fail}`);
  console.log('='.repeat(50));
}

// ============================================================
// 主入口
// ============================================================
run().catch((error) => {
  console.error('运行出错:', error);
  process.exit(1);
});

// ============================================================
// 导出（供 batch-register.ts 使用）
// ============================================================
export { Registrar, oauthLogin, createTempEmail, waitForOTP, generateRandomPassword };
