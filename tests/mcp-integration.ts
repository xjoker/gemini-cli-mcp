#!/usr/bin/env npx tsx

/**
 * Integration tests for gemini-cli-mcp.
 * Sends real MCP JSON-RPC messages over stdio and validates responses.
 *
 * Usage: npx tsx tests/mcp-integration.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "../src/index.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpTestClient {
  private child: ChildProcess;
  private rl: ReturnType<typeof createInterface>;
  private pending = new Map<number, {
    resolve: (v: JsonRpcResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private nextId = 1;
  private stderr = "";

  constructor() {
    this.child = spawn("npx", ["tsx", SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env },
    });

    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf-8");
    });

    this.rl = createInterface({ input: this.child.stdout! });
    this.rl.on("line", (line: string) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      } catch {
        // ignore non-JSON lines
      }
    });
  }

  send(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 60_000);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(JSON.stringify(msg) + "\n");
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    this.child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  async close(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Client closing"));
    }
    this.pending.clear();
    this.rl.close();
    this.child.stdin!.end();
    this.child.kill();
  }

  getStderr(): string {
    return this.stderr;
  }
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function test(name: string, fn: (client: McpTestClient) => Promise<void>): Promise<void> {
  // Each test gets a fresh server instance for isolation
  const client = new McpTestClient();
  try {
    // Initialize
    const initResp = await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    assert(initResp.result != null, "initialize should return result");
    client.notify("notifications/initialized");

    // Wait a bit for server to settle
    await sleep(200);

    await fn(client);
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: unknown) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL  ${name}: ${message}`);
  } finally {
    await client.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function main() {
  console.log("\n=== gemini-cli-mcp integration tests ===\n");

  // Test 1: Server initializes correctly
  await test("server initialization returns valid MCP response", async (client) => {
    // init already happened in test wrapper, just verify tools list
    const resp = await client.send("tools/list");
    const result = resp.result as { tools: Array<{ name: string }> };
    assert(Array.isArray(result.tools), "tools should be an array");

    const toolNames = result.tools.map((t) => t.name);
    assert(toolNames.includes("gemini_query"), "should have gemini_query tool");
    assert(toolNames.includes("gemini_info"), "should have gemini_info tool");
    assert(result.tools.length === 2, `should have exactly 2 tools, got ${result.tools.length}`);
  });

  // Test 2: Tool schemas are well-formed
  await test("tool schemas have correct required fields", async (client) => {
    const resp = await client.send("tools/list");
    const result = resp.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };

    for (const tool of result.tools) {
      assert(tool.inputSchema != null, `${tool.name} should have inputSchema`);
      assert(
        (tool.inputSchema as Record<string, unknown>).type === "object",
        `${tool.name} inputSchema should be object type`
      );
    }

    // gemini_query must require "prompt"
    const queryTool = result.tools.find((t) => t.name === "gemini_query")!;
    const required = (queryTool.inputSchema as Record<string, unknown>).required as string[];
    assert(required.includes("prompt"), "gemini_query should require prompt");

    // gemini_info must require "action"
    const infoTool = result.tools.find((t) => t.name === "gemini_info")!;
    const infoRequired = (infoTool.inputSchema as Record<string, unknown>).required as string[];
    assert(infoRequired.includes("action"), "gemini_info should require action");
  });

  // Test 3: gemini_query model field accepts free string (not hardcoded enum)
  await test("gemini_query model field is free string", async (client) => {
    const resp = await client.send("tools/list");
    const result = resp.result as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, Record<string, unknown>> } }>;
    };
    const queryTool = result.tools.find((t) => t.name === "gemini_query")!;
    const modelProp = queryTool.inputSchema.properties.model;
    assert(modelProp.type === "string", "model should be string type");
    assert(modelProp.enum == null, "model should NOT have enum constraint (free string)");
  });

  // Test 4: gemini_info version
  await test("gemini_info version returns version string", async (client) => {
    const resp = await client.send("tools/call", {
      name: "gemini_info",
      arguments: { action: "version" },
    });
    const result = resp.result as { content: Array<{ type: string; text: string }> };
    assert(result.content.length > 0, "should have content");
    assert(result.content[0].text.length > 0, "version should not be empty");
    // Version should contain a number (e.g. "0.34.0")
    assert(/\d/.test(result.content[0].text), `version should contain a digit, got: ${result.content[0].text}`);
    console.log(`         version: ${result.content[0].text}`);
  });

  // Test 5: gemini_info ping (lightweight, uses --version not API)
  await test("gemini_info ping confirms CLI connectivity", async (client) => {
    const resp = await client.send("tools/call", {
      name: "gemini_info",
      arguments: { action: "ping" },
    });
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert(result.content.length > 0, "should have content");
    assert(!result.isError, `ping should succeed, got: ${result.content[0].text}`);
    assert(
      result.content[0].text.includes("OK"),
      `ping response should contain OK, got: ${result.content[0].text}`
    );
    console.log(`         response: ${result.content[0].text.slice(0, 80)}`);
  });

  // Test 6: gemini_query basic prompt
  await test("gemini_query answers a simple question", async (client) => {
    const resp = await client.send("tools/call", {
      name: "gemini_query",
      arguments: {
        prompt: "What is 2+3? Reply with just the number.",
      },
    });
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert(!result.isError, `query should succeed, got: ${result.content[0]?.text}`);
    assert(result.content[0].text.includes("5"), `should contain 5, got: ${result.content[0].text}`);
    console.log(`         response: ${result.content[0].text.slice(0, 80)}`);
  });

  // Test 7: gemini_query with include_stats
  await test("gemini_query include_stats returns token info", async (client) => {
    const resp = await client.send("tools/call", {
      name: "gemini_query",
      arguments: {
        prompt: "Say hello.",
        include_stats: true,
      },
    });
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert(!result.isError, `stats query should succeed, got: ${result.content[0]?.text}`);
    assert(result.content[0].text.includes("Token stats"), `should include token stats, got: ${result.content[0].text.slice(0, 200)}`);
    console.log(`         response: ${result.content[0].text.slice(0, 120)}`);
  });

  // Test 8: stdout noise is cleaned
  await test("stdout noise (MCP issues) is stripped from text output", async (client) => {
    const resp = await client.send("tools/call", {
      name: "gemini_query",
      arguments: {
        prompt: "Reply with exactly: clean-test-marker",
      },
    });
    const result = resp.result as { content: Array<{ type: string; text: string }> };
    assert(
      !result.content[0].text.includes("MCP issues detected"),
      `output should not contain MCP noise, got: ${result.content[0].text.slice(0, 100)}`
    );
    console.log(`         response: ${result.content[0].text.slice(0, 80)}`);
  });

  // Test 9: gemini_info list_extensions
  await test("gemini_info list_extensions returns data", async (client) => {
    const resp = await client.send("tools/call", {
      name: "gemini_info",
      arguments: { action: "list_extensions" },
    });
    const result = resp.result as { content: Array<{ type: string; text: string }> };
    assert(result.content.length > 0, "should have content");
    console.log(`         extensions: ${result.content[0].text.slice(0, 120)}`);
  });

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(2);
});
