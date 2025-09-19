#!/usr/bin/env node
// Test script to simulate Claude Code's interaction with the MCP server

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log('[TEST] Starting MCP server...');
const serverPath = join(__dirname, 'dist', 'index.js');
const child = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe']
});

console.log('[TEST] Server PID:', child.pid);

// Set up handlers
child.on('exit', (code, signal) => {
  console.log('[TEST] Server exited with code:', code, 'signal:', signal);
  if (code === 0) {
    console.log('[TEST] ✓ Server exited cleanly');
  } else {
    console.log('[TEST] ✗ Server exited with error');
  }
});

child.on('error', (err) => {
  console.log('[TEST] Server error:', err);
});

// Wait a moment then send SIGINT like Claude Code does
setTimeout(() => {
  console.log('[TEST] Sending SIGINT to server...');
  child.kill('SIGINT');
}, 1000);

// Give it time to clean up
setTimeout(() => {
  if (child.exitCode === null) {
    console.log('[TEST] Server still running after 3 seconds, forcing kill');
    child.kill('SIGKILL');
  }
}, 3000);