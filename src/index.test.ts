import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  policy,
  config,
  makeRegex,
  ensureCwd,
  buildCmdLine,
  allowedCommand,
  checkCommandPolicy,
  filteredEnv,
  tools,
  server,
  createPolicyFromConfig,
  setConfigForTesting,
  getEffectiveLimits,
  parseBashWrapper,
  parseShellCommand,
  stripEnvPrefix
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

    it('should have shell_info tool without cwd parameter', () => {
      const infoTool = tools.find(t => t.name === "shell_info");
      expect(infoTool).toBeDefined();
      expect(infoTool?.inputSchema.type).toBe("object");
      // Should not have cwd parameter anymore
      expect(infoTool?.inputSchema.properties?.cwd).toBeUndefined();
      // Description should mention policy and version
      expect(infoTool?.description).toContain("policy");
      expect(infoTool?.description).toContain("version");
      expect(infoTool?.description).toContain("sandbox root");
    });

    it('should return sandbox root, server version, and command policy from shell_info handler', async () => {
      // Call the actual request handler
      const handler = server['_requestHandlers'].get('tools/call');
      expect(handler).toBeDefined();

      const response = await handler!({
        method: 'tools/call',
        params: {
          name: 'shell_info',
          arguments: {}
        }
      });

      // Parse the response
      expect(response.content).toBeDefined();
      expect(response.content.length).toBe(1);
      expect(response.content[0].type).toBe('text');

      const responseData = JSON.parse(response.content[0].text);

      // Verify all expected fields are present
      expect(responseData).toHaveProperty('sandbox_root');
      expect(responseData).toHaveProperty('server_version');
      expect(responseData).toHaveProperty('command_policy');

      // Verify types and structure
      expect(typeof responseData.sandbox_root).toBe('string');
      expect(responseData.sandbox_root.length).toBeGreaterThan(0);

      expect(typeof responseData.server_version).toBe('string');
      expect(responseData.server_version).toMatch(/^\d+\.\d+\.\d+$/);

      expect(responseData.command_policy).toHaveProperty('allow');
      expect(responseData.command_policy).toHaveProperty('deny');
      expect(Array.isArray(responseData.command_policy.allow)).toBe(true);
      expect(Array.isArray(responseData.command_policy.deny)).toBe(true);
      expect(responseData.command_policy.allow.length).toBeGreaterThan(0);
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
      // New worktree fields should be initialized
      expect(convertedPolicy.allowedWorktrees).toBeInstanceOf(Set);
      expect(convertedPolicy.allowedWorktrees.size).toBe(0);
      expect(convertedPolicy.worktreeDetectionEnabled).toBe(true);
    });

    it('should respect worktree_detection config setting when false', () => {
      const configWithWorktreeDisabled = {
        ...DEFAULT_CONFIG,
        security: {
          ...DEFAULT_CONFIG.security,
          worktree_detection: false,
        },
      };
      const convertedPolicy = createPolicyFromConfig(configWithWorktreeDisabled);
      expect(convertedPolicy.worktreeDetectionEnabled).toBe(false);
    });

    it('should respect worktree_detection config setting when true', () => {
      const configWithWorktreeEnabled = {
        ...DEFAULT_CONFIG,
        security: {
          ...DEFAULT_CONFIG.security,
          worktree_detection: true,
        },
      };
      const convertedPolicy = createPolicyFromConfig(configWithWorktreeEnabled);
      expect(convertedPolicy.worktreeDetectionEnabled).toBe(true);
    });
  });

  describe('Shell Wrapper Handling (Bash and Sh)', () => {
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

    describe('stripEnvPrefix', () => {
      describe('basic functionality', () => {
        it('should handle commands without env var prefixes', () => {
          const result = stripEnvPrefix("npm", ["run", "test"]);
          expect(result.envVars).toEqual([]);
          expect(result.cmd).toBe("npm");
          expect(result.args).toEqual(["run", "test"]);
        });

        it('should strip single env var prefix', () => {
          const result = stripEnvPrefix("FOO=bar", ["npm", "run", "test"]);
          expect(result.envVars).toEqual(["FOO=bar"]);
          expect(result.cmd).toBe("npm");
          expect(result.args).toEqual(["run", "test"]);
        });

        it('should strip multiple env var prefixes', () => {
          const result = stripEnvPrefix("FOO=bar", ["BAR=baz", "QUX=qux", "npm", "run", "test"]);
          expect(result.envVars).toEqual(["FOO=bar", "BAR=baz", "QUX=qux"]);
          expect(result.cmd).toBe("npm");
          expect(result.args).toEqual(["run", "test"]);
        });

        it('should handle complex env var values', () => {
          const result = stripEnvPrefix("PATH=/usr/bin:/bin", ["NODE_ENV=production", "npm", "start"]);
          expect(result.envVars).toEqual(["PATH=/usr/bin:/bin", "NODE_ENV=production"]);
          expect(result.cmd).toBe("npm");
          expect(result.args).toEqual(["start"]);
        });

        it('should work with commands that have no args', () => {
          const result = stripEnvPrefix("FOO=bar", ["ls"]);
          expect(result.envVars).toEqual(["FOO=bar"]);
          expect(result.cmd).toBe("ls");
          expect(result.args).toEqual([]);
        });
      });

      describe('shell wrapper integration', () => {
        it('should handle env vars with bash command', () => {
          const result = stripEnvPrefix("FOO=bar", ["bash", "-c", "npm run test"]);
          expect(result.envVars).toEqual(["FOO=bar"]);
          expect(result.cmd).toBe("bash");
          expect(result.args).toEqual(["-c", "npm run test"]);
        });

        it('should handle env vars with sh command', () => {
          const result = stripEnvPrefix("FOO=bar", ["BAR=baz", "sh", "-c", "echo $FOO"]);
          expect(result.envVars).toEqual(["FOO=bar", "BAR=baz"]);
          expect(result.cmd).toBe("sh");
          expect(result.args).toEqual(["-c", "echo $FOO"]);
        });
      });

      describe('error cases', () => {
        it('should reject when only env vars are provided (no command)', () => {
          expect(() => stripEnvPrefix("FOO=bar", ["BAR=baz"])).toThrow("No command found after environment variable assignments");
        });

        it('should reject when cmd is only an env var (no args)', () => {
          expect(() => stripEnvPrefix("FOO=bar", [])).toThrow("No command found after environment variable assignments");
        });

        it('should not treat flags as env vars', () => {
          // Flags (starting with -) should not be treated as env vars
          const result = stripEnvPrefix("npm", ["--flag=value", "run", "test"]);
          expect(result.envVars).toEqual([]);
          expect(result.cmd).toBe("npm");
          expect(result.args).toEqual(["--flag=value", "run", "test"]);
        });
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

    describe('Environment variable prefix handling', () => {
      it('should validate command after stripping env vars for simple commands', () => {
        // Strip env vars first
        const stripped = stripEnvPrefix("FOO=bar", ["git", "status"]);
        expect(stripped.cmd).toBe("git");
        expect(stripped.args).toEqual(["status"]);

        // Validation should run on the actual command
        const fullCmd = buildCmdLine(stripped.cmd, stripped.args);
        expect(fullCmd).toBe("git status");
        expect(allowedCommand(fullCmd, testPolicy)).toBe(true);
      });

      it('should validate bash wrapper after stripping env vars', () => {
        // Strip env vars first
        const stripped = stripEnvPrefix("FOO=bar", ["BAR=baz", "bash", "-c", "git status"]);
        expect(stripped.cmd).toBe("bash");
        expect(stripped.args).toEqual(["-c", "git status"]);

        // Parse the bash wrapper
        const wrapperResult = parseBashWrapper(stripped.cmd, stripped.args);
        expect(wrapperResult.isWrapper).toBe(true);
        expect(wrapperResult.executableToCheck).toBe("git");

        // Validation should run on the unwrapped command
        const tokens = parseShellCommand(wrapperResult.commandString!);
        const fullCmd = tokens.join(" ");
        expect(fullCmd).toBe("git status");
        expect(allowedCommand(fullCmd, testPolicy)).toBe(true);
      });

      it('should validate sh wrapper after stripping env vars', () => {
        // Strip env vars first
        const stripped = stripEnvPrefix("FOO=bar", ["sh", "-c", "echo test"]);
        expect(stripped.cmd).toBe("sh");
        expect(stripped.args).toEqual(["-c", "echo test"]);

        // Parse the sh wrapper
        const wrapperResult = parseBashWrapper(stripped.cmd, stripped.args);
        expect(wrapperResult.isWrapper).toBe(true);
        expect(wrapperResult.shell).toBe("sh");
        expect(wrapperResult.executableToCheck).toBe("echo");
      });

      it('should correctly handle env vars with denied commands', () => {
        // Strip env vars first
        const stripped = stripEnvPrefix("FOO=bar", ["git", "push", "origin", "main"]);
        expect(stripped.cmd).toBe("git");
        expect(stripped.args).toEqual(["push", "origin", "main"]);

        // Validation should run on the actual command and deny it
        const fullCmd = buildCmdLine(stripped.cmd, stripped.args);
        expect(fullCmd).toBe("git push origin main");
        expect(allowedCommand(fullCmd, testPolicy)).toBe(false);
      });

      it('should correctly handle env vars with bash wrapper containing denied command', () => {
        // Strip env vars first
        const stripped = stripEnvPrefix("FOO=bar", ["bash", "-c", "git push origin main"]);
        expect(stripped.cmd).toBe("bash");
        expect(stripped.args).toEqual(["-c", "git push origin main"]);

        // Parse the bash wrapper
        const wrapperResult = parseBashWrapper(stripped.cmd, stripped.args);
        expect(wrapperResult.isWrapper).toBe(true);

        // Validation should run on the unwrapped command and deny it
        const tokens = parseShellCommand(wrapperResult.commandString!);
        const fullCmd = tokens.join(" ");
        expect(fullCmd).toBe("git push origin main");
        expect(allowedCommand(fullCmd, testPolicy)).toBe(false);
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

    describe('Sh wrapper support', () => {
      it('should detect sh as a wrapper command', () => {
        const result = parseBashWrapper("sh", ["-c", "git status"]);
        expect(result.isWrapper).toBe(true);
        expect(result.executableToCheck).toBe("git");
        expect(result.shell).toBe("sh");
        expect(result.commandString).toBe("git status");
      });

      it('should parse sh -lc wrapper', () => {
        const result = parseBashWrapper("sh", ["-lc", "aws s3 ls"]);
        expect(result.isWrapper).toBe(true);
        expect(result.executableToCheck).toBe("aws");
        expect(result.shouldUseLogin).toBe(true);
        expect(result.commandString).toBe("aws s3 ls");
        expect(result.shell).toBe("sh");
      });

      it('should parse sh -l -c wrapper (separate flags)', () => {
        const result = parseBashWrapper("sh", ["-l", "-c", "kubectl get pods"]);
        expect(result.isWrapper).toBe(true);
        expect(result.executableToCheck).toBe("kubectl");
        expect(result.shouldUseLogin).toBe(true);
        expect(result.commandString).toBe("kubectl get pods");
        expect(result.shell).toBe("sh");
      });

      it('should reject sh -l without -c', () => {
        expect(() => parseBashWrapper("sh", ["-l"])).toThrow("missing -c command string");
      });

      it('should reject sh -c without command string', () => {
        expect(() => parseBashWrapper("sh", ["-c"])).toThrow("missing command string after -c");
      });

      it('should handle sh with complex commands', () => {
        const result = parseBashWrapper("sh", ["-c", 'git commit -m "my message"']);
        expect(result.isWrapper).toBe(true);
        expect(result.executableToCheck).toBe("git");
        expect(result.shell).toBe("sh");
      });

      it('should track shell type for bash vs sh', () => {
        const bashResult = parseBashWrapper("bash", ["-c", "echo test"]);
        expect(bashResult.shell).toBe("bash");

        const shResult = parseBashWrapper("sh", ["-c", "echo test"]);
        expect(shResult.shell).toBe("sh");
      });

      it('should allow sh -lc commands in policy', () => {
        // sh -lc should be allowed by default config
        expect(allowedCommand("sh -lc 'echo hello'", testPolicy)).toBe(true);
      });
    });
  });

  describe('Policy Diagnostics (checkCommandPolicy)', () => {
    it('should return allowed with allow rule match', () => {
      const result = checkCommandPolicy("git status", testPolicy);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("Command matches allow rule");
      expect(result.ruleType).toBe("allow");
      expect(result.matchedRule).toBeDefined();
      expect(result.matchedRule).toContain("git");
    });

    it('should return denied with deny rule match', () => {
      const result = checkCommandPolicy("git push origin main", testPolicy);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Command matches deny rule");
      expect(result.ruleType).toBe("deny");
      expect(result.matchedRule).toBeDefined();
      expect(result.matchedRule).toContain("push");
    });

    it('should return denied with no matching rules', () => {
      const result = checkCommandPolicy("rm -rf /", testPolicy);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Command does not match any allow rule");
      expect(result.ruleType).toBeUndefined();
      expect(result.matchedRule).toBeUndefined();
    });

    it('should prioritize deny rules over allow rules', () => {
      // git is allowed, but "git push origin main" is explicitly denied
      const result = checkCommandPolicy("git push origin main", testPolicy);
      expect(result.allowed).toBe(false);
      expect(result.ruleType).toBe("deny");
      expect(result.reason).toBe("Command matches deny rule");
    });

    it('should provide regex source in matched rule', () => {
      const result = checkCommandPolicy("git status", testPolicy);
      expect(result.allowed).toBe(true);
      expect(result.matchedRule).toBeDefined();
      // The regex source should be visible for debugging
      expect(typeof result.matchedRule).toBe("string");
      expect(result.matchedRule!.length).toBeGreaterThan(0);
    });

    it('should handle multiple allow rule matches (returns first)', () => {
      // Multiple rules might match the same command
      // The function should return the first matching rule
      const result = checkCommandPolicy("git status", testPolicy);
      expect(result.allowed).toBe(true);
      expect(result.matchedRule).toBeDefined();
    });

    it('should work with custom test policy', () => {
      const customPolicy: Policy = {
        rootDirectory: '/test',
        allowedWorktrees: new Set<string>(),
        worktreeDetectionEnabled: true,
        allow: [/^echo(\s|$)/i],
        deny: [/^echo secret/i],
        timeoutMs: 60000,
        maxBytes: 2000000,
        envWhitelist: []
      };

      // Deny rule should match
      let result = checkCommandPolicy("echo secret data", customPolicy);
      expect(result.allowed).toBe(false);
      expect(result.ruleType).toBe("deny");

      // Allow rule should match
      result = checkCommandPolicy("echo hello", customPolicy);
      expect(result.allowed).toBe(true);
      expect(result.ruleType).toBe("allow");

      // No rules match
      result = checkCommandPolicy("cat file", customPolicy);
      expect(result.allowed).toBe(false);
      expect(result.ruleType).toBeUndefined();
    });

    it('should maintain backward compatibility with allowedCommand', () => {
      // allowedCommand should use checkCommandPolicy internally
      const cmd = "git status";
      const newResult = checkCommandPolicy(cmd, testPolicy);
      const legacyResult = allowedCommand(cmd, testPolicy);

      expect(legacyResult).toBe(newResult.allowed);
    });

    it('should provide diagnostics for common scenarios', () => {
      // Scenario 1: Command not on allowlist
      let result = checkCommandPolicy("curl http://example.com", testPolicy);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not match any allow rule");
      expect(result.matchedRule).toBeUndefined();

      // Scenario 2: Explicitly denied command
      result = checkCommandPolicy("git push origin master", testPolicy);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("matches deny rule");
      expect(result.matchedRule).toBeDefined();

      // Scenario 3: Allowed command
      result = checkCommandPolicy("make build", testPolicy);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("matches allow rule");
      expect(result.matchedRule).toBeDefined();
    });

    it('should handle bash wrapper commands', () => {
      // Test that wrapped commands can be checked
      const result = checkCommandPolicy("bash -lc 'git status'", testPolicy);
      // bash is on the allowlist, so this should pass
      expect(result.allowed).toBe(true);
      expect(result.ruleType).toBe("allow");
    });

    it('should return structured data for error messages', () => {
      const result = checkCommandPolicy("forbidden-command", testPolicy);

      // Verify all required fields are present for error message construction
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('reason');
      expect(typeof result.allowed).toBe('boolean');
      expect(typeof result.reason).toBe('string');

      // Optional fields should be undefined when not applicable
      if (result.matchedRule) {
        expect(typeof result.matchedRule).toBe('string');
      }
      if (result.ruleType) {
        expect(['allow', 'deny']).toContain(result.ruleType);
      }
    });
  });
});