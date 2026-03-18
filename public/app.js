/**
 * Web UI 前端逻辑
 */

// Socket.IO 连接
const socket = io();

// DOM 元素
const statusBadge = document.getElementById('statusBadge');
const btnRun = document.getElementById('btnRun');
const btnStop = document.getElementById('btnStop');
const btnRefresh = document.getElementById('btnRefresh');
const btnClearLog = document.getElementById('btnClearLog');
const logContainer = document.getElementById('logContainer');
const configPreview = document.getElementById('configPreview');

// 状态管理
let isRunning = false;

// ============================================================
// WebSocket 事件
// ============================================================

// 连接成功
socket.on('connect', () => {
  console.log('已连接到服务器');
  addLog('system', '已连接到服务器');
});

// 状态更新
socket.on('status', (data) => {
  updateStatus(data.running);
});

// 日志消息
socket.on('log', (data) => {
  addLog(data.type, data.data);
});

// 脚本启动
socket.on('started', (data) => {
  isRunning = true;
  updateButtons();
  addLog('system', `脚本 ${data.script} 已启动`);
});

// 脚本停止
socket.on('stopped', (data) => {
  isRunning = false;
  updateButtons();
  addLog('system', `脚本已停止 (${data.code || data.reason || 'unknown'})`);
  // 自动刷新结果
  refreshResults();
});

// ============================================================
// UI 更新函数
// ============================================================

// 更新状态
function updateStatus(running) {
  isRunning = running;

  if (running) {
    statusBadge.classList.add('running');
    statusBadge.querySelector('.status-text').textContent = '运行中';
  } else {
    statusBadge.classList.remove('running');
    statusBadge.querySelector('.status-text').textContent = '就绪';
  }

  updateButtons();
}

// 更新按钮状态
function updateButtons() {
  if (isRunning) {
    btnRun.disabled = true;
    btnStop.disabled = false;
  } else {
    btnRun.disabled = false;
    btnStop.disabled = true;
  }
}

// 添加日志
function addLog(type, message) {
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry log-${type}`;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';

  const now = new Date();
  timeSpan.textContent = `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}]`;

  const messageSpan = document.createElement('span');
  messageSpan.className = 'log-message';
  messageSpan.textContent = message;

  logEntry.appendChild(timeSpan);
  logEntry.appendChild(messageSpan);

  logContainer.appendChild(logEntry);

  // 自动滚动到底部
  logContainer.scrollTop = logContainer.scrollHeight;
}

// 清空日志
function clearLogs() {
  logContainer.innerHTML = '';
  addLog('system', '日志已清空');
}

// ============================================================
// API 调用函数
// ============================================================

// 获取配置
async function fetchConfig() {
  try {
    const response = await fetch('/api/config');
    const result = await response.json();

    if (result.success) {
      updateConfigPreview(result.data);
    }
  } catch (error) {
    console.error('获取配置失败:', error);
  }
}

// 更新配置预览
function updateConfigPreview(config) {
  document.getElementById('config-total-accounts').textContent = config.total_accounts || '-';
  document.getElementById('config-temp-domain').textContent = config.temp_mail?.worker_domain || '-';
  document.getElementById('config-teams').textContent = config.teams?.length || 0;
}

// 运行脚本
async function runScript() {
  const selectedScript = document.querySelector('input[name="script"]:checked')?.value;

  if (!selectedScript) {
    alert('请选择脚本');
    return;
  }

  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: selectedScript }),
    });

    const result = await response.json();

    if (!result.success) {
      alert(`启动失败: ${result.error}`);
    }
  } catch (error) {
    console.error('运行脚本失败:', error);
    alert('启动失败: ' + error.message);
  }
}

// 停止脚本
async function stopScript() {
  try {
    const response = await fetch('/api/stop', {
      method: 'POST',
    });

    const result = await response.json();

    if (!result.success) {
      alert(`停止失败: ${result.error}`);
    }
  } catch (error) {
    console.error('停止脚本失败:', error);
    alert('停止失败: ' + error.message);
  }
}

// 刷新结果
async function refreshResults() {
  await Promise.all([fetchResults(), fetchAccounts(), fetchInvites()]);
}

// 获取 results.txt
async function fetchResults() {
  try {
    const response = await fetch('/api/results');
    const result = await response.json();

    if (result.success) {
      updateResultsTable(result.data);
    }
  } catch (error) {
    console.error('获取结果失败:', error);
  }
}

// 获取 accounts.txt
async function fetchAccounts() {
  try {
    const response = await fetch('/api/accounts');
    const result = await response.json();

    if (result.success) {
      updateAccountsTable(result.data);
    }
  } catch (error) {
    console.error('获取账号失败:', error);
  }
}

// 获取 invites.json
async function fetchInvites() {
  try {
    const response = await fetch('/api/invites');
    const result = await response.json();

    if (result.success) {
      updateInvitesTable(result.data);
    }
  } catch (error) {
    console.error('获取邀请失败:', error);
  }
}

// 更新 results 表格
function updateResultsTable(data) {
  const tbody = document.querySelector('#resultsTable tbody');
  tbody.innerHTML = '';

  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px;">暂无数据</td></tr>';
    return;
  }

  data.forEach((item) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="truncate">${escapeHtml(item.email)}</td>
      <td class="truncate">${escapeHtml(item.emailJwt?.slice(0, 50))}${item.emailJwt?.length > 50 ? '...' : ''}</td>
      <td class="truncate">${escapeHtml(item.password)}</td>
      <td class="truncate">${escapeHtml(item.accessToken?.slice(0, 50))}${item.accessToken?.length > 50 ? '...' : ''}</td>
    `;
    tbody.appendChild(row);
  });
}

