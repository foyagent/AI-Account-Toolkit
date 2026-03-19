/**
 * core/oauth.ts
 * ============
 * OAuth 登录函数
 */

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { createHttpClient, getCommonHeaders, getNavigateHeaders, USER_AGENT, OPENAI_AUTH_BASE } from '../utils/http.js';
import { generatePKCE } from '../utils/pkce.js';
import { generateDatadogTrace } from '../utils/datadog.js';
import { buildSentinelToken } from '../utils/sentinel.js';
import { fetchEmailsList, extractOTP } from '../utils/temp-mail.js';
import { generateRandomName, generateRandomBirthday } from '../utils/random.js';
import { loadConfig } from '../config.js';
import type { AxiosInstance } from 'axios';

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';

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
    const match = error?.message?.match(/(https?:\/\/localhost[^\s'"]+)/);
    if (match) {
      return extractCodeFromUrl(match[1]);
    }
  }

  return null;
}

/**
 * OAuth 登录获取 access_token
 */
export async function oauthLogin(
  email: string,
  password: string,
  jwtToken: string,
  proxy: string = ''
): Promise<string | null> {
  const session = createHttpClient({ proxy });
  const deviceId = uuidv4();
  const config = loadConfig();
  const TEMP_MAIL_WORKER_DOMAIN = config.temp_mail.worker_domain;
  const httpSession = session;

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

      const sentinelOtp = await buildSentinelToken(session, deviceId, 'email_otp');
      if (sentinelOtp) h_v['openai-sentinel-token'] = sentinelOtp;

      try {
        await session.post(`${OPENAI_AUTH_BASE}/api/accounts/email-otp/init`, {}, { headers: h_v });
      } catch {
        // Ignore
      }

      const tried = new Set<string>();
      const startTime = Date.now();
      let got = false;

      while (Date.now() - startTime < 120000) {
        const emails = await fetchEmailsList(httpSession, TEMP_MAIL_WORKER_DOMAIN, jwtToken);

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
