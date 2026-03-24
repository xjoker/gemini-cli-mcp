# gemini-cli-mcp

[![npm version](https://img.shields.io/npm/v/@xjoker/gemini-cli-mcp.svg)](https://www.npmjs.com/package/@xjoker/gemini-cli-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@xjoker/gemini-cli-mcp.svg)](https://www.npmjs.com/package/@xjoker/gemini-cli-mcp)
[![license](https://img.shields.io/github/license/xjoker/gemini-cli-mcp.svg)](https://github.com/xjoker/gemini-cli-mcp/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@xjoker/gemini-cli-mcp.svg)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/xjoker/gemini-cli-mcp.svg?style=social)](https://github.com/xjoker/gemini-cli-mcp)

[中文文档](./README.zh-CN.md)

A secure [MCP](https://modelcontextprotocol.io/) server that wraps Google's [Gemini CLI](https://github.com/google-gemini/gemini-cli). It lets Claude Code (or any MCP client) call Gemini models using your local OAuth session — no API key required.

## Highlights

- **Secure** — `spawn(shell:false)` on Unix; controlled `shell:true` + arg escaping on Windows. No command injection.
- **Cross-platform** — macOS, Linux, Windows. Auto-resolves `.cmd` wrappers and forces UTF-8.
- **Activity-based timeout** — idle timer resets on each output chunk. Long thinking won't be killed; stuck 429 retries will.
- **Low token overhead** — replaces Gemini's ~8 800-token default system prompt with a minimal one (~50 tokens).
- **Clean output** — internally uses `stream-json` and parses structured responses. No stdout noise pollution.
- **2 tools only** — `gemini_query` + `gemini_info`. Minimal context-window footprint for the host AI.

## Prerequisites

1. **Node.js >= 18** — [Download](https://nodejs.org/)
2. **Google Gemini CLI** — installed globally and logged in:

```bash
npm install -g @google/gemini-cli
gemini   # run once — complete the Google OAuth login in your browser
```

3. **Verify it works** before using this MCP server:

```bash
gemini -p "say hello" -o text
# Should print a response. If you see auth errors, re-run `gemini` to log in.
```

## Install

### NPM (recommended)

```bash
npm install -g @xjoker/gemini-cli-mcp

# Register with Claude Code
claude mcp add gemini-cli -s user -- gemini-cli-mcp
```

### From source

```bash
git clone https://github.com/xjoker/gemini-cli-mcp.git
cd gemini-cli-mcp
npm install && npm run build

claude mcp add gemini-cli -s user -- node $(pwd)/dist/index.js
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gemini-cli": {
      "command": "gemini-cli-mcp"
    }
  }
}
```

## Tools

### `gemini_query`

Send a prompt to Gemini.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Prompt text. Use `@file.ts` to include local files. |
| `model` | string | No | Model name or alias (default: `gemini-2.5-flash`) |
| `sandbox` | boolean | No | Run in sandboxed environment |
| `yolo` | boolean | No | Auto-approve all tool actions |
| `approval_mode` | enum | No | `default` / `auto_edit` / `yolo` / `plan` |
| `include_stats` | boolean | No | Append token usage stats |
| `include_directories` | string[] | No | Extra workspace directories |
| `cwd` | string | No | Working directory for `@file` references |

### `gemini_info`

Diagnostics and metadata — most actions cost zero API calls.

| Action | Description | API call? |
|--------|-------------|-----------|
| `ping` | Test CLI connectivity | No |
| `version` | Get CLI version | No |
| `list_models` | Show available models and aliases | No |
| `list_sessions` | List past Gemini sessions | No |
| `list_extensions` | List installed Gemini extensions | No |

## Models

| Model | Tier | Description |
|-------|------|-------------|
| `gemini-2.5-pro` | stable | High reasoning & creativity |
| `gemini-2.5-flash` | stable | Fast, balanced (default) |
| `gemini-2.5-flash-lite` | stable | Fastest, lightest |
| `gemini-3-pro-preview` | preview | Gemini 3 Pro |
| `gemini-3-flash-preview` | preview | Gemini 3 Flash |
| `gemini-3.1-pro-preview` | preview | Gemini 3.1 Pro (rolling out) |
| `gemini-3.1-flash-lite-preview` | preview | Gemini 3.1 Flash Lite |

**Aliases:** `auto`, `pro`, `flash`, `flash-lite`

Free tier quota: **60 RPM / 1 000 requests per day**.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_MODEL` | `gemini-2.5-flash` | Default model |
| `GEMINI_TIMEOUT` | `120000` | Idle timeout in ms (resets on each output chunk) |
| `GEMINI_MAX_RESPONSE` | `100000` | Max response chars before truncation |
| `GEMINI_BIN` | `gemini` | Path to Gemini CLI binary |
| `GEMINI_SYSTEM_MD` | *(bundled minimal)* | Path to custom system prompt, or `"default"` for Gemini built-in |

## Security

| Platform | Strategy |
|----------|----------|
| Unix | `child_process.spawn()` with `shell: false` — user input never reaches a shell |
| Windows | `shell: true` (required for `.cmd`) with `%` -> `%%` and `!` -> `^^!` escaping |

- Zero usage of `exec()` / `execSync()` / template-string commands.
- Verify: `grep -rn "exec(" src/` returns nothing.

## License

[MIT](./LICENSE)
