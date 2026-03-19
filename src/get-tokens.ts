/**
 * get-tokens.ts
 * =============
 * CLI 入口：简化版，只做注册 + 获取 access_token
 * 核心逻辑在 core/ 目录
 */

import { writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { randomInt } from 'crypto';
import {
  Registrar,
  oauthLogin,
  createTempEmail,
  waitForOTP,
  generateRandomPassword,
} from './core/index.js';
import { loadConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// 结果保存
// ============================================================
function saveResult(email: string, emailJwt: string, password: string, accessToken: string): void {
  const config = loadConfig();
  const RESULTS_FILE = config.output.results_file;
  const line = `${email}|${emailJwt}|${password}|${accessToken}\n`;
  appendFileSync(join(__dirname, '..', RESULTS_FILE), line, 'utf-8');
  console.log('已保存:', email, '→', RESULTS_FILE);
}

// ============================================================
// 单账号完整流程
// ============================================================
async function processOne(proxy: string = ''): Promise<boolean> {
  const config = loadConfig();
  const httpSession = { defaults: { proxy: config.proxy || '' } };

  // 1. 创建临时邮箱
  const { email, jwt } = await createTempEmail(httpSession, config.temp_mail);
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
async function run(): Promise<void> {
  const config = loadConfig();
  const TOTAL_ACCOUNTS = config.total_accounts;
  const RESULTS_FILE = config.output.results_file;
  const PROXY = config.proxy || '';

  console.log('='.repeat(50));
  console.log('开始批量处理，目标数量:', TOTAL_ACCOUNTS);
  console.log('结果将保存到:', RESULTS_FILE);
  console.log('='.repeat(50));

  // 清空结果文件
  writeFileSync(join(__dirname, '..', RESULTS_FILE), '', 'utf-8');

  let success = 0;
  let fail = 0;

  for (let i = 0; i < TOTAL_ACCOUNTS; i++) {
    console.log(`\n[${i + 1}/${TOTAL_ACCOUNTS}] 开始处理`);
    const ok = await processOne(PROXY);

    if (ok) {
      success++;
    } else {
      fail++;
    }

    console.log(
      `进度: ${i + 1}/${TOTAL_ACCOUNTS} | 成功: ${success} | 失败: ${fail}`
    );

    if (i < TOTAL_ACCOUNTS - 1) {
      const wait = randomInt(5, 16);
      console.log(`等待 ${wait}s...`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  }

  console.log('='.repeat(50));
  console.log(`完成 | 总计: ${TOTAL_ACCOUNTS} | 成功: ${success} | 失败: ${fail}`);
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
