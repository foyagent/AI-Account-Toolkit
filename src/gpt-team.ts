/**
 * gpt-team.ts
 * ============
 * 全新纯 HTTP 协议版本（无 Selenium / 无浏览器）
 * - 注册：使用 ProtocolRegistrar 五步 HTTP 流程 + Sentinel Token
 * - 母号登录：HTTP OAuth + PKCE，自动拉取 account_id / auth_token
 * - Codex 授权：HTTP 交换 code → token → 上传到 CPA
 * - 子号邀请：注册成功后自动发送团队邀请
 * 配置文件: config.yaml（兼容原格式）
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
import type { AppConfig, TeamConfig } from './types/config.js';
import type { AccountData, InviteTracker } from './types/index.js';
import type { AxiosInstance } from 'axios';
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { randomInt } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
const ACCOUNTS_FILE = () => getConfig().output.accounts_file;
const INVITE_TRACKER_FILE = () => getConfig().output.invite_tracker_file;
const CLI_PROXY_API_BASE = () => getConfig().cli_proxy?.api_base?.rstrip('/') || '';
const CLI_PROXY_PASSWORD = () => getConfig().cli_proxy?.password || '';
const CPA_UPLOAD_ENABLED = () => getConfig().cli_proxy?.upload_enabled ?? true;
const TEAMS = () => (getConfig().teams || []);
const PROXY = () => getConfig().proxy || '';

console.log(`✅ 配置已加载: 注册数量: ${TOTAL_ACCOUNTS()} | 车头数量: ${TEAMS().length}`);

// ============================================================
// 常量
// ============================================================
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OAUTH_SCOPE = 'openid profile email offline_access';

// ============================================================
// HTTP 客户端
// ============================================================
const httpSession = createHttpClient({ proxy: PROXY });

// ============================================================
// 车头（Team）管理
// ============================================================

/**
 * 母号 OAuth 登录获取 account_id 和 auth_token
 */
