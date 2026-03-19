/**
 * codex-cpa-upload.ts
 * ====================
 * Codex 认证 + CPA 上传脚本
 * 用法：单独指定 GPT 账号信息，获取 Codex Token 并上传到 CPA
 *
 * 使用方式：
 * 1. CLI: npm run codex-cpa <email> <password> [team-index]
 * 2. API: POST /api/codex-cpa/upload
 */

import { readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import {
  motherLogin,
  codexOAuth,
  uploadToCPA,
  oauthLogin,
} from './core/index.js';
import { loadConfig } from './config.js';
import type { TeamConfig } from './types/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// 类型定义
// ============================================================
export interface GPTAccount {
  email: string;
  password: string;
}

export interface CodexUploadResult {
  email: string;
  codexToken?: string;
  cpaUploaded: boolean;
  message: string;
  timestamp: string;
}

export interface UploadOptions {
  account: GPTAccount;
  teamIndex?: number;
  useDirect?: boolean;
}

// ============================================================
// 结果保存
// ============================================================
const RESULTS_FILE = join(__dirname, '../codex-cpa-results.txt');

function saveResult(result: CodexUploadResult): void {
  const line = `${result.email}|${result.codexToken || ''}|${result.cpaUploaded}|${result.timestamp}|${result.message}\n`;
  appendFileSync(RESULTS_FILE, line, 'utf-8');
  console.log('已保存结果:', result.email, '→', RESULTS_FILE);
}

// ============================================================
// 核心流程
// ============================================================
/**
 * Codex 认证 + CPA 上传（使用车头）
 */
export async function codexCPAUpload(
  team: TeamConfig,
  childAccount: GPTAccount
): Promise<CodexUploadResult> {
  console.log('='.repeat(60));
  console.log(`开始处理账号: ${childAccount.email}`);
  console.log(`使用车头: ${team.name} (${team.email})`);
  console.log('='.repeat(60));

  const result: CodexUploadResult = {
    email: childAccount.email,
    codexToken: undefined,
    cpaUploaded: false,
    message: '',
    timestamp: new Date().toISOString(),
  };

  try {
    // 1. 登录车头获取信息
    console.log('[步骤 1] 登录车头获取 account_id 和 auth_token');
    const teamInfo = await motherLogin(team);

    if (!teamInfo?.accountId || !teamInfo?.authToken) {
      result.message = '车头登录失败，无法获取 account_id 或 auth_token';
      console.error('[错误]', result.message);
      return result;
    }

    console.log('[步骤 1] 载头登录成功');
    console.log(`  - account_id: ${teamInfo.accountId}`);
    console.log(`  - auth_token: ${teamInfo.authToken.slice(0, 20)}...`);

    // 2. Codex OAuth 授权
    console.log('[步骤 2] Codex OAuth 授权');
    const codexToken = await codexOAuth(
      teamInfo.accountId,
      teamInfo.authToken,
      childAccount.email,
      childAccount.password
    );

    if (!codexToken) {
      result.message = 'Codex 授权失败';
      console.warn('[警告]', result.message);
      return result;
    }

    result.codexToken = codexToken;
    console.log('[步骤 2] Codex 授权成功');
    console.log(`  - codex_token: ${codexToken.slice(0, 20)}...`);

    // 3. 上传到 CPA
    console.log('[步骤 3] 上传到 CPA');
    const uploaded = await uploadToCPA(
      childAccount.email,
      childAccount.password,
      codexToken
    );

    if (!uploaded) {
      result.message = 'CPA 上传失败';
      console.warn('[警告]', result.message);
      return result;
    }

    result.cpaUploaded = true;
    result.message = '成功完成 Codex 授权和 CPA 上传';
    console.log('[步骤 3] CPA 上传成功');

  } catch (error: any) {
    result.message = `异常: ${error.message}`;
    console.error('[错误]', result.message);
  }

  console.log('='.repeat(60));
  console.log(`处理完成: ${result.message}`);
  console.log('='.repeat(60));

  return result;
}

/**
 * Codex 认证 + CPA 上传（使用 access_token，不需要车头）
 */
export async function codexCPAUploadDirect(
  childAccount: GPTAccount
): Promise<CodexUploadResult> {
  console.log('='.repeat(60));
  console.log(`开始处理账号: ${childAccount.email} (直接模式)`);
  console.log('='.repeat(60));

  const config = loadConfig();
  const result: CodexUploadResult = {
    email: childAccount.email,
    codexToken: undefined,
    cpaUploaded: false,
    message: '',
    timestamp: new Date().toISOString(),
  };

  try {
    // 1. 登录获取 access_token
    console.log('[步骤 1] 登录 GPT 账号获取 access_token');
    const accessToken = await oauthLogin(
      childAccount.email,
      childAccount.password,
      '',
      config.proxy || ''
    );

    if (!accessToken) {
      result.message = 'GPT 账号登录失败，无法获取 access_token';
      console.error('[错误]', result.message);
      return result;
    }

    console.log('[步骤 1] 登录成功');
    console.log(`  - access_token: ${accessToken.slice(0, 20)}...`);

    // 2. 上传到 CPA（直接使用 access_token）
    console.log('[步骤 2] 上传到 CPA（使用 access_token）');
    const uploaded = await uploadToCPA(
      childAccount.email,
      childAccount.password,
      accessToken
    );

    if (!uploaded) {
      result.message = 'CPA 上传失败';
      console.warn('[警告]', result.message);
      return result;
    }

    result.cpaUploaded = true;
    result.codexToken = accessToken; // 使用 access_token 作为 codexToken
    result.message = '成功完成登录和 CPA 上传';
    console.log('[步骤 2] CPA 上传成功');

  } catch (error: any) {
    result.message = `异常: ${error.message}`;
    console.error('[错误]', result.message);
  }

  console.log('='.repeat(60));
  console.log(`处理完成: ${result.message}`);
  console.log('='.repeat(60));

  return result;
}

// ============================================================
// 批量处理
// ============================================================
/**
 * 批量 Codex 认证 + CPA 上传（使用车头）
 */
export async function batchCodexCPAUpload(
  team: TeamConfig,
  accounts: GPTAccount[],
  onProgress?: (index: number, total: number, result: CodexUploadResult) => void
): Promise<{ success: CodexUploadResult[]; fail: number }> {
  console.log('='.repeat(60));
  console.log('开始批量 Codex 认证 + CPA 上传');
  console.log(`账号数量: ${accounts.length}`);
  console.log(`使用车头: ${team.name} (${team.email})`);
  console.log('='.repeat(60));

  const results: CodexUploadResult[] = [];
  let failCount = 0;

  for (let i = 0; i < accounts.length; i++) {
    console.log(`\n[${i + 1}/${accounts.length}] 处理账号: ${accounts[i].email}`);

    const result = await codexCPAUpload(team, accounts[i]);

    results.push(result);

    if (result.cpaUploaded) {
      console.log(`✅ 成功`);
    } else {
      console.log(`❌ 失败`);
      failCount++;
    }

    if (onProgress) {
      onProgress(i + 1, accounts.length, result);
    }

    // 稍微延迟
    if (i < accounts.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`批量处理完成 | 总计: ${accounts.length} | 成功: ${results.length - failCount} | 失败: ${failCount}`);
  console.log('='.repeat(60));

  return { success: results, fail: failCount };
}

/**
 * 批量 Codex 认证 + CPA 上传（直接模式）
 */
export async function batchCodexCPAUploadDirect(
  accounts: GPTAccount[],
  onProgress?: (index: number, total: number, result: CodexUploadResult) => void
): Promise<{ success: CodexUploadResult[]; fail: number }> {
  console.log('='.repeat(60));
  console.log('开始批量登录 + CPA 上传（直接模式）');
  console.log(`账号数量: ${accounts.length}`);
  console.log('='.repeat(60));

  const results: CodexUploadResult[] = [];
  let failCount = 0;

  for (let i = 0; i < accounts.length; i++) {
    console.log(`\n[${i + 1}/${accounts.length}] 处理账号: ${accounts[i].email}`);

    const result = await codexCPAUploadDirect(accounts[i]);

    results.push(result);

    if (result.cpaUploaded) {
      console.log(`✅ 成功`);
    } else {
      console.log(`❌ 失败`);
      failCount++;
    }

    if (onProgress) {
      onProgress(i + 1, accounts.length, result);
    }

    // 稍微延迟
    if (i < accounts.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`批量处理完成 | 总计: ${accounts.length} | 成功: ${results.length - failCount} | 失败: ${failCount}`);
  console.log('='.repeat(60));

  return { success: results, fail: failCount };
}

// ============================================================
// CLI 入口（独立运行时使用）
// ============================================================
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const TEAMS: TeamConfig[] = config.teams || [];

  // 从命令行参数读取账号信息
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('用法: npm run codex-cpa <email> <password> [team-index]');
    console.error('或: npm run codex-cpa <email> <password> --direct');
    process.exit(1);
  }

  const email = args[0];
  const password = args[1];
  const useDirect = args.includes('--direct');

  if (!email || !password) {
    console.error('错误: 邮箱和密码不能为空');
    process.exit(1);
  }

  const account: GPTAccount = { email, password };

  if (useDirect) {
    // 直接模式：不需要车头
    console.log('\n使用直接模式：登录 → CPA 上传\n');
    codexCPAUploadDirect(account)
      .then((result) => {
        saveResult(result);
        process.exit(result.cpaUploaded ? 0 : 1);
      })
      .catch((error) => {
        console.error('执行失败:', error);
        process.exit(1);
      });
  } else {
    // 使用车头模式
    const teamIndex = parseInt(args[2] || '0');
    const team = TEAMS[teamIndex];

    if (!team) {
      console.error(`错误: 车头索引 ${teamIndex} 不存在`);
      console.error('可用的车头:');
      TEAMS.forEach((t, i) => {
        console.log(`  [${i}] ${t.name} (${t.email})`);
      });
      process.exit(1);
    }

    console.log(`\n使用车头模式：车头 ${team.name} → Codex 认证 → CPA 上传\n`);
    codexCPAUpload(team, account)
      .then((result) => {
        saveResult(result);
        process.exit(result.cpaUploaded ? 0 : 1);
      })
      .catch((error) => {
        console.error('执行失败:', error);
        process.exit(1);
      });
  }
}
