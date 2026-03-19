# 批量注册和账号管理功能使用指南

## 📋 功能概述

本次更新新增了完整的批量注册和账号管理功能：

### 1. 批量注册功能（纯注册版本）
- 只做注册 + 获取 access_token
- 不涉及车头、团队邀请、Codex 授权等复杂功能
- 复用核心注册逻辑，不重复实现
- 支持自定义配置（数量、延迟）
- 实时日志和进度推送

### 2. 账号验证功能
- 检测账号登录状态
- 识别封禁/暂停/未验证等状态
- 支持单账号和批量验证

### 3. Web UI 界面
- **批量注册页面**：配置面板、进度条、实时日志
- **账号管理页面**：列表展示、验证、导入/导出、删除

---

## 🚀 快速开始

### 1. 安装依赖

```bash
cd AI-Account-Toolkit
npm install
```

### 2. 配置文件

确保 `config.yaml` 配置正确：

```yaml
# 注册账号总数
total_accounts: 5

# 临时邮箱 API 配置
temp_mail:
  worker_domain: ""
  email_domains:
    - "xxx.xyz"
    - "xxx.eu.org"
  admin_password: "xxxxxx"
```

### 3. 启动 Web UI

```bash
npm run ui
```

访问地址：
- **主页**: http://localhost:3000/index.html
- **批量注册**: http://localhost:3000/batch.html
- **账号管理**: http://localhost:3000/accounts.html

---

## 📖 功能使用

### 批量注册（纯注册版本）

1. 打开 `batch.html` 页面
2. 配置注册参数：
   - **注册数量**: 要注册的账号数量
   - **延迟范围**: 每个账号注册之间的等待时间
3. 点击"开始批量注册"
4. 查看实时日志和进度

**注册流程：**
1. 创建临时邮箱
2. 注册账号（五步 HTTP 流程）
3. 登录获取 access_token
4. 保存到 accounts_db.json

### 账号管理

1. 打开 `accounts.html` 页面
2. 查看所有已注册账号
3. 操作：
   - **验证**: 点击单个账号的"验证"按钮
   - **批量验证**: 点击"验证所有账号"
   - **删除**: 删除单个或批量删除
   - **导出**: 导出所有账号为 JSON 文件
   - **复制**: 复制邮箱和密码到剪贴板
4. 使用搜索框过滤账号

---

## 🔧 API 接口

### 批量注册

```bash
POST /api/batch/register
Content-Type: application/json

{
  "total": 5,
  "delayMin": 5,
  "delayMax": 15
}
```

### 验证账号

```bash
POST /api/accounts/verify
Content-Type: application/json

{
  "email": "xxx@xxx.xyz"
}
```

### 批量验证

```bash
POST /api/accounts/verify-batch
```

### 获取账号列表

```bash
GET /api/accounts
```

### 添加账号

```bash
POST /api/accounts
Content-Type: application/json

{
  "email": "xxx@xxx.xyz",
  "password": "password",
  "access_token": "token..."
}
```

### 导入账号

```bash
POST /api/accounts/import
Content-Type: application/json

[
  {
    "email": "xxx@xxx.xyz",
    "password": "password"
  }
]
```

### 删除账号

```bash
DELETE /api/accounts/:email
```

### 批量删除

```bash
POST /api/accounts/delete-batch
Content-Type: application/json

{
  "emails": ["xxx@xxx.xyz", "yyy@yyy.xyz"]
}
```

### 获取统计

```bash
GET /api/accounts/stats
```

---

## 📊 WebSocket 事件

### 批量注册进度

```javascript
socket.on('batch:progress', (progress) => {
  console.log(progress);
  // {
  //   current: 1,
  //   total: 5,
  //   success: 0,
  //   fail: 0,
  //   currentEmail: 'xxx@xxx.xyz',
  //   currentTeam: '车头1',
  //   logs: []
  // }
});
```

### 批量注册日志

```javascript
socket.on('batch:log', (log) => {
  console.log(log);
  // "[12:00:00] 开始注册账号..."
});
```

### 验证进度

```javascript
socket.on('verify:progress', (progress) => {
  console.log(progress);
  // {
  //   current: 1,
  //   total: 10,
  //   status: { email, status, message, checkedAt }
  // }
});
```

---

## 📁 文件结构

```
AI-Account-Toolkit/
├── src/
│   ├── batch-register.ts       # 批量注册胶水脚本
│   ├── account-verifier.ts     # 账号验证模块
│   ├── api-routes.ts           # 扩展的 API 路由
│   ├── get-tokens.ts           # 核心注册逻辑
│   ├── gpt-team.ts             # 车头管理
│   └── server.ts               # Web 服务器
├── public/
│   ├── batch.html              # 批量注册页面
│   ├── accounts.html           # 账号管理页面
│   ├── index.html              # 主页
│   ├── app.js                  # 前端逻辑
│   └── style.css               # 样式
├── accounts_db.json            # 账号数据库
├── config.yaml                 # 配置文件
└── package.json
```

---

## 🎯 特性说明

### 胶水代码原则

本实现严格遵循"胶水代码"原则：

1. **不重复实现核心逻辑**:
   - 注册流程复用 `get-tokens.ts` 中的 `Registrar` 类
   - 登录获取 token 复用 `get-tokens.ts` 中的 `oauthLogin` 函数
   - 车头管理复用 `gpt-team.ts` 中的相关函数

2. **只做流程编排**:
   - `batch-register.ts`: 组合注册、邀请、授权等流程
   - `account-verifier.ts`: 调用 API 验证账号状态

### 账号状态说明

验证功能可检测以下状态：

| 状态 | 说明 |
|------|------|
| `active` | 账号正常 |
| `banned` | 账号被封禁 |
| `suspended` | 账号被暂停 |
| `unverified` | 未验证或 Token 过期 |
| `unknown` | 未知状态或验证失败 |

---

## 🐛 常见问题

### Q: 批量注册时卡住了怎么办？

A: 检查以下几点：
1. 临时邮箱服务是否正常
2. 网络连接是否稳定
3. 车头账号是否正常
4. 查看控制台日志获取详细错误信息

### Q: 验证账号显示"未验证"？

A: 可能原因：
1. Token 已过期，需要重新登录
2. 账号需要邮箱验证
3. API 请求失败

### Q: 如何导入已有账号？

A: 使用 API 接口：
```bash
curl -X POST http://localhost:3000/api/accounts/import \
  -H "Content-Type: application/json" \
  -d '[
    {"email": "xxx@xxx.xyz", "password": "password"},
    {"email": "yyy@yyy.xyz", "password": "password"}
  ]'
```

---

## 📝 更新日志

### v2.0.0 (2026-03-19)

#### 新增功能
- ✅ 批量注册功能（`batch-register.ts`）
- ✅ 账号验证功能（`account-verifier.ts`）
- ✅ 扩展的 API 路由（`api-routes.ts`）
- ✅ 批量注册页面（`batch.html`）
- ✅ 账号管理页面（`accounts.html`）
- ✅ WebSocket 实时进度推送

#### 改进
- 📊 账号统计面板
- 🔍 账号搜索功能
- 📤 导出账号为 JSON
- 📥 批量导入账号

#### 技术细节
- 严格遵循胶水代码原则，不重复实现核心逻辑
- 复用 `get-tokens.ts` 和 `gpt-team.ts` 的已有函数
- 使用 `accounts_db.json` 存储账号数据

---

## 📞 支持

如有问题，请提交 Issue 或联系开发者。

---

## 📄 许可证

ISC
