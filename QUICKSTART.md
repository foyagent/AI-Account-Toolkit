# 快速开始指南

## 前置要求

- Node.js >= 18
- npm 或 yarn

## 安装

```bash
npm install
```

## 配置

编辑 `config.yaml` 文件：

```yaml
# 注册账号总数
total_accounts: 1

# 临时邮箱 API 配置
temp_mail:
  worker_domain: "your-worker.workers.dev"
  email_domains:
    - "yourdomain.com"
  admin_password: "your-admin-password"

# 输出文件
output:
  accounts_file: "accounts.txt"
  invite_tracker_file: "invite_tracker.json"
  results_file: "results.txt"
```

## 使用

### 方式 1: 仅注册并获取 Token

```bash
npm run get-tokens
```

输出文件：`results.txt`
格式：`email|email_jwt|password|access_token`

### 方式 2: 完整团队管理（注册 + 邀请 + Codex）

```bash
npm run gpt-team
```

功能包括：
- 注册子号
- 母号登录获取 Token
- 发送团队邀请
- Codex OAuth 授权
- 上传到 CPA（可选）

## 输出文件

- `results.txt` - Token 结果（get-tokens）
- `accounts.txt` - 账号信息
- `invite_tracker.json` - 邀请跟踪记录

## 开发

### 构建项目

```bash
npm run build
```

### 清理构建产物

```bash
npm run clean
```

## 故障排除

### 网络错误

检查网络连接和代理设置，在 `config.yaml` 中配置代理：

```yaml
proxy: "http://proxy:port"
```

### 邮箱接收不到验证码

1. 检查临时邮箱服务是否正常运行
2. 确认 `worker_domain` 和 `admin_password` 配置正确
3. 增加等待时间（默认 120 秒）

### Sentinel Token 失败

这是 OpenAI 的反机器人保护，系统会自动重试。如果频繁失败，可能需要：
1. 更换代理 IP
2. 增加请求间隔时间
3. 检查设备 ID 是否正确生成

## 注意事项

1. 本工具仅用于学习和研究
2. 请遵守 OpenAI 的使用条款
3. 绑卡步骤需要手动完成
4. 不要滥用工具，避免触发风控

## 许可证

本工具基于 AI-Account-Toolkit 的 Python 版本改写，保持相同的许可证。
