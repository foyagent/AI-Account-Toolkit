# GPT-Team 全自动协议注册工具（TypeScript/Bun 版本）

> 基于 AI-Account-Toolkit/GPT-team 的 TypeScript 重写版本
> 使用 Bun 运行，提供更好的性能和类型安全
> 🎨 现在提供 **Web UI 可视化界面**！

## 项目介绍

这是 [AI-Account-Toolkit](https://github.com/foyagent/AI-Account-Toolkit) 中 GPT-team 模块的 TypeScript 重写版本，保持了所有原有功能：

- ✅ 纯 HTTP 协议注册子号（无浏览器）
- ✅ 母号自动登录获取 Token
- ✅ 自动拉 Team 邀请
- ✅ 自动 Codex OAuth 授权上传 CPA
- ✅ 集成 Cloudflare Worker 临时邮箱
- ✅ 完整的 TypeScript 类型定义

## 安装

### 前置要求

- Node.js >= 18
- Bun >= 1.0 （推荐）或 Node.js

### 安装依赖

```bash
npm install
```

## 使用方法

### 🎨 Web UI（推荐）

启动 Web 服务器：

```bash
npm run ui
```

然后访问：**http://localhost:3000**

**Web UI 功能**：
- ✅ 可视化配置预览
- ✅ 一键运行脚本（支持 get-tokens 和 gpt-team）
- ✅ 实时日志查看（WebSocket 推送）
- ✅ 运行状态监控
- ✅ 结果查看（results.txt / accounts.txt / invites.json）
- ✅ 停止/重新运行控制
- ✅ 多标签页切换结果查看

**界面预览**：
- 左侧：脚本选择 + 配置预览 + 操作按钮
- 右侧：实时日志 + 结果表格

### 1. 配置文件

编辑 `config.yaml` 文件，填入配置信息：

```yaml
# 注册账号总数
total_accounts: 1

# 临时邮箱 API 配置
temp_mail:
  worker_domain: "your-worker.workers.dev"
  email_domains:
    - "yourdomain.com"
  admin_password: "your-admin-password"

# CLI Proxy API (CPA) 配置（仅 gpt-team 需要）
cli_proxy:
  management_url: "http://xxx.com:8317/management.html#/oauth"
  password: "xxxxxx"
  api_base: "http://xxx.com:8317"
  upload_enabled: true

# 输出文件
output:
  accounts_file: "accounts.txt"
  invite_tracker_file: "invite_tracker.json"
  results_file: "results.txt"

# 车头（Team）配置
teams:
  - name: "1"
    email: "xxx@xxx.xyz"
    password: "xxxxxx"
    jwt: "eyJhbGxxxxxx"  # 母号 JWT，可选
    max_invites: 4
```

### 2. 运行脚本

#### 使用 Bun（推荐）

```bash
# 获取开卡 Team 信息
bun run get-tokens

# 完整流程（注册+邀请+Codex+上传CPA）
bun run gpt-team
```

#### 使用 Node.js

```bash
# 安装 tsx（如果还没安装）
npm install -g tsx

# 获取开卡 Team 信息
npm run get-tokens

# 完整流程
npm run gpt-team
```

#### 开发模式（支持热重载）

```bash
# 开发模式运行 get-tokens
npm run dev:get-tokens

# 开发模式运行 gpt-team
npm run dev:gpt-team
```

### 3. 输出文件

- `results.txt` - 格式：`email|email_jwt|password|access_token`
- `accounts.txt` - 账号信息存储
- `invite_tracker.json` - 邀请跟踪信息

## 项目结构

```
src/
├── types/
│   ├── config.ts     # 配置类型定义
│   └── index.ts      # 通用类型定义
├── utils/
│   ├── http.ts       # HTTP 客户端
│   ├── pkce.ts       # PKCE 工具
│   ├── sentinel.ts   # Sentinel Token 生成器
│   ├── datadog.ts    # Datadog Trace 生成
│   ├── temp-mail.ts  # 临时邮箱 API
│   └── random.ts     # 随机数据生成
├── config.ts         # 配置加载
├── get-tokens.ts     # 获取 Token 主脚本
└── gpt-team.ts       # 完整团队管理脚本
```

## TypeScript 类型安全

完整的 TypeScript 类型定义，包括：

- 配置类型（`AppConfig`, `TempMailConfig`, `TeamConfig` 等）
- 数据类型（`AccountData`, `EmailResult`, `OAuthTokenResponse` 等）
- 工具函数类型

## 性能优势

相比 Python 版本：

- **更快的执行速度**：Bun 的运行时性能优于 Python
- **类型安全**：编译时类型检查，减少运行时错误
- **更好的 IDE 支持**：完整的类型提示和自动补全
- **原生异步支持**：Async/await 原生支持，无需额外库

## 注意事项

1. 本工具仅用于个人学习和研究，请勿用于任何违法或不当用途
2. 使用前请确保已正确部署 Cloudflare Worker 临时邮箱服务
3. 绑卡步骤需要手动操作，请按照脚本提示完成
4. 如有问题，请检查网络连接和代理设置

## 与原 Python 版本的差异

- 配置文件格式完全兼容
- 输出文件格式完全兼容
- 所有功能保持一致
- 代码结构更清晰，易于维护

## 开发

### 构建项目

```bash
npm run build
```

### 清理构建产物

```bash
npm run clean
```

## 免责声明

本工具仅供学习和研究使用，使用本工具产生的一切后果由使用者自行承担。请遵守相关服务的使用条款，不要用于任何违法或不当用途。

---

**版本**: 1.0.0 (TypeScript/Bun)
**基于**: AI-Account-Toolkit/GPT-team (Python 版本)
