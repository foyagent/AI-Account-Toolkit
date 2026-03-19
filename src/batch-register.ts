/**
 * batch-register.ts
 * ================
 * 批量注册脚本（纯注册版本）
 * 只做注册 + 获取 access_token，不涉及车头、邀请、授权等
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
  createTempEmail,
  generateRandomPassword,
} from './core/index.js';
import { createHttpClient } from './utils/http.js';

import type { TeamConfig, AppConfig } from './types/config.js';
import type { AccountData } from './types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// 类型定义
// ============================================================
export interface BatchConfig {
  total: number;
  delayMin?: number; // 最小延迟（秒）
  delayMax?: number; // 最大延迟（秒）
}

export interface BatchProgress {
  current: number;
  total: number;
  success: number;
  fail: number;
  currentEmail?: string;
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
const PROXY = config.proxy || '';
const TEMP_MAIL_CONFIG = config.temp_mail;

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

// ============================================================
// 进度回调
// ============================================================
type ProgressCallback = (progress: BatchProgress) => void;

// ============================================================
// 批量注册核心逻辑
// ============================================================
/**
 * 注册单个账号（纯注册）
 */
async function registerOneAccount(
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

    // 1. 创建临时邮箱
    log(`[步骤 1] 创建临时邮箱...`);
    const httpSession = createHttpClient({ proxy: PROXY });
    const { email: tempEmail, jwt } = await createTempEmail(httpSession, TEMP_MAIL_CONFIG);

    if (!tempEmail) {
      log('[错误] 创建临时邮箱失败');
      return null;
    }

    const password = generateRandomPassword();
    log(`[步骤 1] 临时邮箱创建成功: ${tempEmail}`);

    // 2. 注册账号
    log(`[步骤 2] 开始注册流程...`);
    
    log(`[调试] 创建 Registrar 实例，proxy: ${PROXY}`);
    const reg = new Registrar(PROXY);
    const emailJwt = jwt || '';
    log(`[调试] emailJwt: ${emailJwt ? emailJwt.slice(0, 20) + '...' : 'null'}`);

    log(`[调试] 调用 reg.register...`);
    const registered = await reg.register(tempEmail, emailJwt, password);
    log(`[调试] reg.register 返回: ${registered}`);

    if (!registered) {
      log('[错误] 注册失败');
      return null;
    }

    log(`[步骤 2] 注册成功，等待 3s...`);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 3. 登录获取 access_token
    log(`[步骤 3] 登录获取 access_token...`);

    let accessToken: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      accessToken = await oauthLogin(tempEmail, password, emailJwt, PROXY);
      if (accessToken) {
        log(`[步骤 3] access_token 获取成功`);
        break;
      }

      if (attempt < 3) {
        log(`[步骤 3] 登录第 ${attempt} 次失败，15s 后重试...`);
        await new Promise((resolve) => setTimeout(resolve, 15000));
      }
    }

    if (!accessToken) {
      log('[警告] 获取 access_token 失败（注册已成功）');
    }

    // 4. 保存账号信息
    const account: AccountData = {
      email: tempEmail,
      password: password,
      email_jwt: emailJwt,
      access_token: accessToken || undefined,
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
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<{ success: AccountData[]; fail: number }> {
  const {
    total,
    delayMin = 5,
    delayMax = 15,
  } = batchConfig;

  console.log('='.repeat(60));
  console.log('开始批量注册（纯注册版本）');
  console.log(`目标数量: ${total}`);
  console.log(`延迟范围: ${delayMin}-${delayMax} 秒`);
  console.log('='.repeat(60));

  const successAccounts: AccountData[] = [];
  let failCount = 0;

  for (let i = 0; i < total; i++) {
    // 检查是否被取消
    if (signal?.aborted) {
      console.log('批量注册已被取消');
      break;
    }

    // 注册账号
    const account = await registerOneAccount(batchConfig, (logMsg) => {
      // 在注册过程中只推送日志，不推送完整进度
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: total,
          success: successAccounts.length,
          fail: failCount,
          logs: [logMsg],
        });
      }
    });

    if (account) {
      successAccounts.push(account);
    } else {
      failCount++;
    }

    // 注册完成后，推送包含账号信息的进度
    if (onProgress) {
      onProgress({
        current: i + 1,
        total: total,
        success: successAccounts.length,
        fail: failCount,
        currentEmail: account?.email,
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
  };

  batchRegister(batchConfig).catch((error) => {
    console.error('批量注册失败:', error);
    process.exit(1);
  });
}
