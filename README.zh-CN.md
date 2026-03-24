# gemini-cli-mcp

[![npm version](https://img.shields.io/npm/v/@xjoker/gemini-cli-mcp.svg)](https://www.npmjs.com/package/@xjoker/gemini-cli-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@xjoker/gemini-cli-mcp.svg)](https://www.npmjs.com/package/@xjoker/gemini-cli-mcp)
[![license](https://img.shields.io/github/license/xjoker/gemini-cli-mcp.svg)](https://github.com/xjoker/gemini-cli-mcp/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@xjoker/gemini-cli-mcp.svg)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/xjoker/gemini-cli-mcp.svg?style=social)](https://github.com/xjoker/gemini-cli-mcp)

[English](./README.md)

安全的 [MCP](https://modelcontextprotocol.io/) 服务器，封装 Google [Gemini CLI](https://github.com/google-gemini/gemini-cli)。让 Claude Code（或任何 MCP 客户端）通过本地 OAuth 登录调用 Gemini 模型，无需 API Key。

## 特性

- **安全** — Unix 使用 `spawn(shell:false)`；Windows 使用受控的 `shell:true` + 参数转义，杜绝命令注入
- **跨平台** — macOS、Linux、Windows，自动解析 `.cmd` 包装器，强制 UTF-8 编码
- **活动感知超时** — 空闲计时器在每次输出时重置。AI 长时间思考不会被中断，429 重试卡死会被终止
- **低 token 开销** — 替换 Gemini 默认 ~8800 token 的系统提示，仅用 ~50 token 的精简版
- **干净输出** — 内部使用 `stream-json`，结构化解析响应，无 stdout 噪声
- **仅 2 个工具** — `gemini_query` + `gemini_info`，最小化宿主 AI 的上下文占用

## 前提条件

1. **Node.js >= 18** — [下载](https://nodejs.org/)
2. **Google Gemini CLI** — 全局安装并完成登录：

```bash
npm install -g @google/gemini-cli
gemini   # 首次运行，在浏览器中完成 Google OAuth 登录
```

3. **验证可用** 再使用本 MCP 服务器：

```bash
gemini -p "say hello" -o text
# 应输出 AI 回复。如果报认证错误，重新运行 `gemini` 登录。
```

## 安装

### NPM 安装（推荐）

```bash
npm install -g @xjoker/gemini-cli-mcp

# 注册到 Claude Code
claude mcp add gemini-cli -s user -- gemini-cli-mcp
```

### 从源码安装

```bash
git clone https://github.com/xjoker/gemini-cli-mcp.git
cd gemini-cli-mcp
npm install && npm run build

claude mcp add gemini-cli -s user -- node $(pwd)/dist/index.js
```

### Claude Desktop 配置

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "gemini-cli": {
      "command": "gemini-cli-mcp"
    }
  }
}
```

## 工具

### `gemini_query`

向 Gemini 发送提示。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 提示文本，使用 `@file.ts` 引用本地文件 |
| `model` | string | 否 | 模型名称或别名（默认 `gemini-2.5-flash`） |
| `sandbox` | boolean | 否 | 在沙盒环境中运行 |
| `yolo` | boolean | 否 | 自动批准所有工具操作 |
| `approval_mode` | enum | 否 | `default` / `auto_edit` / `yolo` / `plan` |
| `include_stats` | boolean | 否 | 附加 token 使用统计 |
| `include_directories` | string[] | 否 | 额外的工作区目录 |
| `cwd` | string | 否 | `@file` 引用的工作目录 |

### `gemini_info`

诊断与元数据查询，大部分操作零 API 调用。

| Action | 说明 | API 调用? |
|--------|------|-----------|
| `ping` | 测试 CLI 连通性 | 否 |
| `version` | 获取 CLI 版本 | 否 |
| `list_models` | 显示可用模型和别名 | 否 |
| `list_sessions` | 列出历史会话 | 否 |
| `list_extensions` | 列出已安装扩展 | 否 |

## 模型

| 模型 | 级别 | 说明 |
|------|------|------|
| `gemini-2.5-pro` | 稳定版 | 高推理和创造力 |
| `gemini-2.5-flash` | 稳定版 | 快速均衡（默认） |
| `gemini-2.5-flash-lite` | 稳定版 | 最快最轻 |
| `gemini-3-pro-preview` | 预览版 | Gemini 3 Pro |
| `gemini-3-flash-preview` | 预览版 | Gemini 3 Flash |
| `gemini-3.1-pro-preview` | 预览版 | Gemini 3.1 Pro（灰度中） |
| `gemini-3.1-flash-lite-preview` | 预览版 | Gemini 3.1 Flash Lite |

**别名：** `auto`、`pro`、`flash`、`flash-lite`

免费配额：**60 RPM / 每天 1000 次请求**

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GEMINI_MODEL` | `gemini-2.5-flash` | 默认模型 |
| `GEMINI_TIMEOUT` | `120000` | 空闲超时（ms），每次有输出时重置 |
| `GEMINI_MAX_RESPONSE` | `100000` | 最大响应字符数，超出截断 |
| `GEMINI_BIN` | `gemini` | Gemini CLI 可执行文件路径 |
| `GEMINI_SYSTEM_MD` | *（内置精简版）* | 自定义系统提示路径，设为 `"default"` 使用 Gemini 内置提示 |

## 安全性

| 平台 | 策略 |
|------|------|
| Unix | `child_process.spawn()` + `shell: false` — 用户输入不经过 shell |
| Windows | `shell: true`（`.cmd` 必需）+ `%` → `%%` 和 `!` → `^^!` 转义 |

- 全项目零 `exec()` / `execSync()` / 字符串拼接命令
- 验证：`grep -rn "exec(" src/` 应无匹配

## 许可证

[MIT](./LICENSE)
