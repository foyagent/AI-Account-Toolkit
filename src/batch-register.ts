/**
 * batch-register.ts
 * ================
 * 批量注册胶水脚本
 * 复用核心注册逻辑，实现批量注册子号功能
 */

import { randomInt } from 'crypto';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import yaml from 'yaml';

import {
  Registrar,
  oauthLogin,
  motherLogin,
  sendTeamInvite,
  codexOAuth,
  uploadToCPA,
  createTempEmail,
  waitForOTP,
  generateRandomPassword,
} from './core/index.js';

import type { TeamConfig, AppConfig } from './types/config.js';
import type { AccountData } from './types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// 类型定义
// ============================================================
export interface BatchConfig {
  total: number;
  teamIndex?: number; // 指定使用哪个车头，不指定则轮询
  delayMin?: number; // 最小延迟（秒）
  delayMax?: number; // 最大延迟（秒）
  enableInvite?: boolean; // 是否发送团队邀请
  enableCodex?: boolean; // 是否授权 Codex
  enableCPA?: boolean; // 是否上传到 CPA
}

export interface BatchProgress {
  current: number;
  total: number;
  success: number;
  fail: number;
  currentEmail?: string;
  currentTeam?: string;
  logs: string[];
}

// ============================================================
// 配置加载
// ============================================================
function loadConfig(): AppConfig {
  const configPath = join(__dirname, '../config.yaml');
  const content = readFileSync(configPath, 'utf-8');
  return yaml.parse(content);
}

const config = loadConfig();
const TEAMS: TeamConfig[] = config.teams || [];
const PROXY = config.proxy || '';
const TEMP_MAIL_CONFIG = config.temp_mail;
const CLI_PROXY = config.cli_proxy;

// ============================================================
// 数据库文件
// ============================================================
const ACCOUNTS_DB_PATH = join(__dirname, '../accounts_db.json');

/**
 * 加载账号数据库
 */
function loadAccountsDB(): AccountData[] {
  if (!existsSync(ACCOUNTS_DB_PATH)) {
    return [];
  }
  const content = readFileSync(ACCOUNTS_DB_PATH, 'utf-8');
  return JSON.parse(content);
}

/**
 * 保存账号到数据库
 */
function saveAccountToDB(account: AccountData): void {
  const accounts = loadAccountsDB();
  accounts.push(account);
  writeFileSync(ACCOUNTS_DB_PATH, JSON.stringify(accounts, null, 2));
}

/**
 * 更新账号状态
 */
function updateAccountInDB(email: string, updates: Partial<AccountData>): void {
  const accounts = loadAccountsDB();
  const index = accounts.findIndex((a) => a.email === email);
  if (index !== -1) {
    accounts[index] = { ...accounts[index], ...updates };
    writeFileSync(ACCOUNTS_DB_PATH, JSON.stringify(accounts, null, 2));
  }
}

// ============================================================
// 进度回调
// ============================================================
type ProgressCallback = (progress: BatchProgress) => void;

// ============================================================
// 批量注册核心逻辑
// ============================================================
/**
 * 注册单个账号
 */
