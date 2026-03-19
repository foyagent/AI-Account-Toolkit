/**
 * core/team.ts
 * ============
 * 车头管理相关函数
 */

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { createHttpClient, getCommonHeaders, getNavigateHeaders, OPENAI_AUTH_BASE } from '../utils/http.js';
import { generatePKCE } from '../utils/pkce.js';
import { generateDatadogTrace } from '../utils/datadog.js';
import { buildSentinelToken } from '../utils/sentinel.js';
import { fetchEmailsList, extractOTP } from '../utils/temp-mail.js';
import { loadConfig } from '../config.js';
import type { TeamConfig } from '../types/config.js';

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OAUTH_SCOPE = 'openid profile email offline_access';

/**
 * 母号 OAuth 登录获取 account_id 和 auth_token
 */
export async function motherLogin(team: TeamConfig): Promise<{ accountId?: string; authToken?: string } | null> {
  const session = createHttpClient({ proxy: loadConfig().proxy || '' });
  const deviceId = uuidv4();
  const TEMP_MAIL_WORKER_DOMAIN = loadConfig().temp_mail.worker_domain;

  const cookieJar = session.defaults.jar as any;
  if (cookieJar) {
    cookieJar.setCookieSync(`oai-did=${deviceId}`, OPENAI_AUTH_BASE);
    cookieJar.setCookieSync(`oai-did=${deviceId}`, 'auth.openai.com');
  }

  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = uuidv4();

  // 简化的 OAuth 流程
  try {
    await session.get(
      `${OPENAI_AUTH_BASE}/oauth/authorize?response_type=code&client_id=${OAUTH_CLIENT_ID}&redirect_uri=${OAUTH_REDIRECT_URI}&scope=${encodeURIComponent(OAUTH_SCOPE)}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`,
      { headers: getNavigateHeaders(), maxRedirects: 5 }
    );

    let h: Record<string, string> = {
      ...getCommonHeaders(),
      referer: `${OPENAI_AUTH_BASE}/log-in`,
      'oai-device-id': deviceId,
    };
    Object.assign(h, generateDatadogTrace());

    const sentinel = await buildSentinelToken(session, deviceId, 'authorize_continue');
    if (sentinel) h['openai-sentinel-token'] = sentinel;

    const response = await session.post(
      `${OPENAI_AUTH_BASE}/api/accounts/authorize/continue`,
      { username: { kind: 'email', value: team.email } },
      { headers: h }
    );

    if (response.status !== 200) {
      console.warn('[母号登录] Step B 失败: HTTP', response.status);
      return null;
    }

    let continueUrl = response.data?.continue_url || '';
    let pageType = response.data?.page?.type || '';

    // Step C: 提交密码
    h['referer'] = `${OPENAI_AUTH_BASE}/log-in/password`;
    Object.assign(h, generateDatadogTrace());

    const sentinel2 = await buildSentinelToken(session, deviceId, 'password_verify');
    if (sentinel2) h['openai-sentinel-token'] = sentinel2;

    const responseC = await session.post(
      `${OPENAI_AUTH_BASE}/api/accounts/password/verify`,
      { password: team.password },
      { headers: h, maxRedirects: 0 }
    );

    if (responseC.status !== 200) {
      console.warn('[母号登录] Step C 失败: HTTP', responseC.status);
      return null;
    }

    continueUrl = responseC.data?.continue_url || continueUrl;
    pageType = responseC.data?.page?.type || pageType;

    // Step D: OTP 验证（如果需要）
    if (pageType === 'email_otp_verification' || continueUrl.includes('email-verification')) {
      console.log('[母号登录] 需要 OTP 验证');

      if (!team.jwt) {
        console.warn('[母号登录] 无 jwt_token，无法获取 OTP');
        return null;
      }

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
        const emails = await fetchEmailsList(session, TEMP_MAIL_WORKER_DOMAIN, team.jwt);

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
              console.log('[母号登录] OTP 验证成功:', c);
              break;
            }
          }
        }

        if (got) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      if (!got) {
        console.warn('[母号登录] OTP 超时');
        return null;
      }
    }

    // Step E: 获取 account_id 和 auth_token
    if (!continueUrl) {
      console.warn('[母号登录] 无 continue_url');
      return null;
    }

    const consentUrl = continueUrl.startsWith('http') ? continueUrl : `${OPENAI_AUTH_BASE}${continueUrl}`;

    try {
      const respC = await session.get(consentUrl, {
        headers: getNavigateHeaders(),
        maxRedirects: 0,
      });

      if ([301, 302, 303, 307, 308].includes(respC.status)) {
        const loc = respC.headers['location'] || '';
        const codeMatch = loc.match(/[?&]code=([^&]+)/);
        if (codeMatch) {
          const code = codeMatch[1];

          // code 换 token
          const respTok = await createHttpClient({ proxy: loadConfig().proxy || '' }).post(
            `${OPENAI_AUTH_BASE}/oauth/token`,
            new URLSearchParams({
              grant_type: 'authorization_code',
              code: code,
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
              const apiResp = await axios.get('https://api.openai.com/v1/organizations', {
                headers: { Authorization: `Bearer ${accessToken}` },
              });

              if (apiResp.data?.data?.length > 0) {
                const accountId = apiResp.data.data[0].id;
                return { accountId, authToken: accessToken };
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn('[母号登录] 异常:', error instanceof Error ? error.message : error);
    }

    return null;
  } catch (error) {
    console.warn('[母号登录] 异常:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * 发送团队邀请
 */
export async function sendTeamInvite(
  accountId: string,
  authToken: string,
  childEmail: string
): Promise<{ inviteId?: string; inviteUrl?: string } | null> {
  try {
    const response = await axios.post(
      `https://api.openai.com/v1/organizations/${accountId}/invites`,
      {
        email: childEmail,
        role: 'member',
      },
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.status === 200 || response.status === 201) {
      const data = response.data as any;
      return {
        inviteId: data.id,
        inviteUrl: data.accept_link,
      };
    }

    console.warn('[邀请] 发送失败: HTTP', response.status);
    return null;
  } catch (error) {
    console.warn('[邀请] 异常:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Codex OAuth 授权
 */
export async function codexOAuth(
  accountId: string,
  authToken: string,
  childEmail: string,
  childPassword: string
): Promise<string | null> {
  console.log(`[Codex] 开始 OAuth 授权: ${childEmail}`);

  try {
    const codexAuthUrl = `https://api.openai.com/v1/organizations/${accountId}/codex/authorize`;
    const response = await axios.post(
      codexAuthUrl,
      {
        account_id: accountId,
      },
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.status === 200) {
      const data = response.data as any;
      return data.access_token || data.token || '';
    }

    console.warn('[Codex] 授权失败: HTTP', response.status);
    return null;
  } catch (error) {
    console.warn('[Codex] 异常:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * 上传到 CPA
 */
export async function uploadToCPA(
  email: string,
  password: string,
  codexToken: string
): Promise<boolean> {
  const config = loadConfig();
  const CLI_PROXY_API_BASE = config.cli_proxy?.api_base?.rstrip('/') || '';
  const CLI_PROXY_PASSWORD = config.cli_proxy?.password || '';
  const CPA_UPLOAD_ENABLED = config.cli_proxy?.upload_enabled ?? true;

  if (!CPA_UPLOAD_ENABLED) {
    console.log('[CPA] 上传已禁用');
    return true;
  }

  if (!CLI_PROXY_API_BASE || !CLI_PROXY_PASSWORD) {
    console.warn('[CPA] 未配置 CPA API');
    return false;
  }

  console.log(`[CPA] 上传账号: ${email}`);

  try {
    const response = await axios.post(
      `${CLI_PROXY_API_BASE}/api/accounts`,
      {
        email: email,
        password: password,
        access_token: codexToken,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CLI_PROXY_PASSWORD}`,
        },
      }
    );

    if (response.status === 200 || response.status === 201) {
      console.log(`[CPA] 上传成功: ${email}`);
      return true;
    }

    console.warn('[CPA] 上传失败: HTTP', response.status);
    return false;
  } catch (error) {
    console.warn('[CPA] 异常:', error instanceof Error ? error.message : error);
    return false;
  }
}
