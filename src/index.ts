import { spawn } from "node:child_process";
import { accessSync, constants, appendFileSync, mkdirSync, existsSync, realpathSync, readFileSync, writeFileSync, unlinkSync, createReadStream, statSync } from "node:fs";
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

export type CursorConfig = {
  cursor_type: string;    // type of cursor positioning (currently only "bytes" supported)
  offset: number;         // byte offset from start of output stream (must be ≥ 0)
};

export type PaginationConfig = {
  cursor?: CursorConfig;  // position marker object for pagination (required when using pagination)
  limit_bytes?: number;   // default: 64 KB
  limit_lines?: number;   // optional: stops on whichever hits first
};

export type LargeOutputBehavior = "spill" | "truncate" | "error";

export type SpillFile = {
  uri: string;
  path: string;
  stderrUri?: string | undefined;
  stderrPath?: string | undefined;
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

/**
 * Parse a bash wrapper command and extract the underlying command for allowlist checking
 * Handles: bash -lc "cmd args", bash -c "cmd args", bash -l -c "cmd args"
 * Returns: { isWrapper: boolean, executableToCheck: string, shouldUseLogin: boolean, commandString?: string, argsAfterCommand?: number, flagsBeforeCommand?: string[] }
 */
export function parseBashWrapper(cmd: string, args: string[]): {
  isWrapper: boolean;
  executableToCheck: string;
  shouldUseLogin: boolean;
  commandString?: string;
  argsAfterCommand?: number;
  flagsBeforeCommand?: string[];
} {
  // Not a wrapper if cmd is not bash or no dash flags
  if (cmd !== "bash" || args.length === 0) {
    return { isWrapper: false, executableToCheck: cmd, shouldUseLogin: false };
  }

  const firstArg = args[0];
  if (!firstArg || !firstArg.startsWith("-")) {
    return { isWrapper: false, executableToCheck: cmd, shouldUseLogin: false };
  }

  // Parse flags to find -c and -l, and track pre-command flags
  let login = false;
  let cmdStr: string | undefined;
  let cmdStrIndex = -1;
  let flagsBeforeCommand: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (!arg) {
      i++;
      continue;
    }

    if (arg.startsWith("-")) {
      // Check for -l flag (only in short form like -l, -lc, -cl, not --noprofile)
      if (arg.startsWith("-") && !arg.startsWith("--")) {
        // Short flags like -l, -lc, -cl
        if (arg.includes("l")) {
          login = true;
        }
      }

      // Check for -c flag (combined like -lc or separate -c)
      if (arg.includes("c") && !arg.startsWith("--")) {
        // For combined flags like -ec, -lc, -xlc, extract non-c/non-l flags BEFORE breaking
        // Split them into individual flags (e.g., -xe becomes ['-x', '-e'])
        const otherFlagsArray = arg.slice(1).split('').filter(f => f !== 'c' && f !== 'l');
        for (const flag of otherFlagsArray) {
          flagsBeforeCommand.push('-' + flag);
        }

        // Next arg should be the command string
        if (i + 1 >= args.length) {
          throw new Error("missing command string after -c");
        }
        cmdStrIndex = i + 1;
        cmdStr = args[cmdStrIndex];
        // Allow empty strings to pass through here - they'll be caught by the tokenizer below
        break;
      }

      // Collect flags that aren't the wrapper's -l or -c (these should be preserved)
      const isStandaloneL = arg === "-l";

      if (!isStandaloneL) {
        // Regular flag (not combined with c, not standalone -l)
        flagsBeforeCommand.push(arg);
        // If this is a flag that takes a value (like -o), preserve the next arg too
        const nextArg = args[i + 1];
        if (i + 1 < args.length && nextArg && !nextArg.startsWith("-")) {
          flagsBeforeCommand.push(nextArg);
          i++;  // Skip the value in next iteration
        }
      }

      i++;
    } else {
      // Non-flag argument before -c (shouldn't happen in normal bash usage, but skip it)
      i++;
    }
  }

  // Require -c flag with command string (check for undefined/null, not empty string)
  if (cmdStr === undefined || cmdStr === null) {
    throw new Error("missing -c command string");
  }

  // Parse the command string to extract the first executable
  // Use a simple tokenizer that respects quotes
  const tokens = parseShellCommand(cmdStr);
  if (tokens.length === 0) {
    throw new Error("empty command string");
  }

  const firstExec = tokens[0];
  if (!firstExec) {
    throw new Error("empty command string");
  }

  return {
    isWrapper: true,
    executableToCheck: firstExec,
    shouldUseLogin: login,
    commandString: cmdStr,
    argsAfterCommand: cmdStrIndex + 1,  // Index after the command string for trailing args
    flagsBeforeCommand  // User-supplied flags like --noprofile, --norc, etc.
  };
}

