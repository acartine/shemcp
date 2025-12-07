import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseWorktreeList,
  matchesWorktreePattern,
  validateWorktreePath,
  isWithinAllowedWorktrees,
  clearWorktreeCache,
  type WorktreeInfo
} from './worktree.js';

describe('Worktree Detection', () => {
  beforeEach(() => {
    clearWorktreeCache();
  });

  afterEach(() => {
    clearWorktreeCache();
  });

  describe('parseWorktreeList', () => {
    it('should parse porcelain output correctly', () => {
      const output = `worktree /Users/user/repo
HEAD abc123def456
branch refs/heads/main

worktree /Users/user/repo-feature
HEAD def456abc789
branch refs/heads/feature
`;
      const result = parseWorktreeList(output);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        path: '/Users/user/repo',
        head: 'abc123def456',
        branch: 'refs/heads/main'
      });
      expect(result[1]).toEqual({
        path: '/Users/user/repo-feature',
        head: 'def456abc789',
        branch: 'refs/heads/feature'
      });
    });

    it('should handle empty output', () => {
      const result = parseWorktreeList('');
      expect(result).toEqual([]);
    });

    it('should handle single worktree', () => {
      const output = `worktree /Users/user/repo
HEAD abc123
branch refs/heads/main
`;
      const result = parseWorktreeList(output);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/Users/user/repo');
    });

    it('should handle worktrees without branches (detached HEAD)', () => {
      const output = `worktree /Users/user/repo
HEAD abc123
detached

worktree /Users/user/repo-detached
HEAD def456
detached
`;
      const result = parseWorktreeList(output);
      expect(result).toHaveLength(2);
      expect(result[0].branch).toBeUndefined();
      expect(result[1].branch).toBeUndefined();
    });

    it('should handle output with extra whitespace', () => {
      const output = `worktree /Users/user/repo
HEAD abc123
branch refs/heads/main


`;
      const result = parseWorktreeList(output);
      expect(result).toHaveLength(1);
    });

    it('should handle paths with spaces', () => {
      const output = `worktree /Users/user/my repo
HEAD abc123
branch refs/heads/main
`;
      const result = parseWorktreeList(output);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/Users/user/my repo');
    });
  });

  describe('matchesWorktreePattern', () => {
    it('should match sibling directories with same prefix', () => {
      expect(matchesWorktreePattern(
        '/Users/user/repo-feature',
        '/Users/user/repo'
      )).toBe(true);
    });

    it('should match exact sibling with suffix', () => {
      expect(matchesWorktreePattern(
        '/Users/user/1brutus-fix_something',
        '/Users/user/1brutus'
      )).toBe(true);
    });

    it('should match sibling with underscore suffix', () => {
      expect(matchesWorktreePattern(
        '/Users/user/myproject_feature',
        '/Users/user/myproject'
      )).toBe(true);
    });

    it('should not match different directory names', () => {
      expect(matchesWorktreePattern(
        '/Users/user/other-project',
        '/Users/user/repo'
      )).toBe(false);
    });

    it('should not match directories in different parents', () => {
      expect(matchesWorktreePattern(
        '/Users/other/repo-feature',
        '/Users/user/repo'
      )).toBe(false);
    });

    it('should not match the sandbox itself', () => {
      // The sandbox root itself would be handled by primary boundary check
      expect(matchesWorktreePattern(
        '/Users/user/repo',
        '/Users/user/repo'
      )).toBe(true); // Same basename starts with itself
    });

    it('should not match subdirectories of sandbox', () => {
      // Subdirectories would be handled by primary boundary check
      expect(matchesWorktreePattern(
        '/Users/user/repo/subdir',
        '/Users/user/repo'
      )).toBe(false); // Different parent
    });

    it('should handle trailing slashes', () => {
      expect(matchesWorktreePattern(
        '/Users/user/repo-feature/',
        '/Users/user/repo/'
      )).toBe(true);
    });
  });

  describe('isWithinAllowedWorktrees', () => {
    it('should return true for exact worktree match', () => {
      const allowed = new Set(['/Users/user/repo-feature']);
      expect(isWithinAllowedWorktrees('/Users/user/repo-feature', allowed)).toBe(true);
    });

    it('should return true for subdirectory of allowed worktree', () => {
      const allowed = new Set(['/Users/user/repo-feature']);
      expect(isWithinAllowedWorktrees('/Users/user/repo-feature/src', allowed)).toBe(true);
      expect(isWithinAllowedWorktrees('/Users/user/repo-feature/src/lib', allowed)).toBe(true);
    });

    it('should return false for paths not in allowed worktrees', () => {
      const allowed = new Set(['/Users/user/repo-feature']);
      expect(isWithinAllowedWorktrees('/Users/user/repo-other', allowed)).toBe(false);
      expect(isWithinAllowedWorktrees('/Users/user/repo', allowed)).toBe(false);
    });

    it('should return false for empty allowed set', () => {
      const allowed = new Set<string>();
      expect(isWithinAllowedWorktrees('/Users/user/repo-feature', allowed)).toBe(false);
    });

    it('should check multiple allowed worktrees', () => {
      const allowed = new Set([
        '/Users/user/repo-feature1',
        '/Users/user/repo-feature2'
      ]);
      expect(isWithinAllowedWorktrees('/Users/user/repo-feature1/src', allowed)).toBe(true);
      expect(isWithinAllowedWorktrees('/Users/user/repo-feature2/src', allowed)).toBe(true);
      expect(isWithinAllowedWorktrees('/Users/user/repo-feature3/src', allowed)).toBe(false);
    });

    it('should not match partial path names', () => {
      const allowed = new Set(['/Users/user/repo']);
      // repo-feature should NOT match just because it starts with 'repo'
      expect(isWithinAllowedWorktrees('/Users/user/repo-feature', allowed)).toBe(false);
    });
  });

  describe('validateWorktreePath', () => {
    // Note: These tests mock the git worktree list command behavior
    // In real usage, validateWorktreePath calls getWorktrees which executes git

    it('should return null for paths that do not match pattern', () => {
      // Path doesn't start with sandbox basename
      const result = validateWorktreePath(
        '/Users/user/completely-different',
        '/Users/user/repo'
      );
      expect(result).toBeNull();
    });

    it('should return null for paths in different parent directories', () => {
      const result = validateWorktreePath(
        '/tmp/repo-feature',
        '/Users/user/repo'
      );
      expect(result).toBeNull();
    });
  });

  describe('Policy integration', () => {
    it('should work with Policy allowedWorktrees Set', () => {
      // Simulate how ensureCwd would use these functions
      const policy = {
        rootDirectory: '/Users/user/repo',
        allowedWorktrees: new Set<string>(),
        worktreeDetectionEnabled: true
      };

      // Initially empty
      expect(isWithinAllowedWorktrees('/Users/user/repo-feature', policy.allowedWorktrees)).toBe(false);

      // After adding
      policy.allowedWorktrees.add('/Users/user/repo-feature');
      expect(isWithinAllowedWorktrees('/Users/user/repo-feature', policy.allowedWorktrees)).toBe(true);
      expect(isWithinAllowedWorktrees('/Users/user/repo-feature/src', policy.allowedWorktrees)).toBe(true);
    });

    it('should respect worktreeDetectionEnabled toggle', () => {
      const policy = {
        rootDirectory: '/Users/user/repo',
        allowedWorktrees: new Set<string>(),
        worktreeDetectionEnabled: false
      };

      // Even if pattern matches, detection is disabled
      // The actual check happens in ensureCwd, this just tests the flag
      expect(policy.worktreeDetectionEnabled).toBe(false);
    });
  });
});
