import { spawn } from "node:child_process";
import { accessSync, constants, appendFileSync, mkdirSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { 
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config/index.js";
import { ConfigLoader } from "./config/index.js";

/** ---------- Debug Logging ---------- */
const DEBUG_LOG_PATH = join(homedir(), ".shemcp", "debug.log");

function initDebugLog() {
  try {
    const logDir = join(homedir(), ".shemcp");
    mkdirSync(logDir, { recursive: true });
    // Clear log on startup
    appendFileSync(DEBUG_LOG_PATH, `\n\n========== NEW SESSION: ${new Date().toISOString()} ==========\n`);
  } catch (e) {
    // Ignore logging errors
  }
}

function debugLog(message: string, data?: any) {
  try {
    const timestamp = new Date().toISOString();
    const logMessage = data 
      ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
      : `[${timestamp}] ${message}\n`;
    appendFileSync(DEBUG_LOG_PATH, logMessage);
  } catch (e) {
    // Ignore logging errors
  }
}

/** ---------- Policy (mutable at runtime) ---------- */
export type Policy = {
  rootDirectory: string;   // single root directory that contains all allowed operations
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
    rootDirectory: config.directories.root,
    allow: config.commands.allow.map(makeRegex),
    deny: config.commands.deny.map(makeRegex),
    timeoutMs: config.limits.timeout_seconds * 1000,
    maxBytes: config.limits.max_output_bytes,
    envWhitelist: config.environment.whitelist
  };
}

// Initialize debug logging
initDebugLog();
debugLog("Starting MCP server");

// Load configuration from config files
let config: Config = ConfigLoader.loadConfig();
let policy: Policy = createPolicyFromConfig(config);
debugLog("Config loaded", { configName: config.server.name, version: config.server.version });

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
  // Check if the cwd is the root directory or a subdirectory of the root
  const normalizedCwd = resolve(cwd);
  const normalizedRoot = resolve(currentPolicy.rootDirectory);
  
  if (!normalizedCwd.startsWith(normalizedRoot)) {
    throw new Error(`cwd not allowed: ${cwd} (must be within ${currentPolicy.rootDirectory})`);
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
debugLog("Server instance created");

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
    description: "Set the root directory (must be within the current root directory or a subdirectory).",
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
    description: "Update policy: allow/deny regex, timeout, output cap, env whitelist. Root directory is automatic.",
    inputSchema: {
      type: "object",
      properties: {
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
  debugLog("ListTools request received");
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  debugLog("CallTool request received", { tool: name });
  
  if (name === "shell_exec") {
    const input = args as any;
    const cwd = input.cwd ?? policy.rootDirectory;
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
    // Update the root directory to be the new cwd (but only if it's within the current root)
    const normalizedNewCwd = resolve(input.cwd);
    const normalizedCurrentRoot = resolve(policy.rootDirectory);
    
    if (!normalizedNewCwd.startsWith(normalizedCurrentRoot)) {
      return {
        content: [{ type: "text", text: `Error: Cannot set cwd outside of root directory ${policy.rootDirectory}` }],
        isError: true,
      };
    }
    
    policy.rootDirectory = input.cwd;
    return { content: [{ type: "text", text: `Root directory set to ${input.cwd}` }] };
  }

  if (name === "shell_set_policy") {
    const input = args as any;
    if (input.allow_patterns) policy.allow = input.allow_patterns.map(makeRegex);
    if (input.deny_patterns)  policy.deny  = input.deny_patterns.map(makeRegex);
    if (input.timeout_ms)     policy.timeoutMs = input.timeout_ms;
    if (input.max_bytes)      policy.maxBytes  = input.max_bytes;
    if (input.env_whitelist)  policy.envWhitelist = input.env_whitelist;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          rootDirectory: policy.rootDirectory,
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
  debugLog("Starting stdio transport");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debugLog("Server connected to transport");
  return { server, transport };
}

// Only start if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  let serverInstance: { server: typeof server; transport: StdioServerTransport } | null = null;

  // Track if we're already shutting down
  let isShuttingDown = false;

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    debugLog(`Shutdown initiated: ${signal}`);
    if (isShuttingDown) {
      debugLog("Already shutting down, ignoring duplicate signal");
      return;
    }
    isShuttingDown = true;
    debugLog("Setting isShuttingDown flag to true");

    // Don't log to stderr/stdout during shutdown to avoid protocol issues
    // Just try to clean up silently
    try {
      if (serverInstance?.transport) {
        debugLog("Attempting to close transport");
        await serverInstance.transport.close();
        debugLog("Transport closed successfully");
      } else {
        debugLog("No transport to close");
      }
    } catch (error) {
      // Ignore errors but log them
      debugLog("Error closing transport", error);
    }

    // For SIGINT/SIGTERM, exit cleanly with code 0
    // This tells Claude Code we shut down properly
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      debugLog(`Exiting with code 0 for signal: ${signal}`);
      process.exit(0);
    } else {
      // For other signals, exit with code 1
      debugLog(`Exiting with code 1 for signal: ${signal}`);
      process.exit(1);
    }
  };

  // Handle shutdown signals
  process.on('SIGINT', () => {
    debugLog("SIGINT received");
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    debugLog("SIGTERM received");
    shutdown('SIGTERM');
  });
  
  // Log other process events for debugging
  process.on('exit', (code) => {
    debugLog(`Process exiting with code: ${code}`);
  });
  
  process.on('beforeExit', (code) => {
    debugLog(`Process beforeExit event, code: ${code}`);
  });
  
  process.on('uncaughtException', (error) => {
    debugLog("Uncaught exception", { error: error.message, stack: error.stack });
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    debugLog("Unhandled rejection", { reason });
  });
  
  // Handle stdio stream closure (when Claude Code exits)
  // Don't handle these - let the process end naturally
  // process.stdin.on('end', () => shutdown('STDIN_END'));
  // process.stdin.on('close', () => shutdown('STDIN_CLOSE'));

  // Start the server
  debugLog("Initializing server startup");
  startServer()
    .then((instance) => {
      serverInstance = instance;
      debugLog("Server started successfully");
      // Don't set up server close handler - let signals handle shutdown
    })
    .catch((error) => {
      debugLog("Failed to start server", { error: error.message, stack: error.stack });
      console.error('Failed to start server:', error);
      process.exit(1);
    });
}
