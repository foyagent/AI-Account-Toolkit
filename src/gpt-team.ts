/**
 * gpt-team.ts
 * ============
 * CLI 入口：车头管理
 * 核心逻辑在 core/ 目录
 */

import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { randomInt } from 'crypto';
import {
  Registrar,
  oauthLogin,
  motherLogin,
  sendTeamInvite,
  codexOAuth,
  uploadToCPA,
  createTempEmail,
  generateRandomPassword,
} from './core/index.js';
import { loadConfig } from './config.js';
import type { TeamConfig, AccountData, InviteTracker } from './types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// 主流程：处理单个账号
// ============================================================
async function processAccount(team: TeamConfig): Promise<boolean> {
  const config = loadConfig();
  const httpSession = { defaults: { proxy: config.proxy || '' } };
  const ACCOUNTS_FILE = config.output.accounts_file;
  const INVITE_TRACKER_FILE = config.output.invite_tracker_file;

  console.log('\n' + '='.repeat(50));
  console.log('开始处理账号...');

  // 1. 获取车头信息
  const teamInfo = await motherLogin(team);
  if (!teamInfo) {
    console.error('[主流程] 获取车头信息失败');
    return false;
  }

  // 2. 创建临时邮箱
  const { email, jwt } = await createTempEmail(httpSession, config.temp_mail);
  if (!email) {
    console.error('[主流程] 创建临时邮箱失败');
    return false;
  }

  const password = generateRandomPassword();
  console.log('[主流程] 邮箱:', email);

  // 3. 注册子号
  const reg = new Registrar(config.proxy || '');
  const emailJwt = jwt || '';
  const registered = await reg.register(email, emailJwt, password);

  if (!registered) {
    console.error('[主流程] 注册失败');
    return false;
  }
  console.log('[主流程] 注册成功');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 4. 登录子号获取 access_token
  let accessToken: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    accessToken = await oauthLogin(email, password, emailJwt, config.proxy || '');
    if (accessToken) break;

    if (attempt < 3) {
      console.warn(`登录第 ${attempt} 次失败，15s 后重试...`);
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }

  if (!accessToken) {
    console.warn('[主流程] 获取 access_token 失败');
  }

  // 5. 发送团队邀请
  console.log('[主流程] 发送团队邀请...');
  const invite = await sendTeamInvite(teamInfo.accountId!, teamInfo.authToken!, email);

  if (!invite) {
    console.warn('[主流程] 发送邀请失败');
  } else {
    console.log('[主流程] 邀请发送成功:', invite.inviteUrl);
  }

  // 6. Codex OAuth 授权
  if (accessToken) {
    console.log('[主流程] Codex 授权...');
    const codexToken = await codexOAuth(teamInfo.accountId!, teamInfo.authToken!, email, password);

    if (codexToken) {
      console.log('[主流程] Codex 授权成功');

      // 7. 上传到 CPA
      console.log('[主流程] 上传到 CPA...');
      const uploaded = await uploadToCPA(email, password, codexToken);
      if (!uploaded) {
        console.warn('[主流程] CPA 上传失败');
      }
    } else {
      console.warn('[主流程] Codex 授权失败');
    }
  }

  // 8. 保存信息
  const line = `${email}|${password}|${new Date().toISOString()}\n`;
  appendFileSync(join(__dirname, '..', ACCOUNTS_FILE), line, 'utf-8');
  console.log('已保存账号:', email, '→', ACCOUNTS_FILE);

  if (invite) {
    const trackers: InviteTracker[] = [];
    if (existsSync(join(__dirname, '..', INVITE_TRACKER_FILE))) {
      const content = readFileSync(join(__dirname, '..', INVITE_TRACKER_FILE), 'utf-8');
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          trackers.push(...parsed);
        }
      } catch {
        // Ignore parse errors
      }
    }

    trackers.push({
      team_name: team.name,
      team_email: team.email,
      child_email: email,
      invited_at: new Date().toISOString(),
      status: 'pending',
    });

    writeFileSync(
      join(__dirname, '..', INVITE_TRACKER_FILE),
      JSON.stringify(trackers, null, 2),
      'utf-8'
    );
  }

  console.log('[主流程] 完成:', email);
  return true;
}

// ============================================================
// 批量入口
// ============================================================
async function run(): Promise<void> {
  const config = loadConfig();
  const TOTAL_ACCOUNTS = config.total_accounts;
  const ACCOUNTS_FILE = config.output.accounts_file;
  const INVITE_TRACKER_FILE = config.output.invite_tracker_file;
  const TEAMS: TeamConfig[] = config.teams || [];

  console.log('='.repeat(50));
  console.log('开始批量处理，目标数量:', TOTAL_ACCOUNTS);
  console.log('车头数量:', TEAMS.length);
  console.log('='.repeat(50));

  // 清空文件
  writeFileSync(join(__dirname, '..', ACCOUNTS_FILE), '', 'utf-8');
  writeFileSync(join(__dirname, '..', INVITE_TRACKER_FILE), '[]', 'utf-8');

  let success = 0;
  let fail = 0;

  for (let i = 0; i < TOTAL_ACCOUNTS; i++) {
    const teamIndex = i % TEAMS.length;
    const team = TEAMS[teamIndex];

    console.log(`\n[${i + 1}/${TOTAL_ACCOUNTS}] 使用车头: ${team.name} (${team.email})`);

    const ok = await processAccount(team);

    if (ok) {
      success++;
    } else {
      fail++;
    }

    console.log(`进度: ${i + 1}/${TOTAL_ACCOUNTS} | 成功: ${success} | 失败: ${fail}`);

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
