import { spawn } from "node:child_process";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import type { Policy } from "./policy.js";
import { filteredEnv } from "./policy.js";
import {
  type PaginationConfig,
  type LargeOutputBehavior,
  type SpillFile,
  parseCursor,
  createSpillFile,
  detectMimeType,
  countLines,
  readFileRange,
  DEFAULT_PAGE_LIMIT_BYTES,
  MAX_PAGE_LIMIT_BYTES
} from "./pagination.js";
import { debugLog } from "./debug.js";

/** ---------- Command Execution ---------- */

export async function execWithPagination(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  policy: Policy,
  pagination?: PaginationConfig,
  onLargeOutput: LargeOutputBehavior = "spill"
): Promise<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  totalBytes: number;
  truncated: boolean;
  nextCursor?: { cursor_type: string; offset: number };
  spillFile?: SpillFile;
  mime: string;
  lineCount: number;
  stderrCount: number;
}> {
  const child = spawn(cmd, args, { cwd, env: filteredEnv(policy), stdio: ["ignore", "pipe", "pipe"] });

  // Parse pagination config
  const requestedLimitBytes = pagination?.limit_bytes ?? DEFAULT_PAGE_LIMIT_BYTES;
  const sanitizedLimitBytes = Math.max(1, requestedLimitBytes);
  const limitBytes = Math.min(sanitizedLimitBytes, MAX_PAGE_LIMIT_BYTES);
  const limitLines = pagination?.limit_lines || 2000;
  const startOffset = pagination?.cursor ? parseCursor(pagination.cursor).offset : 0;

  // Create spill file if needed
  let spillFile: SpillFile | undefined;
  let hasStdoutSpill = false;
  let hasStderrSpill = false;

  if (onLargeOutput === "spill") {
    spillFile = createSpillFile();
  }

  // For pagination, we need to track complete streams but cap memory usage
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let totalStdoutBytes = 0;
  let totalStderrBytes = 0;
  const started = Date.now();

  child.stdout.on("data", (c: Buffer) => {
    totalStdoutBytes += c.length;

    // Cap in-memory buffer to prevent OOM, but keep enough for current page
    const maxMemoryBytes = Math.max(limitBytes * 2, maxBytes); // Keep 2x limit for current page context
    if (stdoutBuffer.length > maxMemoryBytes) {
      // Keep only the last part of the buffer (current page context)
      const keepBytes = Math.min(limitBytes, maxMemoryBytes / 2);
      stdoutBuffer = stdoutBuffer.slice(-keepBytes);
    }

    // Only keep data if we need it for in-memory processing
    if (stdoutBuffer.length + c.length <= maxMemoryBytes) {
      stdoutBuffer = Buffer.concat([stdoutBuffer, c]);
    } else {
      // If adding this chunk would exceed memory limit, just update total but don't store
      debugLog("Skipping stdout buffer storage due to memory limit", { chunkSize: c.length, total: totalStdoutBytes });
    }

    // Write to spill file for complete stream access
    if (spillFile) {
      try {
        appendFileSync(spillFile.path, c);
        hasStdoutSpill = true;
      } catch (e) {
        debugLog("Failed to write to stdout spill file", e);
      }
    }
  });

  child.stderr.on("data", (c: Buffer) => {
    totalStderrBytes += c.length;

    // Cap in-memory buffer to prevent OOM
    const maxMemoryBytes = Math.max(limitBytes * 2, maxBytes);
    if (stderrBuffer.length > maxMemoryBytes) {
      const keepBytes = Math.min(limitBytes, maxMemoryBytes / 2);
      stderrBuffer = stderrBuffer.slice(-keepBytes);
    }

    stderrBuffer = Buffer.concat([stderrBuffer, c]);

    // Write to stderr spill file
    if (spillFile) {
      try {
        appendFileSync(spillFile.stderrPath!, c);
        hasStderrSpill = true;
      } catch (e) {
        debugLog("Failed to write to stderr spill file", e);
      }
    }
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (error) => {
      debugLog("Child process error", { error: error.message });
      resolve({ code: -1, signal: null });
    });
  });

  const killer = setTimeout(() => {
    debugLog("Command timed out, killing process", { timeoutMs });
    child.kill("SIGKILL");
  }, timeoutMs);

  const result = await exit;
  clearTimeout(killer);

  const durationMs = Date.now() - started;

  // For pagination, we need to read from spill files to get accurate byte-aligned data
  let returnedStdout = "";
  let returnedStderr = "";

  if (spillFile && hasStdoutSpill) {
    // Read only the specific byte range from stdout spill file
    try {
      const stdoutEnd = Math.min(startOffset + limitBytes, totalStdoutBytes);
      returnedStdout = await readFileRange(spillFile.path, startOffset, stdoutEnd);
    } catch (e) {
      debugLog("Failed to read from stdout spill file", e);
      // Fallback to in-memory buffer with byte-aware slicing
      const stdoutEnd = Math.min(startOffset + limitBytes, stdoutBuffer.length);
      returnedStdout = stdoutBuffer.subarray(startOffset, stdoutEnd).toString("utf8");
    }
  } else {
    // No spill file, use in-memory buffer with byte-aware slicing
    const stdoutEnd = Math.min(startOffset + limitBytes, stdoutBuffer.length);
    returnedStdout = stdoutBuffer.subarray(startOffset, stdoutEnd).toString("utf8");
  }

  // Handle stderr - use policy limit for in-memory stderr
  if (spillFile && hasStderrSpill) {
    try {
      const stderrEnd = Math.min(maxBytes, totalStderrBytes);
      returnedStderr = await readFileRange(spillFile.stderrPath!, 0, stderrEnd);
    } catch (e) {
      debugLog("Failed to read from stderr spill file", e);
      const stderrEnd = Math.min(maxBytes, stderrBuffer.length);
      returnedStderr = stderrBuffer.subarray(0, stderrEnd).toString("utf8");
    }
  } else {
    const stderrEnd = Math.min(maxBytes, stderrBuffer.length);
    returnedStderr = stderrBuffer.subarray(0, stderrEnd).toString("utf8");
  }

  // Determine if we need pagination
  const stdoutLines = countLines(returnedStdout);
  const stderrLines = countLines(returnedStderr);
  const totalBytes = totalStdoutBytes + totalStderrBytes;
  const needsPagination = totalStdoutBytes > limitBytes || stdoutLines > limitLines;

  let truncated = false;
  let nextCursor: { cursor_type: string; offset: number } | undefined;

  if (needsPagination && onLargeOutput === "truncate") {
    truncated = true;
  } else if (needsPagination && onLargeOutput === "error") {
    throw new Error(`Output too large: ${totalBytes} bytes, ${stdoutLines} lines. Use pagination or spill mode.`);
  } else if (needsPagination && spillFile) {
    // Calculate next cursor based on actual bytes returned
    const actualBytesReturned = Buffer.byteLength(returnedStdout, 'utf8');
    const nextOffset = startOffset + actualBytesReturned;
    if (totalStdoutBytes > nextOffset) {
      nextCursor = { cursor_type: 'bytes', offset: nextOffset };
    }
  }

  const resultObj: any = {
    exitCode: result.code ?? -1,
    signal: result.signal ?? null,
    stdout: returnedStdout,
    stderr: returnedStderr,
    durationMs,
    totalBytes,
    truncated,
    mime: detectMimeType(returnedStdout),
    lineCount: stdoutLines,
    stderrCount: stderrLines
  };

  if (nextCursor) {
    resultObj.nextCursor = nextCursor;
  }

  // Only include spill file if we actually created one and wrote to it
  if (spillFile && (hasStdoutSpill || hasStderrSpill)) {
    // Create a clean spill file object with only the URIs that were actually used
    const cleanSpillFile: SpillFile = {
      uri: hasStdoutSpill ? spillFile.uri : '',
      path: hasStdoutSpill ? spillFile.path : '',
      stderrUri: hasStderrSpill ? spillFile.stderrUri : undefined,
      stderrPath: hasStderrSpill ? spillFile.stderrPath : undefined,
      cleanup: () => {
        try {
          if (hasStdoutSpill && existsSync(spillFile!.path)) {
            unlinkSync(spillFile!.path);
          }
          if (hasStderrSpill && existsSync(spillFile!.stderrPath!)) {
            unlinkSync(spillFile!.stderrPath!);
          }
        } catch (e) {
          debugLog("Failed to cleanup spill files", { path: spillFile!.path, stderrPath: spillFile!.stderrPath, error: e });
        }
      }
    };

    // Only set non-empty URIs
    if (hasStdoutSpill) {
      cleanSpillFile.uri = spillFile.uri;
      cleanSpillFile.path = spillFile.path;
    }
    if (hasStderrSpill) {
      cleanSpillFile.stderrUri = spillFile.stderrUri;
      cleanSpillFile.stderrPath = spillFile.stderrPath;
    }

    resultObj.spillFile = cleanSpillFile;
  }

  return resultObj;
}

export async function execOnce(cmd: string, args: string[], cwd: string, timeoutMs: number, maxBytes: number, policy: Policy) {
  const child = spawn(cmd, args, { cwd, env: filteredEnv(policy), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  const started = Date.now();

  const addChunk = (buf: Buffer, chunk: Buffer) =>
    Buffer.concat([buf, chunk.slice(0, Math.max(0, maxBytes - buf.length))]);

  child.stdout.on("data", (c: Buffer) => { stdout = addChunk(stdout, c); });
  child.stderr.on("data", (c: Buffer) => { stderr = addChunk(stderr, c); });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const killer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);

  const result = await exit;
  clearTimeout(killer);

  return {
    durationMs: Date.now() - started,
    exitCode: result.code ?? -1,
    signal: result.signal ?? null,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
  };
}
