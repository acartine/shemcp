import { resolve } from "node:path";
import type { Policy } from "../lib/policy.js";

export function handleShellInfo(policy: Policy, serverVersion: string) {
  const root = resolve(policy.rootDirectory);
  const info = {
    sandbox_root: root,
    server_version: serverVersion,
    command_policy: {
      allow: policy.allow.map(r => r.source),
      deny: policy.deny.map(r => r.source)
    }
  };
  return {
    content: [{ type: "text", text: JSON.stringify(info, null, 2) }]
  };
}
