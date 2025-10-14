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
  setConfigForTesting,
  getEffectiveLimits,
  parseBashWrapper,
  parseShellCommand
} from './index.js';
import { DEFAULT_CONFIG } from './config/schema.js';
import type { Policy } from './index.js';

describe('MCP Shell Server', () => {
  let testPolicy: Policy;
  
  beforeEach(() => {
    // Create isolated test policy with a proper root directory
    const testConfig = {
      ...DEFAULT_CONFIG,
      directories: { root: '/home/testuser' }
    };
    testPolicy = createPolicyFromConfig(testConfig);
  });
  
  describe('Policy Tests', () => {
    it('should create correct policy from default config', () => {
      // In test environment, homedir is mocked to return '/home/testuser'
      expect(testPolicy.rootDirectory).toBe('/home/testuser');
      expect(testPolicy.timeoutMs).toBe(60_000);
      expect(testPolicy.maxBytes).toBe(2_000_000);
    });

    it('should load configuration from config system', () => {
      expect(config).toBeDefined();
      expect(config.server.name).toBe('shemcp');
      // The actual config should have a real root directory path
      expect(config.directories.root).toBeDefined();
      expect(typeof config.directories.root).toBe('string');
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
    it('should reject directories outside root directory', () => {
      expect(() => ensureCwd("/etc", testPolicy)).toThrow("cwd not allowed");
      expect(() => ensureCwd("/usr/bin", testPolicy)).toThrow("cwd not allowed");
      expect(() => ensureCwd("/", testPolicy)).toThrow("cwd not allowed");
    });

    it('should accept root directory and subdirectories', () => {
      const rootDir = testPolicy.rootDirectory;
      
      // Test root directory (may exist or not)
      try {
        ensureCwd(rootDir, testPolicy);
        // Directory exists and is accessible - that's OK
      } catch (e: any) {
        // Should only be accessibility error, not allowlist error
        expect(e.message).toContain("cwd not accessible");
      }
      
      // Test with a non-existent but allowed subdirectory
      expect(() => ensureCwd(rootDir + "/non-existent-test-dir-12345", testPolicy)).toThrow("cwd not accessible");
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
      expect(tools.length).toBe(3);
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain("shell_exec");
      expect(toolNames).toContain("shell_info");
      expect(toolNames).toContain("read_file_chunk");
    });

    it('should have proper tool schemas', () => {
      const execTool = tools.find(t => t.name === "shell_exec");
      expect(execTool).toBeDefined();
      expect(execTool?.inputSchema.type).toBe("object");
      expect(execTool?.inputSchema.properties?.cmd).toBeDefined();
      expect(execTool?.inputSchema.required).toContain("cmd");

      const infoTool = tools.find(t => t.name === "shell_info");
      expect(infoTool).toBeDefined();
      expect(infoTool?.inputSchema.type).toBe("object");

      // New per-request override properties should exist
      expect(execTool?.inputSchema.properties?.timeout_seconds).toBeDefined();
      expect(execTool?.inputSchema.properties?.max_output_bytes).toBeDefined();
    });

    it('should reject absolute cwd in shell_exec description', () => {
      const execTool = tools.find(t => t.name === "shell_exec");
      expect(execTool?.description?.toLowerCase()).toContain("relative");
    });

    it('should have read_file_chunk tool with proper schema', () => {
      const chunkTool = tools.find(t => t.name === "read_file_chunk");
      expect(chunkTool).toBeDefined();
      expect(chunkTool?.inputSchema.type).toBe("object");
      expect(chunkTool?.inputSchema.properties?.uri).toBeDefined();
      expect(chunkTool?.inputSchema.properties?.cursor).toBeDefined();
      expect(chunkTool?.inputSchema.properties?.limit_bytes).toBeDefined();
      expect(chunkTool?.inputSchema.required).toContain("uri");
    });
  });

  describe('Per-request limit overrides', () => {
    it('should prefer timeout_seconds over legacy timeout_ms and clamp to policy', () => {
      const policy = createPolicyFromConfig({
        ...DEFAULT_CONFIG,
        limits: { timeout_seconds: 60, max_output_bytes: 2_000_000 },
        directories: { root: '/home/testuser' }
      });
      // If timeout_seconds provided lower than policy
      let res = getEffectiveLimits({ timeout_seconds: 10 }, policy);
      expect(res.effectiveTimeoutMs).toBe(10_000);

      // If timeout_seconds provided higher than policy, cap at policy
      res = getEffectiveLimits({ timeout_seconds: 120 }, policy);
      expect(res.effectiveTimeoutMs).toBe(60_000);

      // Legacy timeout_ms respected when seconds not provided, and capped
      res = getEffectiveLimits({ timeout_ms: 5_000 }, policy);
      expect(res.effectiveTimeoutMs).toBe(5_000);
      res = getEffectiveLimits({ timeout_ms: 120_000 }, policy);
      expect(res.effectiveTimeoutMs).toBe(60_000);
    });

    it('should cap max_output_bytes to policy max when provided', () => {
      const policy = createPolicyFromConfig({
        ...DEFAULT_CONFIG,
        limits: { timeout_seconds: 60, max_output_bytes: 1_000_000 },
        directories: { root: '/home/testuser' }
      });
      // Lower than policy
      let res = getEffectiveLimits({ max_output_bytes: 500_000 }, policy);
      expect(res.effectiveMaxBytes).toBe(500_000);

      // Higher than policy should clamp to policy
      res = getEffectiveLimits({ max_output_bytes: 5_000_000 }, policy);
      expect(res.effectiveMaxBytes).toBe(1_000_000);

      // Missing should equal policy
      res = getEffectiveLimits({}, policy);
      expect(res.effectiveMaxBytes).toBe(1_000_000);
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
      // Version should come from package.json, not config
      expect(serverInfo.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should convert config to policy correctly', () => {
      const testConfig = DEFAULT_CONFIG;
      const convertedPolicy = createPolicyFromConfig(testConfig);
      expect(convertedPolicy.rootDirectory).toBe(testConfig.directories.root);
      expect(convertedPolicy.timeoutMs).toBe(testConfig.limits.timeout_seconds * 1000);
      expect(convertedPolicy.maxBytes).toBe(testConfig.limits.max_output_bytes);
      expect(convertedPolicy.envWhitelist).toEqual(testConfig.environment.whitelist);
    });
  });

  describe('Bash Wrapper Handling', () => {
    describe('parseShellCommand', () => {
      it('should parse simple commands', () => {
        expect(parseShellCommand("git status")).toEqual(["git", "status"]);
        expect(parseShellCommand("aws s3 ls")).toEqual(["aws", "s3", "ls"]);
      });

      it('should handle single quotes', () => {
        expect(parseShellCommand("echo 'hello world'")).toEqual(["echo", "hello world"]);
        expect(parseShellCommand("git commit -m 'my message'")).toEqual(["git", "commit", "-m", "my message"]);
      });

      it('should handle double quotes', () => {
        expect(parseShellCommand('echo "hello world"')).toEqual(["echo", "hello world"]);
        expect(parseShellCommand('git commit -m "my message"')).toEqual(["git", "commit", "-m", "my message"]);
      });

      it('should handle escaped characters', () => {
        expect(parseShellCommand("echo hello\\ world")).toEqual(["echo", "hello world"]);
      });

      it('should handle empty strings', () => {
        expect(parseShellCommand("")).toEqual([]);
        expect(parseShellCommand("   ")).toEqual([]);
      });
    });

    describe('parseBashWrapper', () => {
      it('should detect non-wrapper commands', () => {
        const result = parseBashWrapper("git", ["status"]);
        expect(result.isWrapper).toBe(false);
        expect(result.executableToCheck).toBe("git");
        expect(result.shouldUseLogin).toBe(false);
      });

      it('should parse bash -lc wrapper', () => {
        const result = parseBashWrapper("bash", ["-lc", "aws s3 ls"]);
        expect(result.isWrapper).toBe(true);
        expect(result.executableToCheck).toBe("aws");
        expect(result.shouldUseLogin).toBe(true);
        expect(result.commandString).toBe("aws s3 ls");
      });

      it('should parse bash -c wrapper (non-login)', () => {
        const result = parseBashWrapper("bash", ["-c", "git status"]);
        expect(result.isWrapper).toBe(true);
        expect(result.executableToCheck).toBe("git");
        expect(result.shouldUseLogin).toBe(false);
        expect(result.commandString).toBe("git status");
      });

      it('should parse bash -l -c wrapper (separate flags)', () => {
        const result = parseBashWrapper("bash", ["-l", "-c", "kubectl get pods"]);
        expect(result.isWrapper).toBe(true);
        expect(result.executableToCheck).toBe("kubectl");
        expect(result.shouldUseLogin).toBe(true);
        expect(result.commandString).toBe("kubectl get pods");
      });

      it('should reject bash -l without -c', () => {
        expect(() => parseBashWrapper("bash", ["-l"])).toThrow("missing -c command string");
      });

      it('should reject bash -c without command string', () => {
        expect(() => parseBashWrapper("bash", ["-c"])).toThrow("missing command string after -c");
      });

      it('should reject empty or whitespace-only command string', () => {
        // Empty strings and whitespace-only strings should be rejected
        // The error thrown depends on how bash processes them:
        // - Empty string ("") gets caught by the tokenizer returning empty array
        // - Whitespace-only ("   ") also gets caught by tokenizer
        expect(() => parseBashWrapper("bash", ["-lc", ""])).toThrow("empty command string");
        expect(() => parseBashWrapper("bash", ["-lc", "   "])).toThrow("empty command string");
      });

      it('should extract first executable from complex commands', () => {
        const result = parseBashWrapper("bash", ["-lc", "aws s3 sync . s3://bucket"]);
        expect(result.executableToCheck).toBe("aws");
      });

      it('should handle commands with quotes', () => {
        const result = parseBashWrapper("bash", ["-c", 'git commit -m "my message"']);
        expect(result.executableToCheck).toBe("git");
      });
    });

    describe('Full command policy checking', () => {
      it('should check full command including args for deny rules', () => {
        // This test ensures that deny rules like "git push origin main" work
        // even when wrapped in bash -lc
        const wrapperResult = parseBashWrapper("bash", ["-lc", "git push origin main"]);
        expect(wrapperResult.isWrapper).toBe(true);

        // The full command should include all args for policy checking
        const tokens = parseShellCommand(wrapperResult.commandString!);
        const fullCmd = tokens.join(" ");

        // Should include all parts of the command
        expect(fullCmd).toBe("git push origin main");

        // This should be denied by policy
        expect(allowedCommand(fullCmd, testPolicy)).toBe(false);
      });

      it('should allow non-main branch pushes even in wrappers', () => {
        const wrapperResult = parseBashWrapper("bash", ["-c", "git push origin feature-branch"]);
        const tokens = parseShellCommand(wrapperResult.commandString!);
        const fullCmd = tokens.join(" ");

        // Should be allowed (not pushing to main/master)
        expect(allowedCommand(fullCmd, testPolicy)).toBe(true);
      });
    });

    describe('Positional parameters handling', () => {
      it('should track the index after command string for trailing args', () => {
        const result = parseBashWrapper("bash", ["-c", "echo $1", "--", "foo", "bar"]);
        expect(result.isWrapper).toBe(true);
        expect(result.commandString).toBe("echo $1");
        expect(result.argsAfterCommand).toBe(2);  // Index of "--" in the args array
      });

      it('should handle -lc with trailing args', () => {
        const result = parseBashWrapper("bash", ["-lc", "echo $1", "--", "foo"]);
        expect(result.isWrapper).toBe(true);
        expect(result.shouldUseLogin).toBe(true);
        expect(result.argsAfterCommand).toBe(2);  // Index of "--"
      });

      it('should handle commands without trailing args', () => {
        const result = parseBashWrapper("bash", ["-c", "echo hello"]);
        expect(result.isWrapper).toBe(true);
        expect(result.argsAfterCommand).toBe(2);  // Would be past the end of array
      });
    });

    describe('Long flag handling', () => {
      it('should not treat long flags with "l" as login shell', () => {
        // --noprofile contains 'l' but should NOT trigger login mode
        const result = parseBashWrapper("bash", ["--noprofile", "-c", "echo hi"]);
        expect(result.isWrapper).toBe(true);
        expect(result.shouldUseLogin).toBe(false);  // Should NOT be login
      });

      it('should not treat long flags with "c" as command flag', () => {
        // This should fail because there's no actual -c flag
        expect(() => parseBashWrapper("bash", ["--norc", "echo hi"])).toThrow("missing -c command string");
      });

      it('should only detect short -l flag', () => {
        const result = parseBashWrapper("bash", ["-l", "-c", "echo hi"]);
        expect(result.shouldUseLogin).toBe(true);
      });

      it('should detect -l in combined short flags', () => {
        const result = parseBashWrapper("bash", ["-lc", "echo hi"]);
        expect(result.shouldUseLogin).toBe(true);
      });
    });

    describe('Pre-command flags preservation', () => {
      it('should preserve --noprofile flag', () => {
        const result = parseBashWrapper("bash", ["--noprofile", "-c", "echo hi"]);
        expect(result.isWrapper).toBe(true);
        expect(result.flagsBeforeCommand).toEqual(["--noprofile"]);
      });

      it('should preserve multiple flags', () => {
        const result = parseBashWrapper("bash", ["--noprofile", "--norc", "-c", "echo hi"]);
        expect(result.flagsBeforeCommand).toEqual(["--noprofile", "--norc"]);
      });

      it('should preserve -o posix style flags', () => {
        const result = parseBashWrapper("bash", ["-o", "posix", "-c", "echo hi"]);
        expect(result.flagsBeforeCommand).toEqual(["-o", "posix"]);
      });

      it('should not include -l in flagsBeforeCommand', () => {
        const result = parseBashWrapper("bash", ["-l", "-c", "echo hi"]);
        expect(result.shouldUseLogin).toBe(true);
        expect(result.flagsBeforeCommand).toEqual([]);  // -l handled separately
      });

      it('should not include -lc combined flag in flagsBeforeCommand', () => {
        const result = parseBashWrapper("bash", ["-lc", "echo hi"]);
        expect(result.shouldUseLogin).toBe(true);
        expect(result.flagsBeforeCommand).toEqual([]);  // -lc handled specially
      });

      it('should preserve flags before combined -lc', () => {
        const result = parseBashWrapper("bash", ["--noprofile", "-lc", "echo hi"]);
        expect(result.flagsBeforeCommand).toEqual(["--noprofile"]);
        expect(result.shouldUseLogin).toBe(true);
      });
    });

    describe('Combined short flags with c', () => {
      it('should extract other flags from -ec bundle', () => {
        const result = parseBashWrapper("bash", ["-ec", "echo hi"]);
        expect(result.isWrapper).toBe(true);
        expect(result.flagsBeforeCommand).toEqual(["-e"]);  // -e preserved, -c handled
      });

      it('should extract other flags from -xlc bundle', () => {
        const result = parseBashWrapper("bash", ["-xlc", "echo hi"]);
        expect(result.isWrapper).toBe(true);
        expect(result.shouldUseLogin).toBe(true);  // -l detected
        expect(result.flagsBeforeCommand).toEqual(["-x"]);  // -x preserved, -l and -c handled
      });

      it('should handle -pc bundle', () => {
        const result = parseBashWrapper("bash", ["-pc", "echo hi"]);
        expect(result.flagsBeforeCommand).toEqual(["-p"]);  // -p preserved
      });

      it('should handle -xec bundle', () => {
        const result = parseBashWrapper("bash", ["-xec", "echo hi"]);
        expect(result.flagsBeforeCommand).toEqual(["-x", "-e"]);  // both -x and -e preserved as separate flags
      });

      it('should handle pure -lc with no other flags', () => {
        const result = parseBashWrapper("bash", ["-lc", "echo hi"]);
        expect(result.shouldUseLogin).toBe(true);
        expect(result.flagsBeforeCommand).toEqual([]);  // Nothing extra to preserve
      });

      it('should handle pure -c with no other flags', () => {
        const result = parseBashWrapper("bash", ["-c", "echo hi"]);
        expect(result.flagsBeforeCommand).toEqual([]);  // Nothing to preserve
      });
    });
  });
});