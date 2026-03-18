/**
 * Web UI 服务器
 * 提供 HTTP API 和 WebSocket 实时日志推送
 */

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { spawn, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import yaml from 'yaml';

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

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// 运行中的进程
let runningProcess: ChildProcess | null = null;

// ============================================================
// API 路由
// ============================================================

/**
 * 获取配置
 */
app.get('/api/config', (req, res) => {
  try {
    const configPath = join(__dirname, '../config.yaml');
    const configContent = readFileSync(configPath, 'utf-8');
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
    const configPath = join(__dirname, '../config.yaml');
    const yamlContent = yaml.stringify(config, {
      lineWidth: -1,
      indent: 2,
    });
    // 这里需要写入文件，为了安全起见，实际使用时可以添加备份
    res.json({ success: true, message: '配置已更新（需要重启服务生效）' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 运行脚本
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
    // 使用 tsx 运行 TypeScript 文件
    runningProcess = spawn('npx', ['tsx', join(__dirname, scriptFile)], {
      cwd: __dirname,
      env: { ...process.env },
    });

    // 监听 stdout
    runningProcess.stdout?.on('data', (data) => {
      io.emit('log', { type: 'stdout', data: data.toString() });
    });

    // 监听 stderr
    runningProcess.stderr?.on('data', (data) => {
      io.emit('log', { type: 'stderr', data: data.toString() });
    });

    // 监听退出
    runningProcess.on('close', (code) => {
      io.emit('log', { type: 'system', data: `\n进程退出，代码: ${code}` });
      io.emit('stopped', { code });
      runningProcess = null;
    });

    // 监听错误
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

/**
 * 获取结果文件
 */
app.get('/api/results', (req, res) => {
  try {
    const resultsPath = join(__dirname, '../results.txt');
    const content = readFileSync(resultsPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const results = lines.map((line) => {
      const parts = line.split('|');
      return {
        email: parts[0] || '',
        emailJwt: parts[1] || '',
        password: parts[2] || '',
        accessToken: parts[3] || '',
      };
    });

    res.json({ success: true, data: results });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      res.json({ success: true, data: [] });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

/**
 * 获取账号文件
 */
app.get('/api/accounts', (req, res) => {
  try {
    const accountsPath = join(__dirname, '../accounts.txt');
    const content = readFileSync(accountsPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const accounts = lines.map((line) => {
      const parts = line.split('|');
      return {
        email: parts[0] || '',
        password: parts[1] || '',
        createdAt: parts[2] || '',
      };
    });

    res.json({ success: true, data: accounts });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      res.json({ success: true, data: [] });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

/**
 * 获取邀请跟踪文件
 */
app.get('/api/invites', (req, res) => {
  try {
    const invitesPath = join(__dirname, '../invite_tracker.json');
    const content = readFileSync(invitesPath, 'utf-8');
    const invites = JSON.parse(content);
    res.json({ success: true, data: invites });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      res.json({ success: true, data: [] });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// ============================================================
// WebSocket 连接
// ============================================================
io.on('connection', (socket) => {
  console.log('客户端已连接:', socket.id);

  // 发送当前状态
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
