/** ---------- Command Line Utilities ---------- */

/**
 * Strip environment variable prefixes from command and args
 * e.g., ["FOO=bar", "npm", "run", "test"] -> { envVars: ["FOO=bar"], cmd: "npm", args: ["run", "test"] }
 * e.g., ["npm", "run", "test"] -> { envVars: [], cmd: "npm", args: ["run", "test"] }
 */
export function stripEnvPrefix(cmd: string, args: string[]): {
  envVars: string[];
  cmd: string;
  args: string[];
} {
  const envVars: string[] = [];
  let actualCmd = cmd;
  let actualArgs = args;

  // Check if cmd is an env var (contains = and doesn't start with -)
  if (cmd.includes('=') && !cmd.startsWith('-')) {
    // Cmd is an env var, so we need to find the actual command in args
    envVars.push(cmd);

    // Find where the actual command starts (first arg that doesn't contain =)
    let cmdIndex = 0;
    while (cmdIndex < args.length) {
      const arg = args[cmdIndex];
      if (!arg || !arg.includes('=') || arg.startsWith('-')) {
        break;
      }
      envVars.push(arg);
      cmdIndex++;
    }

    if (cmdIndex >= args.length) {
      // All args were env vars, no actual command
      throw new Error("No command found after environment variable assignments");
    }

    const foundCmd = args[cmdIndex];
    if (!foundCmd) {
      throw new Error("No command found after environment variable assignments");
    }

    actualCmd = foundCmd;
    actualArgs = args.slice(cmdIndex + 1);
  }

  return { envVars, cmd: actualCmd, args: actualArgs };
}

export function buildCmdLine(cmd: string, args: string[]): string {
  const joined = [cmd, ...args].join(" ").trim();
  return joined;
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

/**
 * Parse a shell wrapper command (bash or sh) and extract the underlying command for allowlist checking
 * Handles: bash -lc "cmd args", bash -c "cmd args", bash -l -c "cmd args"
 *          sh -lc "cmd args", sh -c "cmd args", sh -l -c "cmd args"
 * Returns: { isWrapper: boolean, executableToCheck: string, shouldUseLogin: boolean, commandString?: string, argsAfterCommand?: number, flagsBeforeCommand?: string[], shell?: 'bash' | 'sh' }
 */
export function parseShellWrapper(cmd: string, args: string[]): {
  isWrapper: boolean;
  executableToCheck: string;
  shouldUseLogin: boolean;
  commandString?: string;
  argsAfterCommand?: number;
  flagsBeforeCommand?: string[];
  shell?: 'bash' | 'sh';
} {
  // Not a wrapper if cmd is not bash/sh or no dash flags
  if ((cmd !== "bash" && cmd !== "sh") || args.length === 0) {
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
    flagsBeforeCommand,  // User-supplied flags like --noprofile, --norc, etc.
    shell: cmd as 'bash' | 'sh'  // Track which shell is being used
  };
}

/**
 * Legacy alias for parseShellWrapper - maintained for backward compatibility
 * @deprecated Use parseShellWrapper instead
 */
export const parseBashWrapper = parseShellWrapper;
