import { resolve, isAbsolute as pathIsAbsolute } from "node:path";
import type { Policy } from "../lib/policy.js";
import { ensureCwd, checkCommandPolicy, getEffectiveLimits } from "../lib/policy.js";
import { buildCmdLine, parseBashWrapper, parseShellCommand } from "../lib/command.js";
import {
  type PaginationConfig,
  type LargeOutputBehavior,
  parseCursor,
  MAX_PAGE_LIMIT_BYTES
} from "../lib/pagination.js";
import { execWithPagination } from "../lib/execution.js";

export async function handleShellExec(args: any, policy: Policy) {
  const input = args as any;

  if (!input.page || typeof input.page !== "object") {
    return {
      content: [{ type: "text", text: "Error: pagination parameters are required" }],
      isError: true,
    };
  }

  // Enforce relative cwd only; default to sandbox root
  if (input.cwd && pathIsAbsolute(input.cwd)) {
    return {
      content: [{ type: "text", text: `Error: cwd must be a relative path within sandbox root. Received absolute: ${input.cwd}. Sandbox root: ${policy.rootDirectory}` }],
      isError: true,
    };
  }
  const resolvedCwd = resolve(policy.rootDirectory, input.cwd || ".");
  ensureCwd(resolvedCwd, policy);

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

  // Check policy with detailed diagnostics
  const policyCheck = checkCommandPolicy(fullCommandForPolicy, policy);
  if (!policyCheck.allowed) {
    let errorMessage = `Denied by policy: ${fullCommandForPolicy}

`;
    errorMessage += `Reason: ${policyCheck.reason}`;

    if (policyCheck.matchedRule) {
      errorMessage += `
Matched ${policyCheck.ruleType} rule: /${policyCheck.matchedRule}/`;
    }

    // For wrapped commands, show both the original input and unwrapped command
    if (wrapperInfo.isWrapper) {
      const originalCmd = buildCmdLine(input.cmd, input.args || []);
      if (originalCmd !== fullCommandForPolicy) {
        errorMessage += `

Original command: ${originalCmd}`;
        errorMessage += `
Unwrapped command: ${fullCommandForPolicy}`;
      }
    }

    return {
      content: [{ type: "text", text: errorMessage }],
      isError: true,
    };
  }

  // Compute effective per-request limits
  const { effectiveTimeoutMs, effectiveMaxBytes } = getEffectiveLimits(input, policy);

  // Parse pagination and large output handling options
  const pagination = input.page as PaginationConfig;
  const onLargeOutput: LargeOutputBehavior = input.on_large_output || "spill";

  if (pagination.limit_bytes !== undefined) {
    const limitBytes = Number(pagination.limit_bytes);
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
      return {
        content: [{ type: "text", text: "Error: limit_bytes must be a positive number" }],
        isError: true,
      };
    }
    if (limitBytes > MAX_PAGE_LIMIT_BYTES) {
      return {
        content: [{
          type: "text",
          text: `Error: limit_bytes must be <= ${MAX_PAGE_LIMIT_BYTES}`,
        }],
        isError: true,
      };
    }
  }

  // Validate cursor format if provided
  let parsedCursor: ReturnType<typeof parseCursor> | undefined;
  if (pagination.cursor) {
    try {
      parsedCursor = parseCursor(pagination.cursor);
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
    policy,
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
    bytes_start: parsedCursor?.offset ?? 0,
    bytes_end: (parsedCursor?.offset ?? 0) + Buffer.byteLength(res.stdout, 'utf8'),
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
