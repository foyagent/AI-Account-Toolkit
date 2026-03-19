/**
 * server.ts - 扩展版本
 * ===================
 * 提供 HTTP API 和 WebSocket 实时日志推送
 * 新增功能：
 * - 批量注册 API
 * - 账号验证 API
 * - 账号数据库管理 API
 * - 实时进度推送
 */

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { spawn, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import yaml from 'yaml';

import { batchRegister, type BatchConfig, type BatchProgress } from './batch-register.js';
import { verifyAccount, verifyAccountsBatch, type AccountStatus } from './account-verifier.js';
import type { AccountData } from './types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;

// ============================================================
// 数据库文件路径
// ============================================================
const ACCOUNTS_DB_PATH = join(__dirname, '../accounts_db.json');
const CONFIG_PATH = join(__dirname, '../config.yaml');

// ============================================================
// 中间件
// ============================================================
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// ============================================================
// 运行中的进程
// ============================================================
let runningProcess: ChildProcess | null = null;
let batchAbortController: AbortController | null = null;
let batchAbortController: AbortController | null = null;

// ============================================================
// API 路由
// ============================================================

/**
 * 健康检查
 */
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Server is running' });
});

/**
 * 获取配置
 */
app.get('/api/config', (req, res) => {
  try {
    const configContent = readFileSync(CONFIG_PATH, 'utf-8');
    const config = yaml.parse(configContent);
    res.json({ success: true, data: config });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 更新配置
 */
app.post('/api/config', (req, res) => {
  try {
    const config = req.body;
    const yamlContent = yaml.stringify(config, {
      lineWidth: -1,
      indent: 2,
    });
    writeFileSync(CONFIG_PATH, yamlContent, 'utf-8');
    res.json({ success: true, message: '配置已更新' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 批量注册
 */
app.post('/api/batch/register', async (req, res) => {
  try {
    const config: BatchConfig = req.body;

    // 验证配置
    if (!config.total || config.total < 1) {
      return res.status(400).json({
        success: false,
        error: '注册数量必须大于 0',
      });
    }

    // 创建 AbortController 用于取消
    batchAbortController = new AbortController();

    // 开始批量注册
    const result = await batchRegister(config, (progress: BatchProgress) => {
      // 检查是否被取消
      if (batchAbortController?.signal.aborted) {
        throw new Error('批量注册已取消');
      }

      // 通过 WebSocket 推送进度
      io.emit('batch:progress', progress);

      // 推送日志
      progress.logs.forEach((log) => {
        io.emit('batch:log', log);
      });
    }, batchAbortController.signal);

    // 完成后清除 AbortController
    batchAbortController = null;

    res.json({ success: true, data: result });
  } catch (error: any) {
    batchAbortController = null;
    if (error.message === '批量注册已取消') {
      res.json({ success: false, error: '已取消', cancelled: true });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

/**
 * 停止批量注册
 */
app.post('/api/batch/stop', (req, res) => {
  if (!batchAbortController) {
    return res.status(400).json({
      success: false,
      error: '没有正在进行的批量注册',
    });
  }

  try {
    batchAbortController.abort();
    batchAbortController = null;
    io.emit('batch:log', '[系统] 已发送停止信号');
    res.json({ success: true, message: '已发送停止信号' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 验证单个账号
 */
app.post('/api/accounts/verify', async (req, res) => {
  try {
    const { email, password, access_token } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: '缺少邮箱参数',
      });
    }

    // 从数据库加载账号信息
    const accounts: AccountData[] = loadAccountsDB();
    const account = accounts.find((a) => a.email === email);

    if (!account) {
      return res.status(404).json({
        success: false,
        error: '账号不存在',
      });
    }

    // 验证账号
    const status = await verifyAccount(account);

    res.json({ success: true, data: status });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 批量验证账号
 */
app.post('/api/accounts/verify-batch', async (req, res) => {
  try {
    const accounts: AccountData[] = loadAccountsDB();

    if (accounts.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const results = await verifyAccountsBatch(accounts, (current, total, status) => {
      io.emit('verify:progress', { current, total, status });
    });

    res.json({ success: true, data: results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取所有账号
 */
app.get('/api/accounts', (req, res) => {
  try {
    const accounts = loadAccountsDB();
    res.json({ success: true, data: accounts });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 添加账号
 */
app.post('/api/accounts', (req, res) => {
  try {
    const account: AccountData = req.body;

    if (!account.email || !account.password) {
      return res.status(400).json({
        success: false,
        error: '缺少必要字段',
      });
    }

    const accounts = loadAccountsDB();
    const exists = accounts.find((a) => a.email === account.email);

    if (exists) {
      return res.status(400).json({
        success: false,
        error: '账号已存在',
      });
    }

    account.created_at = account.created_at || new Date().toISOString();
    accounts.push(account);
    saveAccountsDB(accounts);

    res.json({ success: true, data: account });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 批量导入账号
 */
app.post('/api/accounts/import', (req, res) => {
  try {
    const accounts: AccountData[] = req.body;

    if (!Array.isArray(accounts)) {
      return res.status(400).json({
        success: false,
        error: '账号数据格式错误',
      });
    }

    const existingAccounts = loadAccountsDB();
    let addedCount = 0;

    for (const account of accounts) {
      if (!account.email || !account.password) continue;

      const exists = existingAccounts.find((a) => a.email === account.email);
      if (exists) continue;

      account.created_at = account.created_at || new Date().toISOString();
      existingAccounts.push(account);
      addedCount++;
    }

    saveAccountsDB(existingAccounts);

    res.json({ success: true, data: { added: addedCount, total: existingAccounts.length } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 导出账号
 */
app.get('/api/accounts/export', (req, res) => {
  try {
    const accounts = loadAccountsDB();
    res.json({ success: true, data: accounts });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 删除账号
 */
app.delete('/api/accounts/:email', (req, res) => {
  try {
    const { email } = req.params;
    const accounts = loadAccountsDB();
    const filtered = accounts.filter((a) => a.email !== email);

    if (filtered.length === accounts.length) {
      return res.status(404).json({
        success: false,
        error: '账号不存在',
      });
    }

    saveAccountsDB(filtered);

    res.json({ success: true, message: '账号已删除' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 批量删除账号
 */
app.post('/api/accounts/delete-batch', (req, res) => {
  try {
    const { emails } = req.body;

    if (!Array.isArray(emails)) {
      return res.status(400).json({
        success: false,
        error: '邮箱列表格式错误',
      });
    }

    const accounts = loadAccountsDB();
    const filtered = accounts.filter((a) => !emails.includes(a.email));

    saveAccountsDB(filtered);

    res.json({ success: true, data: { deleted: accounts.length - filtered.length } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取账号统计
 */
app.get('/api/accounts/stats', (req, res) => {
  try {
    const accounts = loadAccountsDB();

    const stats = {
      total: accounts.length,
      active: 0,
      banned: 0,
      suspended: 0,
      unverified: 0,
      unknown: 0,
    };

    // 简单统计（基于 access_token 是否存在）
    accounts.forEach((account) => {
      if (account.access_token) {
        stats.active++;
      } else {
        stats.unverified++;
      }
    });

    res.json({ success: true, data: stats });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 旧版 API（兼容）
// ============================================================

/**
 * 运行脚本（旧版）
 */
app.post('/api/run', async (req, res) => {
  const { script } = req.body;

  if (runningProcess) {
    return res.status(400).json({
      success: false,
      error: '已有脚本在运行中，请先停止',
    });
  }

  const scriptMap: Record<string, string> = {
    'get-tokens': 'get-tokens.ts',
    'gpt-team': 'gpt-team.ts',
  };

  const scriptFile = scriptMap[script];
  if (!scriptFile) {
    return res.status(400).json({
      success: false,
      error: '无效的脚本名称',
    });
  }

  try {
    runningProcess = spawn('npx', ['tsx', join(__dirname, scriptFile)], {
      cwd: __dirname,
      env: { ...process.env },
    });

    runningProcess.stdout?.on('data', (data) => {
      io.emit('log', { type: 'stdout', data: data.toString() });
    });

    runningProcess.stderr?.on('data', (data) => {
      io.emit('log', { type: 'stderr', data: data.toString() });
    });

    runningProcess.on('close', (code) => {
      io.emit('log', { type: 'system', data: `\n进程退出，代码: ${code}` });
      io.emit('stopped', { code });
      runningProcess = null;
    });

    runningProcess.on('error', (error) => {
      io.emit('log', { type: 'error', data: error.message });
      io.emit('stopped', { error: error.message });
      runningProcess = null;
    });

    io.emit('started', { script });
    res.json({ success: true, message: `开始运行 ${scriptFile}` });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
    runningProcess = null;
  }
});

/**
 * 停止脚本
 */
app.post('/api/stop', (req, res) => {
  if (!runningProcess) {
    return res.status(400).json({
      success: false,
      error: '没有运行中的脚本',
    });
  }

  try {
    runningProcess.kill('SIGTERM');
    runningProcess = null;
    io.emit('log', { type: 'system', data: '已发送停止信号' });
    io.emit('stopped', { reason: 'user_request' });
    res.json({ success: true, message: '已发送停止信号' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取运行状态
 */
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    data: {
      running: runningProcess !== null,
      pid: runningProcess?.pid || null,
    },
  });
});

// ============================================================
// 工具函数
// ============================================================
function loadAccountsDB(): AccountData[] {
  if (!existsSync(ACCOUNTS_DB_PATH)) {
    return [];
  }
  const content = readFileSync(ACCOUNTS_DB_PATH, 'utf-8');
  return JSON.parse(content);
}

function saveAccountsDB(accounts: AccountData[]): void {
  writeFileSync(ACCOUNTS_DB_PATH, JSON.stringify(accounts, null, 2));
}

// ============================================================
// WebSocket 连接
// ============================================================
io.on('connection', (socket) => {
  console.log('客户端已连接:', socket.id);

  socket.emit('status', {
    running: runningProcess !== null,
    pid: runningProcess?.pid || null,
  });

  socket.on('disconnect', () => {
    console.log('客户端已断开:', socket.id);
  });
});

// ============================================================
// 启动服务器
// ============================================================
server.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('Web UI 服务器已启动');
  console.log(`访问地址: http://localhost:${PORT}`);
  console.log('='.repeat(50));
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM，正在关闭服务器...');
  if (runningProcess) {
    runningProcess.kill('SIGTERM');
  }
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n收到 SIGINT，正在关闭服务器...');
  if (runningProcess) {
    runningProcess.kill('SIGTERM');
  }
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});