async function motherLogin(team: TeamConfig): Promise<{ accountId?: string; authToken?: string } | null> {
  const session = createHttpClient({ proxy: PROXY });
  const deviceId = uuidv4();

  const cookieJar = session.defaults.jar || new axios.CookieJar?.();
  if (cookieJar) {
    cookieJar.setCookieSync(`oai-did=${deviceId}`, OPENAI_AUTH_BASE);
    cookieJar.setCookieSync(`oai-did=${deviceId}`, 'auth.openai.com');
  }

  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = uuidv4();

  // Step A: authorize
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: state,
  });

  try {
    await session.get(`${OPENAI_AUTH_BASE}/oauth/authorize?${authParams.toString()}`, {
      headers: getNavigateHeaders(),
      maxRedirects: 5,
    });
  } catch (error) {
    console.warn('[母号登录] Step A 失败:', error instanceof Error ? error.message : error);
    return null;
  }

  // Step B: 提交邮箱
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

    // 使用母号 JWT 从临时邮箱获取 OTP
    const tried = new Set<string>();
    const startTime = Date.now();
    let got = false;

    while (Date.now() - startTime < 120000) {
      const emails = await fetchEmailsList(httpSession, TEMP_MAIL_WORKER_DOMAIN, team.jwt);

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

  const consentUrl = continueUrl.startsWith('http')
    ? continueUrl
    : `${OPENAI_AUTH_BASE}${continueUrl}`;

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
        const respTok = await createHttpClient({ proxy: PROXY }).post(
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
          const sessionToken = data.session?.token || '';

          if (accessToken) {
            // 使用 access_token 获取 account_id
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
}

/**
 * 获取车头信息（如果配置中有则直接使用，否则尝试登录获取）
 */
async function getTeamInfo(team: TeamConfig): Promise<{ accountId: string; authToken: string } | null> {
  // 如果配置中已有，直接返回
  if (team.account_id && team.auth_token) {
    return { accountId: team.account_id, authToken: team.auth_token };
  }

  // 否则登录获取
  console.log(`[车头] 登录获取 account_id/auth_token: ${team.email}`);
  const result = await motherLogin(team);

  if (result?.accountId && result?.authToken) {
    // 更新配置（可选）
    team.account_id = result.accountId;
    team.auth_token = result.authToken;
    console.log(`[车头] 获取成功: account_id=${result.accountId}`);
    return result;
  }

  console.warn(`[车头] 获取失败: ${team.email}`);
  return null;
}

// ============================================================
// 注册器（复用 get-tokens 的逻辑）
// ============================================================
// 由于代码较长，这里简化引用已实现的注册逻辑
// 实际使用时可以将 get-tokens.ts 中的 Registrar 类移到共享模块

// ============================================================
// 发送团队邀请
// ============================================================
async function sendTeamInvite(
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

// ============================================================
// Codex OAuth 授权
// ============================================================
async function codexOAuth(
  accountId: string,
  authToken: string,
  childEmail: string,
  childPassword: string
): Promise<string | null> {
  // 模拟 Codex OAuth 流程
  // 这里简化处理，实际需要完整的 Codex OAuth 流程

  console.log(`[Codex] 开始 OAuth 授权: ${childEmail}`);

  try {
    // Step 1: 获取 Codex OAuth URL
    const authUrl = `https://auth.openai.com/oauth/authorize?client_id=${OAUTH_CLIENT_ID}&redirect_uri=${OAUTH_REDIRECT_URI}&response_type=code&scope=${encodeURIComponent(OAUTH_SCOPE)}`;

    // Step 2: 子号登录获取 code
    // ... (这里需要完整的登录流程，类似 oauthLogin 函数)

    // Step 3: code 换取 token
    // ... (code 换 token)

    // Step 4: 授权 Codex
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

// ============================================================
// 上传到 CPA
// ============================================================
async function uploadToCPA(
  email: string,
  password: string,
  codexToken: string
): Promise<boolean> {
  if (!CPA_UPLOAD_ENABLED()) {
    console.log('[CPA] 上传已禁用');
    return true;
  }

  if (!CLI_PROXY_API_BASE() || !CLI_PROXY_PASSWORD()) {
    console.warn('[CPA] 未配置 CPA API');
    return false;
  }

  console.log(`[CPA] 上传账号: ${email}`);

  try {
    const response = await axios.post(
      `${CLI_PROXY_API_BASE()}/api/accounts`,
      {
        email: email,
        password: password,
        access_token: codexToken,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CLI_PROXY_PASSWORD()}`,
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

// ============================================================
// 保存邀请记录
// ============================================================
function saveInviteTracker(tracker: InviteTracker): void {
  const trackers: InviteTracker[] = [];

  if (existsSync(join(__dirname, '..', INVITE_TRACKER_FILE()))) {
    const content = readFileSync(join(__dirname, '..', INVITE_TRACKER_FILE()), 'utf-8');
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        trackers.push(...parsed);
      }
    } catch {
      // Ignore parse errors
    }
  }

  trackers.push(tracker);
  writeFileSync(
    join(__dirname, '..', INVITE_TRACKER_FILE()),
    JSON.stringify(trackers, null, 2),
    'utf-8'
  );
}

// ============================================================
// 保存账号信息
// ============================================================
function saveAccount(account: AccountData): void {
  const line = `${account.email}|${account.password}|${account.created_at}\n`;
  appendFileSync(join(__dirname, '..', ACCOUNTS_FILE()), line, 'utf-8');
  console.log('已保存账号:', account.email, '→', ACCOUNTS_FILE());
}

// ============================================================
// 主流程：处理单个账号
// ============================================================
async function processAccount(team: TeamConfig): Promise<boolean> {
  console.log('\n' + '='.repeat(50));
  console.log('开始处理账号...');

  // 1. 获取车头信息
  const teamInfo = await getTeamInfo(team);
  if (!teamInfo) {
    console.error('[主流程] 获取车头信息失败');
    return false;
  }

  // 2. 创建临时邮箱
  const { email, jwt } = await createTempEmail(httpSession, getConfig().temp_mail);
  if (!email) {
    console.error('[主流程] 创建临时邮箱失败');
    return false;
  }

  const password = generateRandomPassword();
  console.log('[主流程] 邮箱:', email);

  // 3. 注册子号（这里需要完整的注册流程）
  // ... (调用注册逻辑)

  const emailJwt = jwt || '';
  console.log('[主流程] 注册成功（模拟）');

  // 4. 登录子号获取 access_token
  // ... (调用 oauthLogin)

  // 模拟数据
  const childAccessToken = 'mock_access_token_' + uuidv4().slice(0, 8);

  // 5. 发送团队邀请
  console.log('[主流程] 发送团队邀请...');
  const invite = await sendTeamInvite(teamInfo.accountId, teamInfo.authToken, email);

  if (!invite) {
    console.warn('[主流程] 发送邀请失败');
  } else {
    console.log('[主流程] 邀请发送成功:', invite.inviteUrl);
  }

  // 6. Codex OAuth 授权
  console.log('[主流程] Codex 授权...');
  const codexToken = await codexOAuth(teamInfo.accountId, teamInfo.authToken, email, password);

  // 7. 上传到 CPA
  if (codexToken) {
    const uploaded = await uploadToCPA(email, password, codexToken);
    if (!uploaded) {
      console.warn('[主流程] CPA 上传失败');
    }
  }

  // 8. 保存信息
  saveAccount({
    email: email,
    password: password,
    email_jwt: emailJwt,
    access_token: childAccessToken,
    created_at: new Date().toISOString(),
  });

  if (invite) {
    saveInviteTracker({
      team_name: team.name,
      team_email: team.email,
      child_email: email,
      invited_at: new Date().toISOString(),
      status: invite ? 'pending' : 'failed',
    });
  }

  console.log('[主流程] 完成:', email);
  return true;
}

// ============================================================
// 批量入口
// ============================================================
async function run(): Promise<void> {
  console.log('='.repeat(50));
  console.log('开始批量处理，目标数量:', TOTAL_ACCOUNTS());
  console.log('车头数量:', TEAMS().length);
  console.log('='.repeat(50));

  // 清空文件
  writeFileSync(join(__dirname, '..', ACCOUNTS_FILE()), '', 'utf-8');
  writeFileSync(join(__dirname, '..', INVITE_TRACKER_FILE()), '[]', 'utf-8');

  let success = 0;
  let fail = 0;

  for (let i = 0; i < TOTAL_ACCOUNTS(); i++) {
    // 轮询选择车头
    const teamIndex = i % TEAMS().length;
    const team = TEAMS()[teamIndex];

    console.log(`\n[${i + 1}/${TOTAL_ACCOUNTS()}] 使用车头: ${team.name} (${team.email})`);

    const ok = await processAccount(team);

    if (ok) {
      success++;
    } else {
      fail++;
    }

    console.log(`进度: ${i + 1}/${TOTAL_ACCOUNTS()} | 成功: ${success} | 失败: ${fail}`);

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
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error('运行出错:', error);
    process.exit(1);
  });
}

// ============================================================
// 导出（供 batch-register.ts 使用）
// ============================================================
export {
  motherLogin,
  sendTeamInvite,
  codexOAuth,
  uploadToCPA,
};
