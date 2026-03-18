# Web UI 使用说明

## 启动 Web UI

```bash
npm run ui
```

访问地址：**http://localhost:3000**

## 界面介绍

### 左侧控制面板

#### 1. 脚本选择
- **get-tokens**: 注册账号 + 获取 access_token
- **gpt-team**: 完整团队管理（注册 + 邀请 + Codex）

#### 2. 配置预览
- 显示当前配置的关键信息：
  - `total_accounts`: 注册账号数量
  - `temp_mail.domain`: 临时邮箱域名
  - `teams`: 车头数量

#### 3. 操作按钮
- **运行脚本**: 启动选中的脚本
- **停止**: 停止当前运行的脚本
- **刷新结果**: 手动刷新结果表格

### 右侧输出面板

#### 1. 运行日志
- 实时显示脚本运行日志
- WebSocket 推送，无延迟
- 不同类型日志用颜色区分：
  - 系统消息（蓝色）
  - 错误消息（红色）
  - 标准输出（白色）
  - 标准错误（黄色）

#### 2. 运行结果
- 三个标签页：
  - **results.txt**: Token 结果（email|jwt|password|token）
  - **accounts.txt**: 账号列表（email|password|created_at）
  - **invites.json**: 邀请跟踪记录

### 顶部状态栏
- 显示当前运行状态：
  - 🔵 就绪 - 没有脚本在运行
  - 🟢 运行中 - 脚本正在运行（有呼吸动画）

## 使用流程

### 1. 配置环境
编辑 `config.yaml` 文件，配置：
- 临时邮箱信息
- 车头账号信息
- 注册数量等

### 2. 启动 Web UI
```bash
npm run ui
```

### 3. 访问界面
打开浏览器访问 http://localhost:3000

### 4. 选择脚本
在左侧选择要运行的脚本

### 5. 运行脚本
点击"运行脚本"按钮

### 6. 查看日志
在右侧实时查看运行日志

### 7. 查看结果
切换不同标签页查看结果：
- results.txt - 查看获取的 Token
- accounts.txt - 查看注册的账号
- invites.json - 查看邀请状态

### 8. 停止脚本
如需停止，点击"停止"按钮

## API 接口

### 配置相关
- `GET /api/config` - 获取配置
- `POST /api/config` - 更新配置

### 脚本控制
- `POST /api/run` - 运行脚本
  - Body: `{ "script": "get-tokens" | "gpt-team" }`
- `POST /api/stop` - 停止脚本
- `GET /api/status` - 获取运行状态

### 结果获取
- `GET /api/results` - 获取 results.txt
- `GET /api/accounts` - 获取 accounts.txt
- `GET /api/invites` - 获取 invites.json

## WebSocket 事件

### 客户端 → 服务器
无需特殊事件，连接即自动

### 服务器 → 客户端
- `status` - 状态更新
  ```json
  { "running": true, "pid": 12345 }
  ```
- `log` - 日志消息
  ```json
  { "type": "stdout" | "stderr" | "system" | "error", "data": "日志内容" }
  ```
- `started` - 脚本启动
  ```json
  { "script": "get-tokens" }
  ```
- `stopped` - 脚本停止
  ```json
  { "code": 0 } | { "reason": "user_request" }
  ```

## 技术栈

### 后端
- **Express.js** - Web 服务器
- **Socket.IO** - WebSocket 通信
- **child_process** - 子进程管理
- **yaml** - 配置文件解析

### 前端
- **原生 JavaScript** - 无框架依赖
- **Socket.IO Client** - WebSocket 客户端
- **Fetch API** - HTTP 请求

## 注意事项

1. **端口占用**: 默认使用 3000 端口，如被占用可通过环境变量修改：
   ```bash
   PORT=8080 npm run ui
   ```

2. **进程管理**: Web UI 使用 child_process 运行脚本，停止时会发送 SIGTERM 信号

3. **日志限制**: 为避免内存溢出，日志在 UI 上显示最近 1000 条

4. **结果刷新**: 每 30 秒自动刷新一次结果，也可手动点击刷新按钮

5. **安全性**: Web UI 仅监听 localhost，如需远程访问请配置反向代理

## 故障排除

### 无法启动 Web UI
- 检查端口 3000 是否被占用
- 查看控制台错误信息
- 确认所有依赖已安装：`npm install`

### 脚本无法运行
- 检查 `config.yaml` 配置是否正确
- 查看日志中的错误信息
- 确认临时邮箱服务正常运行

### 日志不更新
- 检查浏览器控制台是否有 WebSocket 错误
- 尝试刷新页面重新连接
- 确认服务器正在运行

### 结果不显示
- 点击"刷新结果"按钮
- 检查文件路径是否正确
- 确认脚本已成功运行并生成结果

## 截图示例

```
┌────────────────────────────────────────────────────────────┐
│ 🤖 GPT-Team 管理控制台                      [🟢 运行中] │
├────────────────────┬───────────────────────────────────────┤
│ 📝 脚本选择         │ 📋 运行日志                            │
│ ◉ get-tokens       │ [2026-03-19 00:30:15] 注册成功: xxx     │
│ ○ gpt-team         │ [2026-03-19 00:30:16] 登录获取 token  │
│                   │ [2026-03-19 00:30:17] 已保存: xxx      │
│ ⚙️ 配置预览        │                                       │
│ total_accounts: 10 │ [清空]                                │
│ temp_mail: xxx.xyz │                                       │
│ teams: 3          │                                       │
│                   │                                       │
│ 🎮 操作            │                                       │
│ [▶ 运行脚本]       │                                       │
│ [⏹ 停止]          │                                       │
│ [🔄 刷新结果]      │                                       │
├────────────────────┴───────────────────────────────────────┤
│ 📊 运行结果                                                 │
│ [results.txt] [accounts.txt] [invites.json]                 │
│ ┌──────────────────────────────────────────────────────┐  │
│ │ 邮箱          | JWT          | 密码     | Token    │  │
│ ├──────────────────────────────────────────────────────┤  │
│ │ xxx@xxx.xyz   | eyJhb...     | Abc123  | sk-...   │  │
│ └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

## 高级用法

### 自定义端口
```bash
PORT=8080 npm run ui
```

### 远程访问（通过 SSH 隧道）
```bash
ssh -L 3000:localhost:3000 user@remote-server
```

### 作为服务运行（使用 PM2）
```bash
npm install -g pm2
pm2 start "npm run ui" --name "gpt-team-ui"
pm2 save
pm2 startup
```

## 更新日志

### v1.0.0 (2026-03-19)
- ✅ 初始版本发布
- ✅ Web UI 界面
- ✅ 实时日志推送
- ✅ 结果可视化
- ✅ 进程管理
