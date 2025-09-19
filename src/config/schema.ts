import { z } from "zod";
import * as os from "node:os";

export const ConfigSchema = z.object({
  server: z.object({
    name: z.string().default("shemcp"),
    version: z.string().default("0.2.0"),
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
  }).default({}),
}).default({});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = {
  server: {
    name: "shemcp",
    version: "0.2.0",
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
  },
};