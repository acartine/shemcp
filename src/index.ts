import { spawn } from "node:child_process";
import { accessSync, constants, appendFileSync, mkdirSync, existsSync, realpathSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join, resolve, relative as pathRelative, isAbsolute as pathIsAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { 
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Load package.json without using JSON import attributes (Node 18 compatible)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../package.json");
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

export type PaginationConfig = {
  cursor?: string;        // opaque position marker, e.g., "bytes:0"
  limit_bytes?: number;   // default: 64 KB
  limit_lines?: number;   // optional: stops on whichever hits first
};

export type LargeOutputBehavior = "spill" | "truncate" | "error";

export type SpillFile = {
  uri: string;
  path: string;
  stderrUri?: string;
  stderrPath?: string;
  cleanup: () => void;
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
debugLog("Process arguments", process.argv);
debugLog("Process cwd", process.cwd());
debugLog("Environment variables", {
  PWD: process.env.PWD,
  OLDPWD: process.env.OLDPWD,
  PATH: process.env.PATH?.split(':').slice(0, 5), // Just first 5 for brevity
  USER: process.env.USER,
  HOME: process.env.HOME,
  // Check for any Claude-specific env vars
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => 
      key.toLowerCase().includes('claude') || 
      key.toLowerCase().includes('mcp') ||
      key.toLowerCase().includes('anthropic')
    )
  )
});

// Load configuration from config files
let config: Config = ConfigLoader.loadConfig();
let policy: Policy = createPolicyFromConfig(config);

/** Derive a stable sandbox root:
 * 1) SHEMCP_ROOT or MCP_SANDBOX_ROOT env var if set
 * 2) nearest Git repo root from process.cwd()
 * 3) process.cwd() as a fallback
 */
function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function deriveSandboxRoot(): string {
  const envRoot = process.env.SHEMCP_ROOT || process.env.MCP_SANDBOX_ROOT;
  if (envRoot && existsSync(envRoot)) return resolve(envRoot);
  const gitRoot = findGitRoot(process.cwd());
  if (gitRoot) return resolve(gitRoot);
  return resolve(process.cwd());
}

// Override rootDirectory to dynamic detection to avoid shrinking into subfolders
const derivedRoot = deriveSandboxRoot();
policy.rootDirectory = derivedRoot;
debugLog("Derived sandbox root", { derivedRoot });
const PKG_VERSION: string = (pkg as any).version ?? "0.0.0";
debugLog("Config loaded", { configName: config.server.name, serverVersion: PKG_VERSION });

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
  // 1) Check simple prefix boundary using resolved paths (works for non-existent paths)
  const normalizedCwd = resolve(cwd);
  const normalizedRoot = resolve(currentPolicy.rootDirectory);
  const boundary = normalizedRoot === normalizedCwd || normalizedCwd.startsWith(normalizedRoot + (normalizedRoot.endsWith("/") ? "" : "/"));
  if (!boundary) {
    throw new Error(`cwd not allowed: ${cwd} (must be within ${currentPolicy.rootDirectory})`);
  }

  // 2) Ensure path exists and is accessible
  try { accessSync(cwd, constants.R_OK | constants.X_OK); }
  catch { throw new Error(`cwd not accessible: ${cwd}`); }

  // 3) Mitigate symlink escapes: re-check boundary using real paths
  try {
    const realCwd = realpathSync(cwd);
    const realRoot = realpathSync(currentPolicy.rootDirectory);
    const rel = pathRelative(realRoot, realCwd);
    const within = rel === "" || (!rel.startsWith("..") && !pathIsAbsolute(rel));
    if (!within) {
      throw new Error(`cwd not allowed: ${cwd} (resolved outside sandbox root)`);
    }
  } catch (e: any) {
    if (e?.message?.includes("cwd not allowed")) throw e;
    // realpath errors should map to accessibility issues
    throw new Error(`cwd not accessible: ${cwd}`);
  }
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

/** ---------- Pagination Helpers ---------- */

function parseCursor(cursor: string): { type: string; offset: number } {
  const [type, offsetStr] = cursor.split(':');
  return { type: type || 'bytes', offset: parseInt(offsetStr || '0', 10) };
}

function createSpillFile(): SpillFile {
  const tempDir = join(homedir(), ".shemcp", "tmp");
  mkdirSync(tempDir, { recursive: true });

  const id = randomUUID();
  const path = join(tempDir, `exec-${id}.out`);
  const uri = `mcp://tmp/exec-${id}.out`;
  const stderrPath = join(tempDir, `exec-${id}.err`);
  const stderrUri = `mcp://tmp/exec-${id}.err`;

  return {
    uri,
    path,
    stderrUri,
    stderrPath,
    cleanup: () => {
      try {
        if (existsSync(path)) {
          unlinkSync(path);
        }
        if (existsSync(stderrPath)) {
          unlinkSync(stderrPath);
        }
      } catch (e) {
        debugLog("Failed to cleanup spill files", { path, stderrPath, error: e });
      }
    }
  };
}

function detectMimeType(content: string): string {
  // Simple MIME type detection based on content
  if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
    try {
      JSON.parse(content);
      return "application/json";
    } catch {
      // Not valid JSON, continue with text/plain
    }
  }
  return "text/plain";
}

