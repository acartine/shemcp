import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Find the nearest Git repository root starting from a directory
 * @param startDir The directory to start searching from
 * @returns The Git root path, or null if not found
 */
export function findGitRoot(startDir: string): string | null {
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

/**
 * Derive a stable sandbox root:
 * 1) SHEMCP_ROOT or MCP_SANDBOX_ROOT env var if set
 * 2) nearest Git repo root from process.cwd()
 * 3) process.cwd() as a fallback
 */
export function deriveSandboxRoot(): string {
  const envRoot = process.env.SHEMCP_ROOT || process.env.MCP_SANDBOX_ROOT;
  if (envRoot && existsSync(envRoot)) return resolve(envRoot);
  const gitRoot = findGitRoot(process.cwd());
  if (gitRoot) return resolve(gitRoot);
  return resolve(process.cwd());
}