/**
 * Simple shell command parser that tokenizes a command string
 * Handles basic quoting (single and double quotes) similar to shlex.split()
 */
export function parseShellCommand(cmdStr: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < cmdStr.length; i++) {
    const char = cmdStr[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === " " && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
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

function parseCursor(cursor: CursorConfig | undefined | null): { type: string; offset: number } {
  // Handle object format only (no legacy string support)
  if (!cursor || typeof cursor !== 'object') {
    throw new Error(`Invalid cursor format: expected object, got ${typeof cursor}. Cursor must be an object with 'cursor_type' and 'offset' properties.`);
  }

  // TypeScript should ensure this is a CursorConfig at this point, but let's be safe
  const cursorConfig = cursor as CursorConfig;

  if (!cursor.cursor_type || typeof cursor.cursor_type !== 'string') {
    throw new Error(`Invalid cursor format: missing or invalid 'cursor_type' property. Expected string, got ${typeof cursor.cursor_type}.`);
  }

  // Validate cursor_type is supported
  if (cursor.cursor_type !== 'bytes') {
    throw new Error(`Invalid cursor format: unsupported cursor_type '${cursor.cursor_type}'. Currently only 'bytes' is supported.`);
  }

  // Coerce and validate offset
  let offset: number;
  if (cursor.offset === undefined || cursor.offset === null) {
    offset = 0;
  } else {
    offset = Number(cursor.offset);
    if (!Number.isFinite(offset)) {
      throw new Error(`Invalid cursor format: 'offset' must be a finite number, got ${cursor.offset}.`);
    }
    if (offset < 0) {
      throw new Error(`Invalid cursor format: 'offset' must be non-negative, got ${offset}.`);
    }
  }

  return {
    type: cursorConfig.cursor_type,
    offset: offset
  };
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
      const errors: string[] = [];

      try {
        if (existsSync(path)) {
          unlinkSync(path);
          debugLog("Cleaned up stdout spill file", { path });
        }
      } catch (e) {
        const errorMsg = `Failed to cleanup stdout spill file ${path}: ${e}`;
        errors.push(errorMsg);
        debugLog(errorMsg);
      }

      try {
        if (existsSync(stderrPath)) {
          unlinkSync(stderrPath);
          debugLog("Cleaned up stderr spill file", { stderrPath });
        }
      } catch (e) {
        const errorMsg = `Failed to cleanup stderr spill file ${stderrPath}: ${e}`;
        errors.push(errorMsg);
        debugLog(errorMsg);
      }

      if (errors.length > 0) {
        debugLog("Spill file cleanup completed with errors", { errors });
      }
    }
  };
}

function detectMimeType(content: string): string {
   // Enhanced MIME type detection based on content
   const trimmed = content.trim();

   // JSON detection
   if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
     try {
       JSON.parse(content);
       return "application/json";
     } catch {
       // Not valid JSON, continue with other checks
     }
   }

   // XML detection
   if (trimmed.startsWith('<') && trimmed.includes('</')) {
     return "application/xml";
   }

   // HTML detection
   if (trimmed.startsWith('<!DOCTYPE html') || trimmed.startsWith('<html')) {
     return "text/html";
   }

   // CSV detection (simple heuristic)
   const firstLine = trimmed.split('\n')[0];
   if (trimmed.includes(',') && firstLine && firstLine.split(',').length > 2) {
     return "text/csv";
   }

   // YAML detection (simple heuristic)
   if ((trimmed.startsWith('- ') || trimmed.match(/^\s*\w+:\s/)) && !trimmed.includes(';')) {
     return "application/x-yaml";
   }

   // Default to plain text
   return "text/plain";
 }