function countLines(content: string): number {
  return content.split('\n').length;
}

async function execWithPagination(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  pagination?: PaginationConfig,
  onLargeOutput: LargeOutputBehavior = "spill"
): Promise<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  totalBytes: number;
  truncated: boolean;
  nextCursor?: string;
  spillFile?: SpillFile;
  mime: string;
  lineCount: number;
  stderrCount: number;
}> {
  const child = spawn(cmd, args, { cwd, env: filteredEnv(), stdio: ["ignore", "pipe", "pipe"] });

  // Parse pagination config
  const limitBytes = pagination?.limit_bytes || 65536;
  const limitLines = pagination?.limit_lines || 2000;
  const startOffset = pagination?.cursor ? parseCursor(pagination.cursor).offset : 0;

  // Create spill file if needed
  let spillFile: SpillFile | undefined;
  if (onLargeOutput === "spill") {
    spillFile = createSpillFile();
  }

  // Collect all output for accurate slicing
  let fullStdout = Buffer.alloc(0);
  let fullStderr = Buffer.alloc(0);
  let totalStdoutBytes = 0;
  let totalStderrBytes = 0;
  const started = Date.now();

  child.stdout.on("data", (c: Buffer) => {
    // Always accumulate the complete output
    fullStdout = Buffer.concat([fullStdout, c]);
    totalStdoutBytes += c.length;

    // Write complete stream to spill file for accurate pagination
    if (spillFile) {
      try {
        appendFileSync(spillFile.path, c);
      } catch (e) {
        debugLog("Failed to write to stdout spill file", e);
      }
    }
  });

  child.stderr.on("data", (c: Buffer) => {
    // Always accumulate the complete output
    fullStderr = Buffer.concat([fullStderr, c]);
    totalStderrBytes += c.length;

    // Write complete stream to stderr spill file
    if (spillFile) {
      try {
        appendFileSync(spillFile.stderrPath!, c);
      } catch (e) {
        debugLog("Failed to write to stderr spill file", e);
      }
    }
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const killer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);

  const result = await exit;
  clearTimeout(killer);

  const durationMs = Date.now() - started;
  const fullStdoutStr = fullStdout.toString("utf8");
  const fullStderrStr = fullStderr.toString("utf8");

  // Calculate what portion to return for this page
  const stdoutEnd = Math.min(startOffset + limitBytes, totalStdoutBytes);
  const returnedStdout = fullStdoutStr.substring(startOffset, stdoutEnd);
  const returnedStderr = fullStderrStr.substring(0, Math.min(maxBytes, totalStderrBytes));

  // Determine if we need pagination
  const stdoutLines = countLines(fullStdoutStr);
  const stderrLines = countLines(fullStderrStr);
  const totalBytes = totalStdoutBytes + totalStderrBytes;
  const needsPagination = totalStdoutBytes > limitBytes || stdoutLines > limitLines;

  let truncated = false;
  let nextCursor: string | undefined;

  if (needsPagination && onLargeOutput === "truncate") {
    truncated = true;
  } else if (needsPagination && onLargeOutput === "error") {
    throw new Error(`Output too large: ${totalBytes} bytes, ${stdoutLines} lines. Use pagination or spill mode.`);
  } else if (needsPagination && spillFile) {
    // In spill mode, we return partial content and spill URI
    nextCursor = totalStdoutBytes > stdoutEnd ? `bytes:${stdoutEnd}` : undefined;
  }

  const resultObj: any = {
    exitCode: result.code ?? -1,
    signal: result.signal ?? null,
    stdout: returnedStdout,
    stderr: returnedStderr,
    durationMs,
    totalBytes,
    truncated,
    mime: detectMimeType(returnedStdout),
    lineCount: countLines(returnedStdout),
    stderrCount: countLines(returnedStderr)
  };

  if (nextCursor) {
    resultObj.nextCursor = nextCursor;
  }

  if (spillFile) {
    resultObj.spillFile = spillFile;
  }

  return resultObj;
}

// Compute effective per-call limits from request input and global policy
export function getEffectiveLimits(input: any, testPolicy?: Policy): { effectiveTimeoutMs: number; effectiveMaxBytes: number } {
  const currentPolicy = testPolicy || policy;
  // Back-compat: allow legacy timeout_ms, but prefer timeout_seconds if present
  const providedTimeoutMs = typeof input?.timeout_ms === 'number' ? input.timeout_ms : undefined;
  const providedTimeoutSeconds = typeof input?.timeout_seconds === 'number' ? input.timeout_seconds : undefined;
  let effectiveTimeoutMs = currentPolicy.timeoutMs;
  if (typeof providedTimeoutSeconds === 'number') {
    // clamp to [1s, 300s] and also not exceed policy limit
    const seconds = Math.max(1, Math.min(300, Math.floor(providedTimeoutSeconds)));
    effectiveTimeoutMs = Math.min(seconds * 1000, currentPolicy.timeoutMs);
  } else if (typeof providedTimeoutMs === 'number') {
    // clamp to [1ms, policy.timeoutMs]
    const ms = Math.max(1, Math.min(providedTimeoutMs, 300000));
    effectiveTimeoutMs = Math.min(ms, currentPolicy.timeoutMs);
  }

  // max_output_bytes override with clamp [1000, 10_000_000] but not exceed policy cap
  const providedMaxBytes = typeof input?.max_output_bytes === 'number' ? input.max_output_bytes : undefined;
  let effectiveMaxBytes = currentPolicy.maxBytes;
  if (typeof providedMaxBytes === 'number') {
    const clamped = Math.max(1000, Math.min(10_000_000, Math.floor(providedMaxBytes)));
    effectiveMaxBytes = Math.min(clamped, currentPolicy.maxBytes);
  }

  return { effectiveTimeoutMs, effectiveMaxBytes };
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
  { name: config.server.name, version: PKG_VERSION },
  { capabilities: { tools: {} } }
);
debugLog("Server instance created");

/** ---------- Tool definitions ---------- */
export const tools: Tool[] = [
  {
    name: "shell_exec",
    description: "Execute an allow-listed command within the sandbox (git project root). Optional cwd must be RELATIVE to the sandbox root. Supports pagination via limit_bytes and next_cursor. Automatically spills large outputs to file with spill_uri.",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string", minLength: 1, description: "The command to execute (e.g., 'git', 'npm', 'python')" },
        args: { type: "array", items: { type: "string" }, default: [], description: "Command arguments as an array of strings (e.g., ['status', '--short'])" },
        cwd: { type: "string", description: "Relative path from sandbox root (no absolute paths)" },
        // Deprecated: prefer timeout_seconds; kept for backward-compat
        timeout_ms: { type: "number", minimum: 1, maximum: 300000, description: "Command timeout in milliseconds (deprecated, use timeout_seconds instead)" },
        // New optional per-request overrides
        timeout_seconds: { type: "number", minimum: 1, maximum: 300, description: "Command timeout in seconds (1-300, will be clamped to policy limits)" },
        max_output_bytes: { type: "number", minimum: 1000, maximum: 10000000, description: "Maximum output size in bytes (1000-10M, will be clamped to policy limits)" },
        page: {
          type: "object",
          properties: {
            cursor: { type: "string", description: "Opaque position marker (e.g., 'bytes:0')" },
            limit_bytes: { type: "number", minimum: 1, maximum: 10000000, description: "Default: 64 KB", default: 65536 },
            limit_lines: { type: "number", minimum: 1, maximum: 100000, description: "Optional: stops on whichever hits first" }
          }
        },
        on_large_output: { type: "string", enum: ["spill", "truncate", "error"], description: "How to handle large outputs", default: "spill" }
      },
      required: ["cmd"]
    }
  },
  {
    name: "read_file_chunk",
    description: "Reads paginated data from a spilled file (stdout or stderr). Accepts cursor and limit_bytes to safely stream contents.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "URI of the spilled file (e.g., 'mcp://tmp/exec-abc123.out' or 'mcp://tmp/exec-abc123.err')" },
        cursor: { type: "string", description: "Opaque position marker (e.g., 'bytes:0')", default: "bytes:0" },
        limit_bytes: { type: "number", minimum: 1, maximum: 10000000, description: "Maximum bytes to read", default: 65536 }
      },
      required: ["uri"]
    }
  },
  {
    name: "shell_info",
    description: "Get sandbox information (sandbox root) and optionally resolve a relative cwd against it.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Optional relative path to resolve and check against sandbox root" }
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
    // Enforce relative cwd only; default to sandbox root
    if (input.cwd && pathIsAbsolute(input.cwd)) {
      return {
        content: [{ type: "text", text: `Error: cwd must be a relative path within sandbox root. Received absolute: ${input.cwd}. Sandbox root: ${policy.rootDirectory}` }],
        isError: true,
      };
    }
    const resolvedCwd = resolve(policy.rootDirectory, input.cwd || ".");
    ensureCwd(resolvedCwd);

    const full = buildCmdLine(input.cmd, input.args || []);
    if (!allowedCommand(full)) {
      return {
        content: [{ type: "text", text: `Denied by policy: ${full}` }],
        isError: true,
      };
    }

    // Compute effective per-request limits
    const { effectiveTimeoutMs, effectiveMaxBytes } = getEffectiveLimits(input, policy);

    // Parse pagination and large output handling options
    const pagination: PaginationConfig | undefined = input.page;
    const onLargeOutput: LargeOutputBehavior = input.on_large_output || "spill";

    const res = await execWithPagination(
      input.cmd,
      input.args || [],
      resolvedCwd,
      effectiveTimeoutMs,
      effectiveMaxBytes,
      pagination,
      onLargeOutput
    );

    // Clean up spill file after response if not needed for pagination
    if (res.spillFile && !res.nextCursor) {
      res.spillFile.cleanup();
      delete res.spillFile;
    }

    return {
      content: [{
        type: "resource",
        resource: {
          uri: `exec://${input.cmd}`,
          text: JSON.stringify({
            exit_code: res.exitCode,
            signal: res.signal,
            duration_ms: res.durationMs,
            stdout_chunk: res.stdout,
            stderr_chunk: res.stderr,
            bytes_start: pagination?.cursor ? parseCursor(pagination.cursor).offset : 0,
            bytes_end: pagination?.cursor ? parseCursor(pagination.cursor).offset + res.stdout.length : res.stdout.length,
            total_bytes: res.totalBytes,
            truncated: res.truncated,
            next_cursor: res.nextCursor,
            spill_uri: res.spillFile?.uri,
            stderr_spill_uri: res.spillFile?.stderrUri,
            mime: res.mime,
            line_count: res.lineCount,
            stderr_count: res.stderrCount,
            cmdline: [input.cmd, ...(input.args || [])],
            cwd: resolvedCwd,
            limits: {
              timeout_ms: effectiveTimeoutMs,
              max_output_bytes: effectiveMaxBytes
            }
          }, null, 2)
        }
      }]
    };
  }

  if (name === "shell_info") {
    const input = (args as any) || {};
    const root = resolve(policy.rootDirectory);
    let info: any = { sandbox_root: root };
    if (typeof input.cwd === 'string' && input.cwd.length > 0) {
      const isAbs = pathIsAbsolute(input.cwd);
      const resolved = isAbs ? input.cwd : resolve(root, input.cwd);
      let within = false;
      try {
        const realRoot = realpathSync(root);
        const realPath = existsSync(resolved) ? realpathSync(resolved) : resolved;
        const rel = pathRelative(realRoot, realPath);
        within = rel === "" || (!rel.startsWith("..") && !pathIsAbsolute(rel));
      } catch {
        // If realpath fails (non-existent), fall back to prefix-based check
        const normResolved = resolve(resolved);
        within = normResolved === root || normResolved.startsWith(root + (root.endsWith("/") ? "" : "/"));
      }
      info = {
        ...info,
        input_cwd: input.cwd,
        absolute_input: isAbs,
        resolved_path: resolved,
        within_sandbox: !isAbs && within,
        note: isAbs ? "Absolute cwd is rejected by shell_exec; provide a relative path." : undefined
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(info, null, 2) }]
    };
  }

  if (name === "read_file_chunk") {
    const input = args as any;
    const uri = input.uri;
    const cursor = input.cursor || "bytes:0";
    const limitBytes = input.limit_bytes || 65536;

    // Extract file path from URI
    if (!uri.startsWith("mcp://tmp/")) {
      return {
        content: [{ type: "text", text: `Error: Invalid URI format. Expected mcp://tmp/..., got: ${uri}` }],
        isError: true,
      };
    }

    const fileName = uri.substring("mcp://tmp/".length);
    const filePath = join(homedir(), ".shemcp", "tmp", fileName);

    if (!existsSync(filePath)) {
      return {
        content: [{ type: "text", text: `Error: Spill file not found: ${filePath}` }],
        isError: true,
      };
    }

    try {
      const fileContent = readFileSync(filePath, 'utf8');
      const { offset } = parseCursor(cursor);
      const endPos = Math.min(offset + limitBytes, fileContent.length);
      const chunk = fileContent.substring(offset, endPos);

      const nextCursor = endPos < fileContent.length ? `bytes:${endPos}` : undefined;

      return {
        content: [{
          type: "resource",
          resource: {
            uri,
            text: JSON.stringify({
              data: chunk,
              bytes_start: offset,
              bytes_end: endPos,
              total_bytes: fileContent.length,
              next_cursor: nextCursor,
              mime: detectMimeType(chunk)
            }, null, 2)
          }
        }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error reading spill file: ${error}` }],
        isError: true,
      };
    }
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
