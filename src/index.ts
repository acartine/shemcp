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

export const policy: Policy = {
  allowedCwds: [
    "/Users/cartine/brutus",
    "/Users/cartine/chat",
  ],
  defaultCwd: "/Users/cartine/chat",
  allow: [
    /^git(\s|$)/i,
    /^gh(\s|$)/i,
    /^make(\s|$)/i,
    /^grep(\s|$)/i,
    /^sed(\s|$)/i,
    /^jq(\s|$)/i,
    /^aws(\s|$)/i,
    /^az(\s|$)/i,
    /^bash\s+-lc\s+/i, // explicit: only bash -lc "..."
  ],
  deny: [
    /^git\s+push(\s+.*)?\s+(origin\s+)?(main|master)(\s+.*)?$/i,
    /^git\s+push\s*$/i, // force explicit branch/ref
  ],
  timeoutMs: 60_000,
  maxBytes: 2_000_000,
  envWhitelist: ["PATH", "HOME", "LANG", "LC_ALL"]
};

/** ---------- Helpers ---------- */
export function ensureCwd(cwd: string) {
  if (!policy.allowedCwds.some(p => cwd === p || cwd.startsWith(p + "/"))) {
    throw new Error(`cwd not allowed: ${cwd}`);
  }
  try { accessSync(cwd, constants.R_OK | constants.X_OK); }
  catch { throw new Error(`cwd not accessible: ${cwd}`); }
}

export function buildCmdLine(cmd: string, args: string[]): string {
  const joined = [cmd, ...args].join(" ").trim();
  return joined;
}

export function allowedCommand(full: string): boolean {
  if (policy.deny.some(rx => rx.test(full))) return false;
  return policy.allow.some(rx => rx.test(full));
}

export function filteredEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of policy.envWhitelist) {
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
  { name: "mcp-shell-safe", version: "0.1.0" },
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
  startServer().catch(console.error);
}
