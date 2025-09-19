import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as toml from "toml";
import type { Config } from "./schema.js";
import { ConfigSchema, DEFAULT_CONFIG } from "./schema.js";

export class ConfigLoader {
  private static getConfigPaths(): string[] {
    return [
      // User config (highest priority)
      path.join(os.homedir(), ".config", "shemcp", "config.toml"),
      path.join(os.homedir(), ".shemcp", "config.toml"),
      // System config (lower priority)
      "/etc/shemcp/config.toml",
    ];
  }

  /**
   * Load and merge configuration from available config files
   */
  static loadConfig(): Config {
    // Start from defaults, but allow partial overrides before validation
    let mergedConfig: any = { ...DEFAULT_CONFIG };

    // Load configs in reverse priority order so higher priority overwrites
    const configPaths = [...this.getConfigPaths()].reverse();

    for (const configPath of configPaths) {
      try {
        if (fs.existsSync(configPath)) {
          const fileConfig = this.loadConfigFile(configPath);
          mergedConfig = this.mergeConfigs(mergedConfig, fileConfig);
        }
      } catch (error) {
        console.warn(`Warning: Failed to load config from ${configPath}: ${error}`);
      }
    }

    // Ensure required derived defaults are present before parsing
    if (!mergedConfig.directories) mergedConfig.directories = {};
    if (!mergedConfig.directories.root) {
      // Use user's home directory if not provided anywhere
      mergedConfig.directories.root = os.homedir();
    }

    // Validate the final merged config
    const validated = ConfigSchema.parse(mergedConfig);
    
    // Expand paths and compile patterns
    return this.postProcessConfig(validated);
  }

  /**
   * Load a single config file
   */
  private static loadConfigFile(filePath: string): Partial<Config> {
    // Check file permissions if security checking is enabled
    const stats = fs.statSync(filePath);
    if ((stats.mode & 0o022) !== 0) {
      console.warn(`Warning: Config file ${filePath} is writable by group/other (permissions: ${(stats.mode & 0o777).toString(8)})`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = toml.parse(content);
    
    // Return the parsed config (validation happens during merge)
    return parsed as Partial<Config>;
  }

  /**
   * Deep merge two config objects
   */
  private static mergeConfigs(base: Config, override: Partial<Config>): Config {
    const merged = { ...base };

    if (override.server) {
      merged.server = { ...merged.server, ...override.server };
    }
    if (override.directories) {
      merged.directories = { ...merged.directories, ...override.directories };
    }
    if (override.commands) {
      merged.commands = { ...merged.commands, ...override.commands };
    }
    if (override.limits) {
      merged.limits = { ...merged.limits, ...override.limits };
    }
    if (override.environment) {
      merged.environment = { ...merged.environment, ...override.environment };
    }
    if (override.security) {
      merged.security = { ...merged.security, ...override.security };
    }

    return merged;
  }

  /**
   * Post-process config: expand paths, compile regexes, etc.
   */
  private static postProcessConfig(config: Config): Config {
    // Post-processing complete - root directory is already set by schema defaults
    return config;
  }

  /**
   * Expand ~ to home directory
   */
  private static expandPath(filePath: string): string {
    if (filePath.startsWith('~/')) {
      return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
  }

  /**
   * Get all possible config file paths (for debugging)
   */
  static getAllConfigPaths(): string[] {
    return this.getConfigPaths();
  }

  /**
   * Check which config files actually exist
   */
  static getExistingConfigPaths(): string[] {
    return this.getConfigPaths().filter(p => fs.existsSync(p));
  }
}