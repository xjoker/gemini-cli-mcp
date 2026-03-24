#!/usr/bin/env node

/**
 * gemini-cli-mcp — Secure MCP server wrapping Google Gemini CLI.
 *
 * Cross-platform: macOS / Linux / Windows.
 * Security: spawn with shell:false on Unix; shell:true + arg escaping on Windows.
 *
 * Prerequisites:
 *   npm install -g @google/gemini-cli
 *   gemini   # complete OAuth login once
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------
const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const MAX_RESPONSE_CHARS = Number(process.env.GEMINI_MAX_RESPONSE ?? 100_000);

// Known models from gemini-cli-core/src/config/models.js
// Also supports aliases: auto, pro, flash, flash-lite
const KNOWN_MODELS = [
  { id: "gemini-2.5-pro", tier: "stable", desc: "High reasoning/creativity" },
  { id: "gemini-2.5-flash", tier: "stable", desc: "Fast, balanced" },
  { id: "gemini-2.5-flash-lite", tier: "stable", desc: "Fastest, lightest" },
  { id: "gemini-3-pro-preview", tier: "preview", desc: "Gemini 3 Pro" },
  { id: "gemini-3-flash-preview", tier: "preview", desc: "Gemini 3 Flash" },
  { id: "gemini-3.1-pro-preview", tier: "preview", desc: "Gemini 3.1 Pro (rolling out)" },
  { id: "gemini-3.1-flash-lite-preview", tier: "preview", desc: "Gemini 3.1 Flash Lite" },
] as const;

const MODEL_ALIASES: Record<string, string> = {
  auto: "auto-gemini-3",
  pro: "gemini-2.5-pro",
  flash: "gemini-2.5-flash",
  "flash-lite": "gemini-2.5-flash-lite",
};

function formatModelList(): string {
  const lines = KNOWN_MODELS.map(
    (m) => `  ${m.id} [${m.tier}] — ${m.desc}`
  );
  lines.push("  Aliases: auto, pro, flash, flash-lite");
  return lines.join("\n");
}

// Minimal system prompt: strips ~8800 token default, replaces with ~20 tokens.
// Set GEMINI_SYSTEM_MD env to override, or "default" to keep gemini's built-in prompt.
const MINIMAL_SYSTEM_PROMPT_PATH = (() => {
  const envVal = process.env.GEMINI_SYSTEM_MD;
  if (envVal === "default") return null; // use gemini's built-in
  if (envVal) return envVal; // user-specified path

  // Use bundled minimal prompt
  const bundled = resolve(__dirname, "../data/config/system-minimal.md");
  if (existsSync(bundled)) return bundled;
  return null;
})();

const TIMEOUT_MS = (() => {
  const val = Number(process.env.GEMINI_TIMEOUT ?? 120_000);
  if (!Number.isFinite(val) || val <= 0) return 120_000;
  return val;
})();

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------
/**
 * Resolve the gemini CLI binary path.
 *
 * - Unix: "gemini" works with spawn(shell:false) since it's a symlinked script.
 * - Windows: npm global installs create gemini.cmd, which spawn(shell:false)
 *   cannot execute. We resolve the absolute path via `where.exe`.
 */
function resolveGeminiBin(): string {
  const userBin = process.env.GEMINI_BIN;
  if (userBin) return userBin;

  if (!IS_WIN) return "gemini";

  try {
    const result = execFileSync("where.exe", ["gemini"], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 5_000,
    });
    return result.trim().split(/\r?\n/)[0];
  } catch {
    return "gemini";
  }
}

const GEMINI_BIN = resolveGeminiBin();

