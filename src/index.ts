import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { 
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config/index.js";
import { ConfigLoader } from "./config/index.js";

/** ---------- Policy (mutable at runtime) ---------- */
export type Policy = {
  allowedCwds: string[];
  defaultCwd: string | null;
  allow: RegExp[];     // full command line allow list, e.g. /^git(\s|$)/, /^gh(\s|$)/
  deny: RegExp[];      // explicit denies, e.g. /^git\s+push(\s+.*)?\s+(origin\s+)?(main|master)(\s+.*)?$/i
  timeoutMs: number;   // hard cap per command
  maxBytes: number;    // cap stdout/stderr per stream
  envWhitelist: string[]; // which env vars to forward
};

export const makeRegex = (s: string) => new RegExp(s, "i");

// Function to create policy from config
function createPolicyFromConfig(config: Config): Policy {
  return {
    allowedCwds: config.directories.allowed,
    defaultCwd: config.directories.default || null,
    allow: config.commands.allow.map(makeRegex),
    deny: config.commands.deny.map(makeRegex),
    timeoutMs: config.limits.timeout_seconds * 1000,
    maxBytes: config.limits.max_output_bytes,
    envWhitelist: config.environment.whitelist
  };
}

// Load configuration from config files
let config: Config = ConfigLoader.loadConfig();
let policy: Policy = createPolicyFromConfig(config);

// Export functions for testing
export { config, policy, createPolicyFromConfig };

// Function to override config for testing
export function setConfigForTesting(testConfig: Config) {
  config = testConfig;
  policy = createPolicyFromConfig(testConfig);
}

/** ---------- Helpers ---------- */
export function ensureCwd(cwd: string, testPolicy?: Policy) {
  const currentPolicy = testPolicy || policy;
  if (!currentPolicy.allowedCwds.some(p => cwd === p || cwd.startsWith(p + "/"))) {
    throw new Error(`cwd not allowed: ${cwd}`);
  }
  try { accessSync(cwd, constants.R_OK | constants.X_OK); }
  catch { throw new Error(`cwd not accessible: ${cwd}`); }
}

export function buildCmdLine(cmd: string, args: string[]): string {
  const joined = [cmd, ...args].join(" ").trim();
  return joined;
}

export function allowedCommand(full: string, testPolicy?: Policy): boolean {
  const currentPolicy = testPolicy || policy;
  if (currentPolicy.deny.some(rx => rx.test(full))) return false;
  return currentPolicy.allow.some(rx => rx.test(full));
}

export function filteredEnv(testPolicy?: Policy): NodeJS.ProcessEnv {
  const currentPolicy = testPolicy || policy;
  const out: NodeJS.ProcessEnv = {};
  for (const k of currentPolicy.envWhitelist) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

export async function execOnce(cmd: string, args: string[], cwd: string, timeoutMs: number, maxBytes: number) {
  const child = spawn(cmd, args, { cwd, env: filteredEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  const started = Date.now();

  const addChunk = (buf: Buffer, chunk: Buffer) =>
    Buffer.concat([buf, chunk.slice(0, Math.max(0, maxBytes - buf.length))]);

  child.stdout.on("data", (c: Buffer) => { stdout = addChunk(stdout, c); });
  child.stderr.on("data", (c: Buffer) => { stderr = addChunk(stderr, c); });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const killer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);

  const result = await exit;
  clearTimeout(killer);

  return {
    durationMs: Date.now() - started,
    exitCode: result.code ?? -1,
    signal: result.signal ?? null,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
  };
}

/** ---------- MCP server & tools ---------- */
export const server = new Server(
  { name: config.server.name, version: config.server.version },
  { capabilities: { tools: {} } }
);

/** ---------- Tool definitions ---------- */
export const tools: Tool[] = [
  {
    name: "shell_exec",
    description: "Execute an allow-listed command with sandboxing and limits.",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string", minLength: 1 },
        args: { type: "array", items: { type: "string" }, default: [] },
        cwd: { type: "string" },
        timeout_ms: { type: "number", minimum: 1, maximum: 300000 }
      },
      required: ["cmd"]
    }
  },
  {
    name: "shell_set_cwd",
    description: "Set the default working directory (must be in allowedCwds).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", minLength: 1 }
      },
      required: ["cwd"]
    }
  },
  {
    name: "shell_set_policy",
    description: "Update policy: cwd allow-list, allow/deny regex, timeout, output cap, env whitelist.",
    inputSchema: {
      type: "object",
      properties: {
        allowed_cwds: { type: "array", items: { type: "string" } },
        default_cwd: { type: "string" },
        allow_patterns: { type: "array", items: { type: "string" } },
        deny_patterns: { type: "array", items: { type: "string" } },
        timeout_ms: { type: "number", minimum: 1, maximum: 300000 },
        max_bytes: { type: "number", minimum: 1000, maximum: 10000000 },
        env_whitelist: { type: "array", items: { type: "string" } }
      }
    }
  }
];