// 更新 accounts 表格
function updateAccountsTable(data) {
  const tbody = document.querySelector('#accountsTable tbody');
  tbody.innerHTML = '';

  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 20px;">暂无数据</td></tr>';
    return;
  }

  data.forEach((item) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="truncate">${escapeHtml(item.email)}</td>
      <td class="truncate">${escapeHtml(item.password)}</td>
      <td class="truncate">${escapeHtml(item.createdAt)}</td>
    `;
    tbody.appendChild(row);
  });
}

// 更新 invites 表格
function updateInvitesTable(data) {
  const tbody = document.querySelector('#invitesTable tbody');
  tbody.innerHTML = '';

  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px;">暂无数据</td></tr>';
    return;
  }

  data.forEach((item) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="truncate">${escapeHtml(item.team_name)}</td>
      <td class="truncate">${escapeHtml(item.child_email)}</td>
      <td class="truncate">${escapeHtml(new Date(item.invited_at).toLocaleString())}</td>
      <td><span class="status-badge ${item.status === 'accepted' ? 'running' : ''}">${item.status}</span></td>
    `;
    tbody.appendChild(row);
  });
}

// HTML 转义
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// 标签页切换
// ============================================================

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    // 移除所有 active
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

    // 添加 active
    btn.classList.add('active');
    const tabId = btn.getAttribute('data-tab');
    document.getElementById(`tab-${tabId}`).classList.add('active');
  });
});

// ============================================================
// 事件监听
// ============================================================

btnRun.addEventListener('click', runScript);
btnStop.addEventListener('click', stopScript);
btnRefresh.addEventListener('click', refreshResults);
btnClearLog.addEventListener('click', clearLogs);

// ============================================================
// 初始化
// ============================================================

// 页面加载时获取配置
fetchConfig();
refreshResults();

// 每隔 30 秒自动刷新结果
setInterval(refreshResults, 30000);

// 添加欢迎日志
addLog('system', '欢迎使用 GPT-Team 管理控制台');
addLog('system', '请选择脚本并点击"运行脚本"开始');
