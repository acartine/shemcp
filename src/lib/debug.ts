import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** ---------- Debug Logging ---------- */
const DEBUG_LOG_PATH = join(homedir(), ".shemcp", "debug.log");

export function initDebugLog() {
  try {
    const logDir = join(homedir(), ".shemcp");
    mkdirSync(logDir, { recursive: true });
    // Clear log on startup
    appendFileSync(DEBUG_LOG_PATH, `\n\n========== NEW SESSION: ${new Date().toISOString()} ==========\n`);
  } catch (e) {
    // Ignore logging errors
  }
}

export function debugLog(message: string, data?: any) {
  try {
    const timestamp = new Date().toISOString();
    const logMessage = data
      ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
      : `[${timestamp}] ${message}\n`;
    appendFileSync(DEBUG_LOG_PATH, logMessage);
  } catch (e) {
    // Ignore logging errors
  }
}
