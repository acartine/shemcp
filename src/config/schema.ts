import { z } from "zod";

export const ConfigSchema = z.object({
  server: z.object({
    name: z.string().default("mcp-shell-safe"),
    version: z.string().default("0.1.0"),
  }).default({}),

  directories: z.object({
    allowed: z.array(z.string()).default([]),
    default: z.string().optional(),
  }).default({}),

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
  }).default({}),
}).default({});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = {
  server: {
    name: "mcp-shell-safe",
    version: "0.1.0",
  },
  directories: {
    allowed: [
      "~/projects",
      "~/chat",
    ],
    default: "~/chat",
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
    ],
    deny: [
      "^git\\s+push(\\s+.*)\\s+(origin\\s+)?(main|master)(\\s+.*)?$",
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
  },
};