function countLines(content: string): number {
  return content.split('\n').length;
}

async function readFileRange(filePath: string, start: number, end: number): Promise<string> {
   // Handle edge case where end <= start to avoid ERR_OUT_OF_RANGE
   if (end <= start) {
     return Promise.resolve('');
   }

   // Use createReadStream to read only the requested byte range
   return new Promise<string>((resolve, reject) => {
     const chunks: Buffer[] = [];
     let totalBytesRead = 0;

     const stream = createReadStream(filePath, { start, end: end - 1 });

     stream.on('data', (chunk: any) => {
       chunks.push(Buffer.from(chunk));
       totalBytesRead += Buffer.from(chunk).length;
     });

     stream.on('end', () => {
       const buffer = Buffer.concat(chunks);
       resolve(buffer.toString('utf8'));
     });

     stream.on('error', (error) => {
       reject(error);
     });
   });
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
  let hasStdoutSpill = false;
  let hasStderrSpill = false;

  if (onLargeOutput === "spill") {
    spillFile = createSpillFile();
  }

  // For pagination, we need to track complete streams but cap memory usage
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let totalStdoutBytes = 0;
  let totalStderrBytes = 0;
  const started = Date.now();

  child.stdout.on("data", (c: Buffer) => {
    totalStdoutBytes += c.length;

    // Cap in-memory buffer to prevent OOM, but keep enough for current page
    const maxMemoryBytes = Math.max(limitBytes * 2, maxBytes); // Keep 2x limit for current page context
    if (stdoutBuffer.length > maxMemoryBytes) {
      // Keep only the last part of the buffer (current page context)
      const keepBytes = Math.min(limitBytes, maxMemoryBytes / 2);
      stdoutBuffer = stdoutBuffer.slice(-keepBytes);
    }

    // Only keep data if we need it for in-memory processing
    if (stdoutBuffer.length + c.length <= maxMemoryBytes) {
      stdoutBuffer = Buffer.concat([stdoutBuffer, c]);
    } else {
      // If adding this chunk would exceed memory limit, just update total but don't store
      debugLog("Skipping stdout buffer storage due to memory limit", { chunkSize: c.length, total: totalStdoutBytes });
    }

    // Write to spill file for complete stream access
    if (spillFile) {
      try {
        appendFileSync(spillFile.path, c);
        hasStdoutSpill = true;
      } catch (e) {
        debugLog("Failed to write to stdout spill file", e);
      }
    }
  });

  child.stderr.on("data", (c: Buffer) => {
    totalStderrBytes += c.length;

    // Cap in-memory buffer to prevent OOM
    const maxMemoryBytes = Math.max(limitBytes * 2, maxBytes);
    if (stderrBuffer.length > maxMemoryBytes) {
      const keepBytes = Math.min(limitBytes, maxMemoryBytes / 2);
      stderrBuffer = stderrBuffer.slice(-keepBytes);
    }

    stderrBuffer = Buffer.concat([stderrBuffer, c]);

    // Write to stderr spill file
    if (spillFile) {
      try {
        appendFileSync(spillFile.stderrPath!, c);
        hasStderrSpill = true;
      } catch (e) {
        debugLog("Failed to write to stderr spill file", e);
      }
    }
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (error) => {
      debugLog("Child process error", { error: error.message });
      resolve({ code: -1, signal: null });
    });
  });

  const killer = setTimeout(() => {
    debugLog("Command timed out, killing process", { timeoutMs });
    child.kill("SIGKILL");
  }, timeoutMs);

  const result = await exit;
  clearTimeout(killer);

  const durationMs = Date.now() - started;

  // For pagination, we need to read from spill files to get accurate byte-aligned data
  let returnedStdout = "";
  let returnedStderr = "";

  if (spillFile && hasStdoutSpill) {
    // Read only the specific byte range from stdout spill file
    try {
      const stdoutEnd = Math.min(startOffset + limitBytes, totalStdoutBytes);
      returnedStdout = await readFileRange(spillFile.path, startOffset, stdoutEnd);
    } catch (e) {
      debugLog("Failed to read from stdout spill file", e);
      // Fallback to in-memory buffer with byte-aware slicing
      const stdoutEnd = Math.min(startOffset + limitBytes, stdoutBuffer.length);
      returnedStdout = stdoutBuffer.subarray(startOffset, stdoutEnd).toString("utf8");
    }
  } else {
    // No spill file, use in-memory buffer with byte-aware slicing
    const stdoutEnd = Math.min(startOffset + limitBytes, stdoutBuffer.length);
    returnedStdout = stdoutBuffer.subarray(startOffset, stdoutEnd).toString("utf8");
  }

  // Handle stderr - use policy limit for in-memory stderr
  if (spillFile && hasStderrSpill) {
    try {
      const stderrEnd = Math.min(maxBytes, totalStderrBytes);
      returnedStderr = await readFileRange(spillFile.stderrPath!, 0, stderrEnd);
    } catch (e) {
      debugLog("Failed to read from stderr spill file", e);
      const stderrEnd = Math.min(maxBytes, stderrBuffer.length);
      returnedStderr = stderrBuffer.subarray(0, stderrEnd).toString("utf8");
    }
  } else {
    const stderrEnd = Math.min(maxBytes, stderrBuffer.length);
    returnedStderr = stderrBuffer.subarray(0, stderrEnd).toString("utf8");
  }

  // Determine if we need pagination
  const stdoutLines = countLines(returnedStdout);
  const stderrLines = countLines(returnedStderr);
  const totalBytes = totalStdoutBytes + totalStderrBytes;
  const needsPagination = totalStdoutBytes > limitBytes || stdoutLines > limitLines;

  let truncated = false;
  let nextCursor: { cursor_type: string; offset: number } | undefined;

  if (needsPagination && onLargeOutput === "truncate") {
    truncated = true;
  } else if (needsPagination && onLargeOutput === "error") {
    throw new Error(`Output too large: ${totalBytes} bytes, ${stdoutLines} lines. Use pagination or spill mode.`);
  } else if (needsPagination && spillFile) {
    // Calculate next cursor based on actual bytes returned
    const actualBytesReturned = Buffer.byteLength(returnedStdout, 'utf8');
    const nextOffset = startOffset + actualBytesReturned;
    if (totalStdoutBytes > nextOffset) {
      nextCursor = { cursor_type: 'bytes', offset: nextOffset };
    }
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
    lineCount: stdoutLines,
    stderrCount: stderrLines
  };

  if (nextCursor) {
    resultObj.nextCursor = nextCursor;
  }

  // Only include spill file if we actually created one and wrote to it
  if (spillFile && (hasStdoutSpill || hasStderrSpill)) {
    // Create a clean spill file object with only the URIs that were actually used
    const cleanSpillFile: SpillFile = {
      uri: hasStdoutSpill ? spillFile.uri : '',
      path: hasStdoutSpill ? spillFile.path : '',
      stderrUri: hasStderrSpill ? spillFile.stderrUri : undefined,
      stderrPath: hasStderrSpill ? spillFile.stderrPath : undefined,
      cleanup: () => {
        try {
          if (hasStdoutSpill && existsSync(spillFile!.path)) {
            unlinkSync(spillFile!.path);
          }
          if (hasStderrSpill && existsSync(spillFile!.stderrPath!)) {
            unlinkSync(spillFile!.stderrPath!);
          }
        } catch (e) {
          debugLog("Failed to cleanup spill files", { path: spillFile!.path, stderrPath: spillFile!.stderrPath, error: e });
        }
      }
    };

    // Only set non-empty URIs
    if (hasStdoutSpill) {
      cleanSpillFile.uri = spillFile.uri;
      cleanSpillFile.path = spillFile.path;
    }
    if (hasStderrSpill) {
      cleanSpillFile.stderrUri = spillFile.stderrUri;
      cleanSpillFile.stderrPath = spillFile.stderrPath;
    }

    resultObj.spillFile = cleanSpillFile;
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
    description: "Execute an allow-listed command within the sandbox (git project root). Optional cwd must be RELATIVE to the sandbox root. Supports pagination via limit_bytes and next_cursor (page and cursor are required for pagination). Automatically spills large outputs to file with spill_uri.",
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
          description: "Pagination configuration.  Pagination is always on and hence a required attribute.",
          properties: {
            cursor: {
              type: "object",
              description: "Position marker indicating where to start reading from the output stream. 0 for first request, then use next_cursor from prior response.",
              properties: {
                cursor_type: {
                  type: "string",
                  description: "Type of cursor positioning. Currently supports 'bytes' for byte-based positioning.",
                  enum: ["bytes"],
                  default: "bytes"
                },
                offset: {
                  type: "number",
                  minimum: 0,
                  description: "Byte offset from the start of the output stream. For 'bytes' cursor_type, this represents the byte position to start reading from.",
                  default: 0
                }
              },
              required: ["cursor_type"]
            },
            limit_bytes: {
              type: "number",
              minimum: 1,
              maximum: 10000000,
              description: "Maximum number of bytes to return in this page. Larger values provide more content but use more memory. Default: 64 KB (65536 bytes).",
              default: 65536
            },
            limit_lines: {
              type: "number",
              minimum: 1,
              maximum: 100000,
              description: "Maximum number of lines to return in this page. The command stops on whichever limit (bytes or lines) is hit first. Useful for text files where line boundaries matter."
            }
          },
          required: ["cursor"]
        },
        on_large_output: { type: "string", enum: ["spill", "truncate", "error"], description: "How to handle large outputs", default: "spill" }
      },
      required: ["cmd", "page"]
    }
  },
  {
    name: "read_file_chunk",
    description: "Reads paginated data from a spilled file (stdout or stderr). Accepts cursor and limit_bytes to safely stream contents.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "URI of the spilled file (e.g., 'mcp://tmp/exec-abc123.out' or 'mcp://tmp/exec-abc123.err')" },
        cursor: {
          type: "object",
          description: "Position marker indicating where to start reading from the file.",
          properties: {
            cursor_type: {
              type: "string",
              description: "Type of cursor positioning. Currently supports 'bytes' for byte-based positioning.",
              enum: ["bytes"],
              default: "bytes"
            },
            offset: {
              type: "number",
              minimum: 0,
              description: "Byte offset from the start of the file.",
              default: 0
            }
          },
          default: { cursor_type: "bytes", offset: 0 }
        },
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

    // Parse bash wrapper to extract underlying command for allowlist checking
    let wrapperInfo: ReturnType<typeof parseBashWrapper>;
    try {
      wrapperInfo = parseBashWrapper(input.cmd, input.args || []);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }

    // Check allowlist against the full underlying command (not just the executable)
    // For wrappers, reconstruct the full command from the parsed tokens
    // For non-wrappers, use the original cmd and args
    let fullCommandForPolicy: string;
    if (wrapperInfo.isWrapper) {
      // Use the tokenized command string to rebuild the full command for policy checking
      const tokens = parseShellCommand(wrapperInfo.commandString!);
      fullCommandForPolicy = tokens.join(" ");
    } else {
      // Direct command - use original cmd and args
      fullCommandForPolicy = buildCmdLine(input.cmd, input.args || []);
    }

    if (!allowedCommand(fullCommandForPolicy)) {
      return {
        content: [{ type: "text", text: `Denied by policy: ${fullCommandForPolicy}` }],
        isError: true,
      };
    }

    // Compute effective per-request limits
    const { effectiveTimeoutMs, effectiveMaxBytes } = getEffectiveLimits(input, policy);

    // Parse pagination and large output handling options
    const pagination: PaginationConfig | undefined = input.page;
    const onLargeOutput: LargeOutputBehavior = input.on_large_output || "spill";

    // Validate cursor format if provided
    if (pagination?.cursor) {
      try {
        parseCursor(pagination.cursor);
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: Invalid cursor format in pagination config: ${error.message}` }],
          isError: true,
        };
      }
    }

    // Determine the actual command and args to execute
    let execCmd: string;
    let execArgs: string[];

    if (wrapperInfo.isWrapper) {
      // Execute via bash with proper flags
      execCmd = "/bin/bash";

      // Start with user-supplied flags (like --noprofile, --norc, etc.)
      execArgs = [...(wrapperInfo.flagsBeforeCommand || [])];

      // Add login flag if needed
      if (wrapperInfo.shouldUseLogin) {
        execArgs.push("-l");
      }

      // Add our execution flags and command
      execArgs.push("-o", "pipefail", "-o", "errexit", "-c", wrapperInfo.commandString!);

      // Append any trailing arguments after the command string (for $0, $1, etc.)
      // e.g., bash -c 'echo "$1"' -- foo  -> trailing args are ["--", "foo"]
      if (wrapperInfo.argsAfterCommand !== undefined && wrapperInfo.argsAfterCommand < input.args.length) {
        const trailingArgs = input.args.slice(wrapperInfo.argsAfterCommand);
        execArgs.push(...trailingArgs);
      }
    } else {
      // Direct execution (no wrapper)
      execCmd = input.cmd;
      execArgs = input.args || [];
    }

    const res = await execWithPagination(
      execCmd,
      execArgs,
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

    const responseObj: any = {
      exit_code: res.exitCode,
      signal: res.signal,
      duration_ms: res.durationMs,
      stdout_chunk: res.stdout,
      stderr_chunk: res.stderr,
      bytes_start: pagination?.cursor ? parseCursor(pagination.cursor).offset : 0,
      bytes_end: pagination?.cursor ? parseCursor(pagination.cursor).offset + Buffer.byteLength(res.stdout, 'utf8') : Buffer.byteLength(res.stdout, 'utf8'),
      total_bytes: res.totalBytes,
      truncated: res.truncated,
      next_cursor: res.nextCursor,
      mime: res.mime,
      line_count: res.lineCount,
      stderr_count: res.stderrCount,
      cmdline: [input.cmd, ...(input.args || [])],
      effective_cmdline: [execCmd, ...execArgs],
      cwd: resolvedCwd,
      limits: {
        timeout_ms: effectiveTimeoutMs,
        max_output_bytes: effectiveMaxBytes
      }
    };

    // Only include spill URIs if they were actually created and used
    if (res.spillFile?.uri) {
      responseObj.spill_uri = res.spillFile.uri;
    }
    if (res.spillFile?.stderrUri) {
      responseObj.stderr_spill_uri = res.spillFile.stderrUri;
    }

    return {
      content: [{
        type: "resource",
        resource: {
          uri: `exec://${input.cmd}`,
          text: JSON.stringify(responseObj, null, 2)
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
    const limitBytes = input.limit_bytes || 65536;

    // Validate cursor format
    try {
      const cursor = input.cursor || { cursor_type: "bytes", offset: 0 };
      parseCursor(cursor); // This will throw if format is invalid
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: Invalid cursor format: ${error.message}` }],
        isError: true,
      };
    }

    const cursor = input.cursor || { cursor_type: "bytes", offset: 0 };

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
       // Get file stats to determine total size without reading whole file
       const totalBytes = statSync(filePath).size;

       const { offset } = parseCursor(cursor);
       const endPos = Math.min(offset + limitBytes, totalBytes);

       // Use range reader to avoid loading whole file into RAM
       const chunk = await readFileRange(filePath, offset, endPos);

       const nextCursor = endPos < totalBytes ? { cursor_type: "bytes", offset: endPos } : undefined;

       return {
         content: [{
           type: "resource",
           resource: {
             uri,
             text: JSON.stringify({
               data: chunk,
               bytes_start: offset,
               bytes_end: endPos,
               total_bytes: totalBytes,
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
