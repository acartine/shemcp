import { z } from "zod";
import * as os from "node:os";

export const ConfigSchema = z.object({
  // Optional configuration format version (not the package version).
  // Reserved for future migrations/compat and currently informational.
  config_version: z.number().int().min(1).default(1),

  server: z.object({
    name: z.string().default("shemcp"),
    // version is sourced from package.json at runtime; keep optional to avoid confusion
    version: z.string().optional(),
  }).default({}),

  directories: z.object({
    root: z.string(),
  }).default({ root: os.homedir() }),

  commands: z.object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }).default({}),

  limits: z.object({
    timeout_seconds: z.number().int().min(1).max(300).default(60),
    max_output_bytes: z.number().int().min(1000).max(10_000_000).default(2_000_000),
  }).default({}),

  environment: z.object({
    whitelist: z.array(z.string()).default([]),
  }).default({}),

  security: z.object({
    allow_runtime_policy_changes: z.boolean().default(true),
    require_secure_permissions: z.boolean().default(false),
    worktree_detection: z.boolean().default(true),
  }).default({}),
}).default({});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = {
  config_version: 1,
  server: {
    name: "shemcp",
  },
  directories: {
    root: os.homedir(),
  },
  commands: {
    allow: [
      "^git(\\s|$)",
      "^gh(\\s|$)",
      "^make(\\s|$)",
      "^grep(\\s|$)",
      "^sed(\\s|$)",
      "^jq(\\s|$)",
      "^aws(\\s|$)",
      "^az(\\s|$)",
      "^bash\\s+-lc\\s+",
      "^sh\\s+-lc\\s+",
    ],
    deny: [
      "^git\\s+push(\\s+.*)?\\s+(origin\\s+)?(main|master)(\\s+.*)?$",
      "^git\\s+push\\s*$",
    ],
  },
  limits: {
    timeout_seconds: 60,
    max_output_bytes: 2_000_000,
  },
  environment: {
    whitelist: ["PATH", "HOME", "LANG", "LC_ALL"],
  },
  security: {
    allow_runtime_policy_changes: true,
    require_secure_permissions: false,
    worktree_detection: true,
  },
};