async function registerOneAccount(
  team: TeamConfig,
  batchConfig: BatchConfig,
  onLog?: (message: string) => void
): Promise<AccountData | null> {
  const logs: string[] = [];

  const log = (msg: string) => {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const fullMsg = `[${timestamp}] ${msg}`;
    logs.push(fullMsg);
    console.log(fullMsg);
    if (onLog) onLog(fullMsg);
  };

  try {
    log('='.repeat(60));
    log(`开始注册账号`);

    // 1. 获取车头信息
    log(`[步骤 1] 获取车头信息: ${team.name} (${team.email})`);
    const teamInfo = await motherLogin(team);

    if (!teamInfo?.accountId || !teamInfo?.authToken) {
      log('[错误] 获取车头信息失败');
      return null;
    }

    log(`[步骤 1] 成功获取车头信息: account_id=${teamInfo.accountId}`);

    // 2. 创建临时邮箱
    log(`[步骤 2] 创建临时邮箱...`);
    const { email: tempEmail, jwt } = await createTempEmail(
      { defaults: { proxy: PROXY } } as any,
      TEMP_MAIL_CONFIG
    );

    if (!tempEmail) {
      log('[错误] 创建临时邮箱失败');
      return null;
    }

    const password = generateRandomPassword();
    log(`[步骤 2] 临时邮箱创建成功: ${tempEmail}`);

    // 3. 注册账号
    log(`[步骤 3] 开始注册流程...`);
    const reg = new Registrar(PROXY);
    const emailJwt = jwt || '';

    const registered = await reg.register(tempEmail, emailJwt, password);

    if (!registered) {
      log('[错误] 注册失败');
      return null;
    }

    log(`[步骤 3] 注册成功，等待 3s...`);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 4. 登录获取 access_token
    log(`[步骤 4] 登录获取 access_token...`);

    let accessToken: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      accessToken = await oauthLogin(tempEmail, password, emailJwt, PROXY);
      if (accessToken) {
        log(`[步骤 4] access_token 获取成功`);
        break;
      }

      if (attempt < 3) {
        log(`[步骤 4] 登录第 ${attempt} 次失败，15s 后重试...`);
        await new Promise((resolve) => setTimeout(resolve, 15000));
      }
    }

    if (!accessToken) {
      log('[警告] 获取 access_token 失败（注册已成功）');
    }

    // 5. 发送团队邀请
    if (batchConfig.enableInvite && teamInfo.accountId && teamInfo.authToken) {
      log(`[步骤 5] 发送团队邀请...`);
      const invite = await sendTeamInvite(teamInfo.accountId, teamInfo.authToken, tempEmail);

      if (invite) {
        log(`[步骤 5] 团队邀请发送成功: ${invite.inviteUrl}`);
      } else {
        log(`[警告] 团队邀请发送失败`);
      }
    }

    // 6. Codex OAuth 授权
    let codexToken: string | null = null;
    if (batchConfig.enableCodex && teamInfo.accountId && teamInfo.authToken && accessToken) {
      log(`[步骤 6] Codex OAuth 授权...`);
      codexToken = await codexOAuth(teamInfo.accountId, teamInfo.authToken, tempEmail, password);

      if (codexToken) {
        log(`[步骤 6] Codex 授权成功`);
      } else {
        log(`[警告] Codex 授权失败`);
      }
    }

    // 7. 上传到 CPA
    if (batchConfig.enableCPA && codexToken) {
      log(`[步骤 7] 上传到 CPA...`);
      const uploaded = await uploadToCPA(tempEmail, password, codexToken);

      if (uploaded) {
        log(`[步骤 7] CPA 上传成功`);
      } else {
        log(`[警告] CPA 上传失败`);
      }
    }

    // 8. 保存账号信息
    const account: AccountData = {
      email: tempEmail,
      password: password,
      email_jwt: emailJwt,
      access_token: accessToken || undefined,
      account_id: teamInfo.accountId,
      auth_token: teamInfo.authToken,
      created_at: new Date().toISOString(),
    };

    saveAccountToDB(account);
    log(`[完成] 账号信息已保存到数据库`);

    return account;

  } catch (error: any) {
    log(`[错误] ${error.message}`);
    return null;
  }
}

/**
 * 批量注册入口
 */
export async function batchRegister(
  batchConfig: BatchConfig,
  onProgress?: ProgressCallback
): Promise<{ success: AccountData[]; fail: number }> {
  const {
    total,
    teamIndex,
    delayMin = 5,
    delayMax = 15,
    enableInvite = true,
    enableCodex = true,
    enableCPA = true,
  } = batchConfig;

  console.log('='.repeat(60));
  console.log('开始批量注册');
  console.log(`目标数量: ${total}`);
  console.log(`车头数量: ${TEAMS.length}`);
  console.log(`延迟范围: ${delayMin}-${delayMax} 秒`);
  console.log('='.repeat(60));

  const successAccounts: AccountData[] = [];
  let failCount = 0;

  for (let i = 0; i < total; i++) {
    // 选择车头
    const teamIdx = teamIndex !== undefined ? teamIndex : i % TEAMS.length;
    const team = TEAMS[teamIdx];

    if (!team) {
      console.error(`[错误] 车头不存在: index=${teamIdx}`);
      failCount++;
      continue;
    }

    // 注册账号
    const account = await registerOneAccount(team, batchConfig, (logMsg) => {
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: total,
          success: successAccounts.length,
          fail: failCount,
          currentEmail: account?.email,
          currentTeam: team.name,
          logs: [logMsg],
        });
      }
    });

    if (account) {
      successAccounts.push(account);
    } else {
      failCount++;
    }

    // 更新进度
    if (onProgress) {
      onProgress({
        current: i + 1,
        total: total,
        success: successAccounts.length,
        fail: failCount,
        currentEmail: account?.email,
        currentTeam: team.name,
        logs: [],
      });
    }

    // 延迟
    if (i < total - 1) {
      const delay = randomInt(delayMin, delayMax);
      console.log(`等待 ${delay}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  }

  console.log('='.repeat(60));
  console.log(`批量注册完成 | 总计: ${total} | 成功: ${successAccounts.length} | 失败: ${failCount}`);
  console.log('='.repeat(60));

  return { success: successAccounts, fail: failCount };
}

// ============================================================
// CLI 入口（独立运行时使用）
// ============================================================
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const batchConfig: BatchConfig = {
    total: config.total_accounts || 1,
    delayMin: 5,
    delayMax: 15,
    enableInvite: true,
    enableCodex: true,
    enableCPA: config.cli_proxy?.upload_enabled ?? true,
  };

  batchRegister(batchConfig).catch((error) => {
    console.error('批量注册失败:', error);
    process.exit(1);
  });
}