// ---------------------------------------------------------------------------
// UTF-8 environment
// ---------------------------------------------------------------------------
/** Build a child env that forces UTF-8 output across platforms. */
function buildChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (IS_WIN) {
    // Node.js child: suppress experimental warnings
    env.NODE_OPTIONS = [env.NODE_OPTIONS, "--no-warnings"].filter(Boolean).join(" ");
  } else {
    // Unix: ensure locale is UTF-8
    if (!env.LANG?.includes("UTF-8") && !env.LC_ALL?.includes("UTF-8")) {
      env.LANG = "en_US.UTF-8";
    }
  }

  // Inject minimal system prompt to replace gemini's ~8800 token default
  if (MINIMAL_SYSTEM_PROMPT_PATH) {
    env.GEMINI_SYSTEM_MD = MINIMAL_SYSTEM_PROMPT_PATH;
  }

  return env;
}

const CHILD_ENV = buildChildEnv();

// ---------------------------------------------------------------------------
// Windows arg escaping
// ---------------------------------------------------------------------------
/**
 * On Windows with shell:true, cmd.exe expands %VAR% and !VAR! (delayed expansion).
 * Escape both to prevent environment variable injection.
 * Node.js auto-escapes quotes in array args, but does NOT escape % or !.
 */
function escapeArg(arg: string): string {
  if (!IS_WIN) return arg;
  return arg.replace(/%/g, "%%").replace(/!/g, "^^!");
}

// ---------------------------------------------------------------------------
// Stdout JSON extraction
// ---------------------------------------------------------------------------
/**
 * Extract the JSON object from gemini CLI stdout.
 *
 * gemini CLI may prepend noise (e.g. "MCP issues detected...") directly
 * concatenated before the JSON, with no newline. We try JSON.parse from
 * each '{' position to find the valid JSON object, rather than naively
 * taking the first '{'.
 */
function extractJson(raw: string): Record<string, unknown> | null {
  let searchFrom = 0;
  while (true) {
    const start = raw.indexOf("{", searchFrom);
    if (start < 0) return null;

    try {
      const parsed = JSON.parse(raw.slice(start));
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON from this position, try next '{'
    }
    searchFrom = start + 1;
  }
}

/**
 * For non-JSON commands (--version, --list-sessions etc.), strip known noise.
 * These commands produce simple text output, so best-effort is acceptable.
 */
function stripNoise(raw: string): string {
  // Remove the entire known noise sentence (exact fixed text)
  const KNOWN_NOISE = "MCP issues detected. Run /mcp list for status.";
  let cleaned = raw;
  if (cleaned.startsWith(KNOWN_NOISE)) {
    cleaned = cleaned.slice(KNOWN_NOISE.length);
  }
  return cleaned.trim();
}

