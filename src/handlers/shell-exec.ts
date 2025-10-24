import { resolve, isAbsolute as pathIsAbsolute } from "node:path";
import type { Policy } from "../lib/policy.js";
import { ensureCwd, checkCommandPolicy, getEffectiveLimits } from "../lib/policy.js";
import { buildCmdLine, parseBashWrapper, parseShellCommand, stripEnvPrefix, parseEnvVars } from "../lib/command.js";
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

  // Strip environment variable prefixes before parsing
  // e.g., FOO=bar npm run test -> { envVars: ["FOO=bar"], cmd: "npm", args: ["run", "test"] }
  let envVars: string[] = [];
  let cmdWithoutEnv: string;
  let argsWithoutEnv: string[];
  try {
    const stripped = stripEnvPrefix(input.cmd, input.args || []);
    envVars = stripped.envVars;
    cmdWithoutEnv = stripped.cmd;
    argsWithoutEnv = stripped.args;
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  // Parse bash wrapper to extract underlying command for allowlist checking
  // Use the command WITHOUT env vars for parsing and validation
  let wrapperInfo: ReturnType<typeof parseBashWrapper>;
  try {
    wrapperInfo = parseBashWrapper(cmdWithoutEnv, argsWithoutEnv);
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  // Check allowlist against the full underlying command (not just the executable)
  // For wrappers, reconstruct the full command from the parsed tokens
  // For non-wrappers, use the cmd and args WITHOUT env vars
  let fullCommandForPolicy: string;
  if (wrapperInfo.isWrapper) {
    // Use the tokenized command string to rebuild the full command for policy checking
    const tokens = parseShellCommand(wrapperInfo.commandString!);
    fullCommandForPolicy = tokens.join(" ");
  } else {
    // Direct command - use cmd and args WITHOUT env var prefix
    fullCommandForPolicy = buildCmdLine(cmdWithoutEnv, argsWithoutEnv);
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
    // Execute via the appropriate shell (bash or sh)
    execCmd = wrapperInfo.shell === 'sh' ? "/bin/sh" : "/bin/bash";

    // Start with user-supplied flags (like --noprofile, --norc, etc.)
    execArgs = [...(wrapperInfo.flagsBeforeCommand || [])];

    // Add login flag if needed
    if (wrapperInfo.shouldUseLogin) {
      execArgs.push("-l");
    }

    // Prepend env vars to the command string if any
    // e.g., "FOO=bar npm run test" becomes "FOO=bar npm run test" in the shell
    let commandString = wrapperInfo.commandString!;
    if (envVars.length > 0) {
      commandString = envVars.join(" ") + " " + commandString;
    }

    // Add our execution flags and command
    // Note: pipefail is bash-specific and not POSIX-compliant, so only add it for bash
    if (wrapperInfo.shell === 'bash') {
      execArgs.push("-o", "pipefail", "-o", "errexit", "-c", commandString);
    } else {
      // For sh, use the portable short form -e instead of -o errexit (POSIX-compliant)
      execArgs.push("-e", "-c", commandString);
    }

    // Append any trailing arguments after the command string (for $0, $1, etc.)
    // e.g., bash -c 'echo "$1"' -- foo  -> trailing args are ["--", "foo"]
    // Need to calculate the correct offset in the original args array
    // argsAfterCommand is relative to argsWithoutEnv, so add the envVars length
    const originalArgsAfterCommand = wrapperInfo.argsAfterCommand !== undefined
      ? wrapperInfo.argsAfterCommand + envVars.length
      : undefined;
    if (originalArgsAfterCommand !== undefined && originalArgsAfterCommand < input.args.length) {
      const trailingArgs = input.args.slice(originalArgsAfterCommand);
      execArgs.push(...trailingArgs);
    }
  } else {
    // Direct execution (no wrapper)
    execCmd = cmdWithoutEnv;
    execArgs = argsWithoutEnv;
  }

  // Parse env vars from KEY=value format to pass to spawn
  const additionalEnv = envVars.length > 0 ? parseEnvVars(envVars) : undefined;

  const res = await execWithPagination(
    execCmd,
    execArgs,
    resolvedCwd,
    effectiveTimeoutMs,
    effectiveMaxBytes,
    policy,
    pagination,
    onLargeOutput,
    additionalEnv
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
