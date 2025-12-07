import { accessSync, constants, realpathSync } from "node:fs";
import { resolve, relative as pathRelative, isAbsolute as pathIsAbsolute } from "node:path";
import type { Config } from "../config/index.js";
import { validateWorktreePath, isWithinAllowedWorktrees } from "./worktree.js";
import { debugLog } from "./debug.js";

/** ---------- Policy Types ---------- */
export type Policy = {
  rootDirectory: string;   // single root directory that contains all allowed operations
  allowedWorktrees: Set<string>;  // dynamically discovered worktrees (session-scoped)
  worktreeDetectionEnabled: boolean;  // toggle for worktree detection feature
  allow: RegExp[];     // full command line allow list, e.g. /^git(\s|$)/, /^gh(\s|$)/
  deny: RegExp[];      // explicit denies, e.g. /^git\s+push(\s+.*)?\s+(origin\s+)?(main|master)(\s+.*)?$/i
  timeoutMs: number;   // hard cap per command
  maxBytes: number;    // cap stdout/stderr per stream
  envWhitelist: string[]; // which env vars to forward
};

export type PolicyCheckResult = {
  allowed: boolean;
  reason: string;
  matchedRule?: string;
  ruleType?: 'allow' | 'deny';
};

/** ---------- Policy Utilities ---------- */
export const makeRegex = (s: string) => new RegExp(s, "i");

// Function to create policy from config
export function createPolicyFromConfig(config: Config): Policy {
  return {
    rootDirectory: config.directories.root,
    allowedWorktrees: new Set<string>(),
    worktreeDetectionEnabled: config.security.worktree_detection,
    allow: config.commands.allow.map(makeRegex),
    deny: config.commands.deny.map(makeRegex),
    timeoutMs: config.limits.timeout_seconds * 1000,
    maxBytes: config.limits.max_output_bytes,
    envWhitelist: config.environment.whitelist
  };
}

/**
 * Check if a command is allowed by policy and return detailed diagnostics
 * @param full The full command line to check
 * @param policy The policy to check against
 * @returns Detailed result with reason for allow/deny decision
 */
export function checkCommandPolicy(full: string, policy: Policy): PolicyCheckResult {
  // Check deny rules first (they have priority)
  for (const denyRule of policy.deny) {
    if (denyRule.test(full)) {
      return {
        allowed: false,
        reason: `Command matches deny rule`,
        matchedRule: denyRule.source,
        ruleType: 'deny'
      };
    }
  }

  // Check allow rules
  for (const allowRule of policy.allow) {
    if (allowRule.test(full)) {
      return {
        allowed: true,
        reason: `Command matches allow rule`,
        matchedRule: allowRule.source,
        ruleType: 'allow'
      };
    }
  }

  // No rules matched - command is denied by default
  return {
    allowed: false,
    reason: `Command does not match any allow rule`
  };
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use checkCommandPolicy for better diagnostics
 */
export function allowedCommand(full: string, policy: Policy): boolean {
  return checkCommandPolicy(full, policy).allowed;
}

export function filteredEnv(policy: Policy): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of policy.envWhitelist) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

export function ensureCwd(cwd: string, policy: Policy) {
  const normalizedCwd = resolve(cwd);
  const normalizedRoot = resolve(policy.rootDirectory);

  // 1) Check simple prefix boundary using resolved paths (works for non-existent paths)
  const inPrimaryBoundary = normalizedRoot === normalizedCwd ||
    normalizedCwd.startsWith(normalizedRoot + (normalizedRoot.endsWith("/") ? "" : "/"));

  if (inPrimaryBoundary) {
    // Within primary sandbox - use existing validation
    validatePathAccessibility(cwd, normalizedRoot);
    return;
  }

  // 2) Check if already in allowed worktrees
  if (isWithinAllowedWorktrees(normalizedCwd, policy.allowedWorktrees)) {
    debugLog("Path is within allowed worktree", { cwd });
    validatePathAccessibility(cwd, normalizedRoot);
    return;
  }

  // 3) Try worktree detection (if enabled)
  if (policy.worktreeDetectionEnabled) {
    const worktreeRoot = validateWorktreePath(normalizedCwd, normalizedRoot);
    if (worktreeRoot) {
      // Add to allowed worktrees for future requests
      policy.allowedWorktrees.add(worktreeRoot);
      debugLog("Added worktree to allowlist", { worktreeRoot, cwd });
      validatePathAccessibility(cwd, worktreeRoot);
      return;
    }
  }

  // Path is not in primary sandbox and not a valid worktree
  throw new Error(`cwd not allowed: ${cwd} (must be within ${policy.rootDirectory})`);
}

/**
 * Validate that a path exists, is accessible, and doesn't escape via symlinks
 */
function validatePathAccessibility(cwd: string, boundaryRoot: string) {
  // Ensure path exists and is accessible
  try {
    accessSync(cwd, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(`cwd not accessible: ${cwd}`);
  }

  // Mitigate symlink escapes: re-check boundary using real paths
  try {
    const realCwd = realpathSync(cwd);
    const realRoot = realpathSync(boundaryRoot);
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

/**
 * Compute effective per-call limits from request input and global policy
 */
export function getEffectiveLimits(input: any, policy: Policy): { effectiveTimeoutMs: number; effectiveMaxBytes: number } {
  // Back-compat: allow legacy timeout_ms, but prefer timeout_seconds if present
  const providedTimeoutMs = typeof input?.timeout_ms === 'number' ? input.timeout_ms : undefined;
  const providedTimeoutSeconds = typeof input?.timeout_seconds === 'number' ? input.timeout_seconds : undefined;
  let effectiveTimeoutMs = policy.timeoutMs;
  if (typeof providedTimeoutSeconds === 'number') {
    // clamp to [1s, 300s] and also not exceed policy limit
    const seconds = Math.max(1, Math.min(300, Math.floor(providedTimeoutSeconds)));
    effectiveTimeoutMs = Math.min(seconds * 1000, policy.timeoutMs);
  } else if (typeof providedTimeoutMs === 'number') {
    // clamp to [1ms, policy.timeoutMs]
    const ms = Math.max(1, Math.min(providedTimeoutMs, 300000));
    effectiveTimeoutMs = Math.min(ms, policy.timeoutMs);
  }

  // max_output_bytes override with clamp [1000, 10_000_000] but not exceed policy cap
  const providedMaxBytes = typeof input?.max_output_bytes === 'number' ? input.max_output_bytes : undefined;
  let effectiveMaxBytes = policy.maxBytes;
  if (typeof providedMaxBytes === 'number') {
    const clamped = Math.max(1000, Math.min(10_000_000, Math.floor(providedMaxBytes)));
    effectiveMaxBytes = Math.min(clamped, policy.maxBytes);
  }

  return { effectiveTimeoutMs, effectiveMaxBytes };
}