// ---------------------------------------------------------------------------
// Response truncation
// ---------------------------------------------------------------------------
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n...(truncated, ${text.length} chars total)`;
}

// ---------------------------------------------------------------------------
// Error message extraction
// ---------------------------------------------------------------------------
/**
 * Gemini CLI stderr can be extremely verbose (MCP connection errors, full
 * stack traces from unrelated plugins, etc). Extract only the meaningful
 * error line(s) to keep MCP responses concise.
 */
const ERROR_PATTERNS = [
  /ModelNotFoundError:.+/,
  /Error when talking to Gemini API.+/,
  /AuthenticationError:.+/,
  /QuotaError:.+/,
  /RateLimitError:.+/,
  /PermissionDeniedError:.+/,
  /InvalidRequestError:.+/,
  /NetworkError:.+/,
  /ENOTFOUND.+/,
  /ECONNREFUSED.+/,
  /ECONNRESET.+/,
  /Process timed out.+/,
  /timeout.+/i,
  /429.+Too Many Requests/i,
  /QuotaExceeded.+/,
  /RESOURCE_EXHAUSTED.+/,
];

function extractErrorMessage(stderr: string, stdout: string): string {
  const combined = stderr + "\n" + stdout;

  // Check for timeout first
  if (/Idle timeout/.test(combined)) {
    const hasRateLimit = /429|Too Many Requests|RESOURCE_EXHAUSTED/i.test(combined);
    return hasRateLimit
      ? "Idle timeout (429 rate limited). Model may be unavailable or quota exhausted.\n" +
        "Free tier: 60 RPM / 1000 req/day.\nAvailable models:\n" + formatModelList()
      : "Idle timeout — no output from Gemini CLI. Model may be unavailable.\nAvailable models:\n" + formatModelList();
  }

  // Check for rate limiting (429)
  if (/429|Too Many Requests|RESOURCE_EXHAUSTED|QuotaExceeded/i.test(combined)) {
    return "Rate limited (429). Model may be unavailable or quota exhausted.\n" +
      "Free tier: 60 RPM / 1000 req/day.\nAvailable models:\n" + formatModelList();
  }

  // Model not found
  if (/ModelNotFoundError/i.test(combined)) {
    return "Model not found.\nAvailable models:\n" + formatModelList();
  }

  // Try to find a known error pattern in stderr
  for (const pattern of ERROR_PATTERNS) {
    const match = stderr.match(pattern);
    if (match) return match[0];
  }

  // Try JSON error in stdout (gemini -o json puts errors there)
  const json = extractJson(stdout);
  if (json?.error) {
    const err = json.error as Record<string, unknown>;
    if (err.message) return `${err.type ?? "Error"}: ${err.message}`;
  }

  // Fallback: first non-empty line of stderr, capped at 500 chars
  const firstLine = stderr.split("\n").find((l) => l.trim().length > 0);
  if (firstLine) return truncate(firstLine.trim(), 500);

  return "Unknown error (no stderr output)";
}

// ---------------------------------------------------------------------------
// Core: safe Gemini CLI invocation
// ---------------------------------------------------------------------------
interface GeminiRunOptions {
  args: string[];
  timeoutMs?: number;
  cwd?: string;
}

interface GeminiResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Spawn gemini CLI with activity-based idle timeout.
 *
 * Instead of a fixed wall-clock timeout, we track stdout/stderr activity.
 * Each time data arrives, the idle timer resets. Only when there is NO output
 * for `idleTimeoutMs` do we consider it stuck (e.g. gemini retrying 429).
 *
 * This ensures long-running but active requests (deep thinking with many
 * output tokens) are never killed prematurely, while truly stuck processes
 * are terminated promptly.
 */
function runGeminiRaw(opts: GeminiRunOptions): Promise<GeminiResult> {
  return new Promise((resolve, reject) => {
    const escapedArgs = opts.args.map(escapeArg);
    const idleTimeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    let timedOut = false;
    let closed = false;

    const child: ChildProcess = spawn(GEMINI_BIN, escapedArgs, {
      shell: IS_WIN,
      stdio: ["ignore", "pipe", "pipe"],
      env: CHILD_ENV,
      cwd: opts.cwd,
      windowsHide: true,
    });

    // stdin closed via "ignore" in stdio config — no input needed.

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // --- Idle timeout: resets on any stdout activity ---
    function forceKill(): void {
      if (closed) return;
      timedOut = true;
      child.kill("SIGTERM");
      // SIGKILL escalation: gemini spawns child MCP servers that inherit
      // pipe fds, preventing `close` from firing. Force-resolve after 3s.
      setTimeout(() => {
        if (closed) return;
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        closed = true;
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: `Idle timeout (no output for ${idleTimeoutMs}ms). ${Buffer.concat(stderrChunks).toString("utf-8")}`.trim(),
          code: 124,
        });
      }, 3_000);
    }

    let idleTimer = setTimeout(forceKill, idleTimeoutMs);

    function resetIdleTimer(): void {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(forceKill, idleTimeoutMs);
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      resetIdleTimer(); // AI is actively outputting — reset idle clock
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      // Don't reset on stderr — error output during 429 retries shouldn't
      // prevent timeout. Only stdout activity (actual AI output) resets.
    });

    child.on("error", (err) => {
      clearTimeout(idleTimer);
      reject(
        new Error(
          `Failed to start gemini CLI (${GEMINI_BIN}): ${err.message}. ` +
            "Install: npm install -g @google/gemini-cli"
        )
      );
    });

    child.on("close", (code) => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      if (timedOut) {
        resolve({
          stdout,
          stderr: `Idle timeout (no output for ${idleTimeoutMs}ms). ${stderr}`.trim(),
          code: 124,
        });
        return;
      }

      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

// ---------------------------------------------------------------------------
// High-level: run a Gemini prompt
// ---------------------------------------------------------------------------
interface GeminiQueryOptions {
  prompt: string;
  model?: string;
  sandbox?: boolean;
  yolo?: boolean;
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
  includeDirectories?: string[];
  cwd?: string;
}

interface GeminiQueryResult {
  response: string;
  stats?: Record<string, unknown>;
  raw: GeminiResult;
}

/**
 * Invokes gemini with `-o stream-json` for activity-aware idle timeout.
 *
 * stream-json outputs one JSON object per line:
 *   {"type":"init", ...}
 *   {"type":"message", "role":"assistant", "content":"...", "delta":true}
 *   {"type":"result", "stats":{...}}
 *
 * Each line of stdout resets the idle timer, so long-running but active
 * thinking never gets killed. Only truly stuck processes (429 retries
 * produce no stdout) hit the idle timeout.
 */
async function runGeminiQuery(opts: GeminiQueryOptions): Promise<GeminiQueryResult> {
  const args: string[] = [];

  args.push("-p", opts.prompt);
  args.push("-m", opts.model ?? DEFAULT_MODEL);
  args.push("-o", "stream-json"); // Stream for idle-timeout awareness

  if (opts.sandbox) args.push("-s");
  if (opts.yolo) args.push("-y");
  if (opts.approvalMode) args.push("--approval-mode", opts.approvalMode);

  if (opts.includeDirectories?.length) {
    for (const dir of opts.includeDirectories) {
      args.push("--include-directories", dir);
    }
  }

  const raw = await runGeminiRaw({ args, cwd: opts.cwd });

  if (raw.code !== 0) {
    return { response: "", raw };
  }

  // Parse stream-json: each line is a JSON object.
  // Collect assistant message deltas and extract stats from result line.
  return parseStreamJson(raw);
}

/** Parse stream-json output lines into a single response + stats. */
function parseStreamJson(raw: GeminiResult): GeminiQueryResult {
  const contentParts: string[] = [];
  let stats: Record<string, unknown> | undefined;

  for (const line of raw.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;

    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;

      if (obj.type === "message" && obj.role === "assistant" && typeof obj.content === "string") {
        contentParts.push(obj.content as string);
      } else if (obj.type === "result" && obj.stats) {
        const s = obj.stats as Record<string, unknown>;
        stats = s.models as Record<string, unknown> | undefined;
      }
    } catch {
      // Skip unparseable lines (noise prefix on first line, etc.)
    }
  }

  const response = contentParts.join("").trim();
  return { response: response || stripNoise(raw.stdout), stats, raw };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "gemini-cli-mcp",
  version: "1.0.0",
});

// --- Tool: gemini_query ---------------------------------------------------
server.tool(
  "gemini_query",
  "Send a prompt to Google Gemini via locally authenticated CLI. " +
    "Supports all Gemini models. Use @path to reference local files. " +
    "Options: sandbox mode, yolo (auto-approve), approval modes, extra directories.",
  {
    prompt: z.string().trim().min(1, "Prompt cannot be empty").describe(
      "Prompt for Gemini. Use @file.ts to include file context."
    ),
    model: z.string().optional().describe(
      "Model name (e.g. gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite). Default: " + DEFAULT_MODEL
    ),
    sandbox: z.boolean().optional().describe(
      "Run in sandbox mode for safe code execution."
    ),
    yolo: z.boolean().optional().describe(
      "Auto-approve all tool actions (no confirmation prompts)."
    ),
    approval_mode: z.enum(["default", "auto_edit", "yolo", "plan"]).optional().describe(
      "Approval mode: default (prompt), auto_edit (auto-approve edits), yolo (auto-approve all), plan (read-only)."
    ),
    include_stats: z.boolean().optional().describe(
      "Include token usage stats in the response."
    ),
    include_directories: z.array(z.string()).optional().describe(
      "Additional directories to include in Gemini's workspace."
    ),
    cwd: z.string().optional().describe(
      "Working directory for file references (@ syntax)."
    ),
  },
  async ({ prompt, model, sandbox, yolo, approval_mode, include_stats, include_directories, cwd }) => {
    try {
      const result = await runGeminiQuery({
        prompt,
        model,
        sandbox,
        yolo,
        approvalMode: approval_mode,
        includeDirectories: include_directories,
        cwd,
      });

      if (result.raw.code !== 0) {
        const errorMsg = extractErrorMessage(result.raw.stderr, result.raw.stdout);
        return {
          content: [{ type: "text" as const, text: `Gemini CLI error (exit ${result.raw.code}): ${errorMsg}` }],
          isError: true,
        };
      }

      const parts: string[] = [result.response];
      if (include_stats && result.stats) {
        parts.push("\n---\nToken stats: " + JSON.stringify(result.stats));
      }
      const output = truncate(parts.join(""), MAX_RESPONSE_CHARS);

      return {
        content: [{ type: "text" as const, text: output || "(empty response)" }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: gemini_info ----------------------------------------------------
server.tool(
  "gemini_info",
  "Gemini CLI diagnostics: check connectivity, get version, list sessions or extensions.",
  {
    action: z.enum(["ping", "version", "list_models", "list_sessions", "list_extensions"]).describe(
      "ping: test CLI works, version: CLI version, list_models: available models and aliases, list_sessions: past sessions, list_extensions: available extensions."
    ),
  },
  async ({ action }) => {
    try {
      let result: GeminiResult;

      switch (action) {
        case "ping": {
          // Use --version for lightweight connectivity check (no API call, no tokens)
          result = await runGeminiRaw({ args: ["--version"], timeoutMs: 10_000 });
          const version = stripNoise(result.stdout).trim();
          if (result.code === 0 && version) {
            return {
              content: [{
                type: "text" as const,
                text: `Gemini CLI OK (v${version})`,
              }],
            };
          }
          return {
            content: [{
              type: "text" as const,
              text: `Gemini CLI error (exit ${result.code}):\n${result.stderr || result.stdout}`,
            }],
            isError: true,
          };
        }

        case "list_models":
          return {
            content: [{
              type: "text" as const,
              text: `Available Gemini models:\n${formatModelList()}\n\nDefault: ${DEFAULT_MODEL}\nFree tier: 60 RPM / 1000 req/day`,
            }],
          };

        case "version":
          result = await runGeminiRaw({ args: ["--version"], timeoutMs: 10_000 });
          return {
            content: [{
              type: "text" as const,
              text: stripNoise(result.stdout) || result.stderr.trim() || "unknown",
            }],
          };

        case "list_sessions":
          result = await runGeminiRaw({ args: ["--list-sessions"], timeoutMs: 10_000 });
          return {
            content: [{
              type: "text" as const,
              text: truncate(stripNoise(result.stdout) || "(no sessions)", MAX_RESPONSE_CHARS),
            }],
          };

        case "list_extensions":
          result = await runGeminiRaw({ args: ["-l"], timeoutMs: 10_000 });
          return {
            content: [{
              type: "text" as const,
              text: stripNoise(result.stdout) || "(no extensions)",
            }],
          };

        default: {
          const _exhaustive: never = action;
          return {
            content: [{ type: "text" as const, text: `Unknown action: ${_exhaustive}` }],
            isError: true,
          };
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`gemini-cli-mcp: running (stdio) | bin=${GEMINI_BIN} | platform=${process.platform}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
