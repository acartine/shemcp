import { execSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { debugLog } from "./debug.js";

/** Worktree information from git worktree list */
export interface WorktreeInfo {
  path: string;
  head: string;
  branch?: string;
}

/** Cache for worktree list with TTL */
export interface WorktreeCache {
  worktrees: WorktreeInfo[];
  timestamp: number;
  sandboxRoot: string;
}

const CACHE_TTL_MS = 60_000; // 60 seconds

let globalWorktreeCache: WorktreeCache | null = null;

/**
 * Parse git worktree list --porcelain output
 *
 * Example output:
 * worktree /Users/user/repo
 * HEAD abc123
 * branch refs/heads/main
 *
 * worktree /Users/user/repo-feature
 * HEAD def456
 * branch refs/heads/feature
 */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const lines = output.split("\n");

  let current: Partial<WorktreeInfo> = {};

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      if (current.path && current.head) {
        worktrees.push(current as WorktreeInfo);
      }
      current = { path: line.slice(9).trim() };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).trim();
    }
  }

  // Don't forget the last entry
  if (current.path && current.head) {
    worktrees.push(current as WorktreeInfo);
  }

  return worktrees;
}

/**
 * Fetch worktree list from git
 */
export function fetchWorktreeList(sandboxRoot: string): WorktreeInfo[] {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: sandboxRoot,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseWorktreeList(output);
  } catch (error) {
    debugLog("Failed to fetch worktree list", { error });
    return [];
  }
}

/**
 * Get cached worktrees or fetch fresh
 */
export function getWorktrees(sandboxRoot: string): WorktreeInfo[] {
  const now = Date.now();

  // Check cache validity
  if (
    globalWorktreeCache &&
    globalWorktreeCache.sandboxRoot === sandboxRoot &&
    now - globalWorktreeCache.timestamp < CACHE_TTL_MS
  ) {
    debugLog("Using cached worktree list", { count: globalWorktreeCache.worktrees.length });
    return globalWorktreeCache.worktrees;
  }

  // Fetch fresh
  debugLog("Fetching fresh worktree list", { sandboxRoot });
  const worktrees = fetchWorktreeList(sandboxRoot);

  globalWorktreeCache = {
    worktrees,
    timestamp: now,
    sandboxRoot,
  };

  debugLog("Worktree list fetched", { count: worktrees.length, paths: worktrees.map(w => w.path) });
  return worktrees;
}

/**
 * Clear the worktree cache (useful for testing)
 */
export function clearWorktreeCache(): void {
  globalWorktreeCache = null;
}

/**
 * Check if a path could be a worktree based on basename prefix matching
 *
 * For sandbox /Users/user/repo, valid worktree paths would be:
 * - /Users/user/repo-feature (starts with "repo")
 * - /Users/user/repo_bugfix (starts with "repo")
 *
 * Invalid:
 * - /Users/user/other-project (doesn't start with "repo")
 */
export function matchesWorktreePattern(
  requestedPath: string,
  sandboxRoot: string
): boolean {
  const sandboxParent = resolve(sandboxRoot, "..");
  const requestedParent = resolve(requestedPath, "..");

  // Worktrees must be in the same parent directory
  if (sandboxParent !== requestedParent) {
    return false;
  }

  const sandboxBasename = basename(sandboxRoot);
  const requestedBasename = basename(requestedPath);

  // Requested path basename must start with sandbox basename
  return requestedBasename.startsWith(sandboxBasename);
}

/**
 * Validate if a requested path is a legitimate worktree
 * Returns the worktree root path if valid, null otherwise
 */
export function validateWorktreePath(
  requestedPath: string,
  sandboxRoot: string
): string | null {
  const normalizedPath = resolve(requestedPath);
  const normalizedRoot = resolve(sandboxRoot);

  // Quick check: must match worktree naming pattern
  // Find the potential worktree root (might be requestedPath itself or an ancestor)
  let checkPath = normalizedPath;
  let foundWorktreeRoot: string | null = null;

  // Walk up to find a directory that matches the pattern
  while (checkPath !== normalizedRoot) {
    if (matchesWorktreePattern(checkPath, normalizedRoot)) {
      foundWorktreeRoot = checkPath;
      break;
    }
    const parent = resolve(checkPath, "..");
    if (parent === checkPath) break; // Reached filesystem root
    checkPath = parent;
  }

  if (!foundWorktreeRoot) {
    debugLog("Path does not match worktree pattern", { requestedPath, sandboxRoot });
    return null;
  }

  // Verify via git worktree list
  const worktrees = getWorktrees(normalizedRoot);

  for (const wt of worktrees) {
    const wtPath = resolve(wt.path);
    // Check if requested path is the worktree root or a subdirectory
    if (
      normalizedPath === wtPath ||
      normalizedPath.startsWith(wtPath + "/")
    ) {
      debugLog("Validated worktree path", { requestedPath, worktreeRoot: wtPath });
      return wtPath;
    }
  }

  debugLog("Path not found in worktree list", { requestedPath, foundWorktreeRoot });
  return null;
}

/**
 * Check if a path is within any of the allowed worktrees
 */
export function isWithinAllowedWorktrees(
  path: string,
  allowedWorktrees: Set<string>
): boolean {
  const normalizedPath = resolve(path);

  for (const wt of allowedWorktrees) {
    const wtPath = resolve(wt);
    if (normalizedPath === wtPath || normalizedPath.startsWith(wtPath + "/")) {
      return true;
    }
  }

  return false;
}
