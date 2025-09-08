import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  policy,
  config,
  makeRegex,
  ensureCwd,
  buildCmdLine,
  allowedCommand,
  filteredEnv,
  tools,
  server,
  createPolicyFromConfig,
  setConfigForTesting
} from './index.js';
import { DEFAULT_CONFIG } from './config/schema.js';
import type { Policy } from './index.js';

describe('MCP Shell Server', () => {
  let testPolicy: Policy;
  
  beforeEach(() => {
    // Create isolated test policy from defaults
    testPolicy = createPolicyFromConfig(DEFAULT_CONFIG);
  });
  
  describe('Policy Tests', () => {
    it('should create correct policy from default config', () => {
      expect(testPolicy.allowedCwds.some(dir => dir.includes("projects"))).toBe(true);
      expect(testPolicy.defaultCwd).toBeTruthy();
      expect(testPolicy.timeoutMs).toBe(60_000);
      expect(testPolicy.maxBytes).toBe(2_000_000);
    });

    it('should load configuration from config system', () => {
      expect(config).toBeDefined();
      expect(config.server.name).toBe('mcp-shell-safe');
      expect(config.server.version).toBe('0.1.0');
      expect(config.directories.allowed.length).toBeGreaterThan(0);
      expect(config.commands.allow.length).toBeGreaterThan(0);
    });

    it('should create case-insensitive regex patterns', () => {
      const regex = makeRegex("test");
      expect(regex.test("TEST")).toBe(true);
      expect(regex.test("test")).toBe(true);
      expect(regex.test("TeSt")).toBe(true);
    });
  });

  describe('Command Validation', () => {
    it('should build command lines correctly', () => {
      expect(buildCmdLine("git", ["status"])).toBe("git status");
      expect(buildCmdLine("echo", ["hello", "world"])).toBe("echo hello world");
      expect(buildCmdLine("ls", [])).toBe("ls");
    });

    it('should allow whitelisted commands', () => {
      expect(allowedCommand("git status", testPolicy)).toBe(true);
      expect(allowedCommand("gh pr list", testPolicy)).toBe(true);
      expect(allowedCommand("make build", testPolicy)).toBe(true);
      expect(allowedCommand("grep test", testPolicy)).toBe(true);
      expect(allowedCommand("bash -lc 'echo hello'", testPolicy)).toBe(true);
    });

    it('should deny non-whitelisted commands', () => {
      expect(allowedCommand("rm -rf /", testPolicy)).toBe(false);
      expect(allowedCommand("curl http://example.com", testPolicy)).toBe(false);
      expect(allowedCommand("python script.py", testPolicy)).toBe(false);
    });

    it('should deny explicitly blocked git push commands', () => {
      expect(allowedCommand("git push origin main", testPolicy)).toBe(false);
      expect(allowedCommand("git push origin master", testPolicy)).toBe(false);
      expect(allowedCommand("git push", testPolicy)).toBe(false);
    });

    it('should allow safe git commands', () => {
      expect(allowedCommand("git pull", testPolicy)).toBe(true);
      expect(allowedCommand("git commit", testPolicy)).toBe(true);
      expect(allowedCommand("git push origin feature-branch", testPolicy)).toBe(true);
    });
  });

  describe('Working Directory Validation', () => {
    it('should reject unauthorized working directories', () => {
      expect(() => ensureCwd("/etc", testPolicy)).toThrow("cwd not allowed");
      expect(() => ensureCwd("/usr/bin", testPolicy)).toThrow("cwd not allowed");
      expect(() => ensureCwd("/", testPolicy)).toThrow("cwd not allowed");
    });

    it('should accept authorized working directories', () => {
      // Get the first allowed directory from test policy
      const allowedDir = testPolicy.allowedCwds[0];
      if (allowedDir) {
        // Test with a non-existent but allowed subdirectory
        expect(() => ensureCwd(allowedDir + "/non-existent-test-dir-12345", testPolicy)).toThrow("cwd not accessible");
        
        // Test the base directory (may exist or not)
        try {
          ensureCwd(allowedDir, testPolicy);
          // Directory exists and is accessible - that's OK
        } catch (e: any) {
          // Should only be accessibility error, not allowlist error
          expect(e.message).toContain("cwd not accessible");
        }
      }
    });
  });

  describe('Environment Filtering', () => {
    it('should only include whitelisted environment variables', () => {
      const originalEnv = process.env;
      
      // Mock environment
      process.env = {
        PATH: "/usr/bin:/bin",
        HOME: "/home/user",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        SECRET_KEY: "should-not-appear",
        API_TOKEN: "should-not-appear",
        RANDOM_VAR: "should-not-appear"
      };

      const filtered = filteredEnv(testPolicy);
      
      expect(filtered.PATH).toBe("/usr/bin:/bin");
      expect(filtered.HOME).toBe("/home/user");
      expect(filtered.LANG).toBe("en_US.UTF-8");
      expect(filtered.LC_ALL).toBe("en_US.UTF-8");
      expect(filtered.SECRET_KEY).toBeUndefined();
      expect(filtered.API_TOKEN).toBeUndefined();
      expect(filtered.RANDOM_VAR).toBeUndefined();

      // Restore original env
      process.env = originalEnv;
    });
  });

  describe('Tool Definitions', () => {
    it('should define all expected tools', () => {
      expect(tools).toHaveLength(3);
      
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain("shell_exec");
      expect(toolNames).toContain("shell_set_cwd");
      expect(toolNames).toContain("shell_set_policy");
    });

    it('should have proper tool schemas', () => {
      const execTool = tools.find(t => t.name === "shell_exec");
      expect(execTool).toBeDefined();
      expect(execTool?.inputSchema.type).toBe("object");
      expect(execTool?.inputSchema.properties.cmd).toBeDefined();
      expect(execTool?.inputSchema.required).toContain("cmd");

      const cwdTool = tools.find(t => t.name === "shell_set_cwd");
      expect(cwdTool).toBeDefined();
      expect(cwdTool?.inputSchema.properties.cwd).toBeDefined();
      expect(cwdTool?.inputSchema.required).toContain("cwd");

      const policyTool = tools.find(t => t.name === "shell_set_policy");
      expect(policyTool).toBeDefined();
      expect(policyTool?.inputSchema.properties.allowed_cwds).toBeDefined();
      expect(policyTool?.inputSchema.properties.timeout_ms).toBeDefined();
    });
  });

  describe('Server Configuration', () => {
    it('should create server with correct capabilities', () => {
      const capabilities = server['_capabilities'];
      expect(capabilities).toBeDefined();
      expect(capabilities.tools).toBeDefined();
    });

    it('should have correct server info from config', () => {
      const serverInfo = server['_serverInfo'];
      expect(serverInfo.name).toBe(config.server.name);
      expect(serverInfo.version).toBe(config.server.version);
    });

    it('should convert config to policy correctly', () => {
      const testConfig = DEFAULT_CONFIG;
      const convertedPolicy = createPolicyFromConfig(testConfig);
      expect(convertedPolicy.allowedCwds).toEqual(testConfig.directories.allowed);
      expect(convertedPolicy.defaultCwd).toBe(testConfig.directories.default || null);
      expect(convertedPolicy.timeoutMs).toBe(testConfig.limits.timeout_seconds * 1000);
      expect(convertedPolicy.maxBytes).toBe(testConfig.limits.max_output_bytes);
      expect(convertedPolicy.envWhitelist).toEqual(testConfig.environment.whitelist);
    });
  });
});