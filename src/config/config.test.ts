import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ConfigLoader } from './loader.js';
import { DEFAULT_CONFIG } from './schema.js';

// Mock fs and os modules
vi.mock('node:fs');
vi.mock('node:os');

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

describe('Configuration System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementations
    mockOs.homedir.mockReturnValue('/home/testuser');
    mockFs.existsSync.mockReturnValue(false);
  });

  describe('ConfigLoader', () => {
    it('should load default configuration successfully', () => {
      const config = ConfigLoader.loadConfig();
      
      // Basic structure validation
      expect(config).toBeDefined();
      expect(config.server).toBeDefined();
      expect(config.directories).toBeDefined();
      expect(config.commands).toBeDefined();
      expect(config.limits).toBeDefined();
      expect(config.environment).toBeDefined();
    });

    it('should have correct server info', () => {
      const config = ConfigLoader.loadConfig();
      expect(config.server.name).toBe('shemcp');
    });

    it('should have root directory set to current working directory', () => {
      const config = ConfigLoader.loadConfig();
      // Root directory should be set to process.cwd()
      expect(config.directories.root).toBe(process.cwd());
    });

    it('should provide config file path utilities', () => {
      const allPaths = ConfigLoader.getAllConfigPaths();
      const existingPaths = ConfigLoader.getExistingConfigPaths();
      
      expect(Array.isArray(allPaths)).toBe(true);
      expect(Array.isArray(existingPaths)).toBe(true);
      expect(allPaths.length).toBeGreaterThan(0);
      
      // Should include standard config paths
      expect(allPaths.some(p => p.includes('.config/shemcp'))).toBe(true);
      expect(allPaths.some(p => p.includes('/etc/shemcp'))).toBe(true);
    });

    it('should handle file system operations safely', () => {
      // Mock a config file exists but is unreadable
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });
      
      // Should not crash, should fall back to defaults
      expect(() => ConfigLoader.loadConfig()).not.toThrow();
    });
  });

  describe('Configuration Schema', () => {
    it('should provide reasonable defaults', () => {
      const defaults = DEFAULT_CONFIG;
      
      expect(defaults.server.name).toBe('shemcp');
      expect(defaults.directories.root).toBe(process.cwd());
      expect(defaults.commands.allow.length).toBeGreaterThan(0);
      expect(defaults.limits.timeout_seconds).toBeGreaterThan(0);
      expect(defaults.environment.whitelist.length).toBeGreaterThan(0);
    });

    it('should have secure default limits', () => {
      const defaults = DEFAULT_CONFIG;
      
      expect(defaults.limits.timeout_seconds).toBeLessThanOrEqual(300);
      expect(defaults.limits.max_output_bytes).toBeLessThanOrEqual(10_000_000);
      expect(defaults.limits.max_output_bytes).toBeGreaterThanOrEqual(1000);
    });
  });
});