/** ---------- Request handlers ---------- */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  if (name === "shell_exec") {
    const input = args as any;
    const cwd = input.cwd ?? policy.defaultCwd ?? process.cwd();
    ensureCwd(cwd);

    const full = buildCmdLine(input.cmd, input.args || []);
    if (!allowedCommand(full)) {
      return {
        content: [{ type: "text", text: `Denied by policy: ${full}` }],
        isError: true,
      };
    }

    const tmo = Math.min(input.timeout_ms ?? policy.timeoutMs, policy.timeoutMs);
    const res = await execOnce(input.cmd, input.args || [], cwd, tmo, policy.maxBytes);

    return {
      content: [{
        type: "resource",
        resource: {
          uri: `exec://${input.cmd}`,
          text: JSON.stringify({
            ok: res.exitCode === 0,
            exit_code: res.exitCode,
            signal: res.signal,
            duration_ms: res.durationMs,
            stdout: res.stdout,
            stderr: res.stderr,
            cmdline: [input.cmd, ...(input.args || [])],
            cwd
          }, null, 2)
        }
      }]
    };
  }

  if (name === "shell_set_cwd") {
    const input = args as any;
    ensureCwd(input.cwd);
    policy.defaultCwd = input.cwd;
    return { content: [{ type: "text", text: `defaultCwd set to ${input.cwd}` }] };
  }

  if (name === "shell_set_policy") {
    const input = args as any;
    if (input.allowed_cwds) policy.allowedCwds = input.allowed_cwds;
    if (input.default_cwd)  { ensureCwd(input.default_cwd); policy.defaultCwd = input.default_cwd; }
    if (input.allow_patterns) policy.allow = input.allow_patterns.map(makeRegex);
    if (input.deny_patterns)  policy.deny  = input.deny_patterns.map(makeRegex);
    if (input.timeout_ms)     policy.timeoutMs = input.timeout_ms;
    if (input.max_bytes)      policy.maxBytes  = input.max_bytes;
    if (input.env_whitelist)  policy.envWhitelist = input.env_whitelist;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          allowedCwds: policy.allowedCwds,
          defaultCwd: policy.defaultCwd,
          allow: policy.allow.map(r => r.source),
          deny: policy.deny.map(r => r.source),
          timeoutMs: policy.timeoutMs,
          maxBytes: policy.maxBytes,
          envWhitelist: policy.envWhitelist
        }, null, 2)
      }]
    };
  }
  
  throw new Error(`Unknown tool: ${name}`);
});

/** Start stdio transport */
export async function startServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}

// Only start if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  let serverInstance: { server: typeof server; transport: StdioServerTransport } | null = null;

  // Graceful shutdown handler with timeout
  const shutdown = async (signal: string) => {
    // Force exit after 2 seconds if cleanup hangs
    const forceExit = setTimeout(() => {
      console.error(`Force exit after shutdown timeout (${signal})`);
      process.exit(1);
    }, 2000);

    try {
      if (serverInstance?.server) {
        // Try to close the server first
        await serverInstance.server.close();
      }
      if (serverInstance?.transport) {
        // Then close the transport
        await serverInstance.transport.close();
      }
    } catch (error) {
      // Log but continue with shutdown
      console.error(`Shutdown error (${signal}):`, error);
    } finally {
      clearTimeout(forceExit);
      // Always exit, even if cleanup fails
      process.exit(0);
    }
  };

  // Handle various shutdown signals
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  
  // Handle stdio stream closure (when Claude Code exits)
  process.stdin.on('end', () => shutdown('STDIN_END'));
  process.stdin.on('close', () => shutdown('STDIN_CLOSE'));

  // Start the server
  startServer()
    .then((instance) => {
      serverInstance = instance;
      // Set up server close handler
      server.onclose = () => {
        process.exit(0);
      };
    })
    .catch((error) => {
      console.error('Failed to start server:', error);
      process.exit(1);
    });
}
