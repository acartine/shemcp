#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
// Load package.json without using JSON import attributes (Node 18 compatible)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../package.json");
import type { Config } from "./config/index.js";
import { ConfigLoader } from "./config/index.js";

// Import from new modules
import { initDebugLog, debugLog } from "./lib/debug.js";
import { type Policy, createPolicyFromConfig } from "./lib/policy.js";
import { deriveSandboxRoot } from "./lib/sandbox.js";
import { tools } from "./tools/definitions.js";
import { handleShellExec } from "./handlers/shell-exec.js";
import { handleShellInfo } from "./handlers/shell-info.js";
import { handleReadFileChunk } from "./handlers/read-file-chunk.js";

// Re-export types and functions for testing and backward compatibility
export type { Policy, PolicyCheckResult } from "./lib/policy.js";
export {
  makeRegex,
  createPolicyFromConfig,
  checkCommandPolicy,
  allowedCommand,
  filteredEnv,
  ensureCwd,
  getEffectiveLimits
} from "./lib/policy.js";
export { buildCmdLine, parseBashWrapper, parseShellWrapper, parseShellCommand } from "./lib/command.js";
export { tools } from "./tools/definitions.js";

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

// Override rootDirectory to dynamic detection to avoid shrinking into subfolders
const derivedRoot = deriveSandboxRoot();
policy.rootDirectory = derivedRoot;
debugLog("Derived sandbox root", { derivedRoot });
const PKG_VERSION: string = (pkg as any).version ?? "0.0.0";
debugLog("Config loaded", { configName: config.server.name, serverVersion: PKG_VERSION });

// Export functions for testing
export { config, policy };

// Function to override config for testing
export function setConfigForTesting(testConfig: Config) {
  config = testConfig;
  policy = createPolicyFromConfig(testConfig);
}

/** ---------- MCP server & tools ---------- */
export const server = new Server(
  { name: config.server.name, version: PKG_VERSION },
  { capabilities: { tools: {} } }
);
debugLog("Server instance created");

/** ---------- Request handlers ---------- */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  debugLog("ListTools request received");
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  debugLog("CallTool request received", { tool: name });

  if (name === "shell_exec") {
    return await handleShellExec(args, policy);
  }

  if (name === "shell_info") {
    return handleShellInfo(policy, PKG_VERSION);
  }

  if (name === "read_file_chunk") {
    return await handleReadFileChunk(args);
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
if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
