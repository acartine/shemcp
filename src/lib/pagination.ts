import { existsSync, unlinkSync, mkdirSync, createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { debugLog } from "./debug.js";

export const MAX_PAGE_LIMIT_BYTES = 40000;
export const DEFAULT_PAGE_LIMIT_BYTES = MAX_PAGE_LIMIT_BYTES;

/** ---------- Pagination Types ---------- */

export type CursorConfig = {
  cursor_type: string;    // type of cursor positioning (currently only "bytes" supported)
  offset: number;         // byte offset from start of output stream (must be ≥ 0)
};

export type PaginationConfig = {
  cursor?: CursorConfig;  // position marker object for pagination (required when using pagination)
  limit_bytes?: number;   // default & maximum: 40 KB
  limit_lines?: number;   // optional: stops on whichever hits first
};

export type LargeOutputBehavior = "spill" | "truncate" | "error";

export type SpillFile = {
  uri: string;
  path: string;
  stderrUri?: string | undefined;
  stderrPath?: string | undefined;
  cleanup: () => void;
};

/** ---------- Pagination Helpers ---------- */

export function parseCursor(cursor: CursorConfig | undefined | null): { type: string; offset: number } {
  // Handle object format only (no legacy string support)
  if (!cursor || typeof cursor !== 'object') {
    throw new Error(`Invalid cursor format: expected object, got ${typeof cursor}. Cursor must be an object with 'cursor_type' and 'offset' properties.`);
  }

  // TypeScript should ensure this is a CursorConfig at this point, but let's be safe
  const cursorConfig = cursor as CursorConfig;

  if (!cursor.cursor_type || typeof cursor.cursor_type !== 'string') {
    throw new Error(`Invalid cursor format: missing or invalid 'cursor_type' property. Expected string, got ${typeof cursor.cursor_type}.`);
  }

  // Validate cursor_type is supported
  if (cursor.cursor_type !== 'bytes') {
    throw new Error(`Invalid cursor format: unsupported cursor_type '${cursor.cursor_type}'. Currently only 'bytes' is supported.`);
  }

  // Coerce and validate offset
  let offset: number;
  if (cursor.offset === undefined || cursor.offset === null) {
    offset = 0;
  } else {
    offset = Number(cursor.offset);
    if (!Number.isFinite(offset)) {
      throw new Error(`Invalid cursor format: 'offset' must be a finite number, got ${cursor.offset}.`);
    }
    if (offset < 0) {
      throw new Error(`Invalid cursor format: 'offset' must be non-negative, got ${offset}.`);
    }
  }

  return {
    type: cursorConfig.cursor_type,
    offset: offset
  };
}

export function createSpillFile(): SpillFile {
  const tempDir = join(homedir(), ".shemcp", "tmp");
  mkdirSync(tempDir, { recursive: true });

  const id = randomUUID();
  const path = join(tempDir, `exec-${id}.out`);
  const uri = `mcp://tmp/exec-${id}.out`;
  const stderrPath = join(tempDir, `exec-${id}.err`);
  const stderrUri = `mcp://tmp/exec-${id}.err`;

  return {
    uri,
    path,
    stderrUri,
    stderrPath,
    cleanup: () => {
      const errors: string[] = [];

      try {
        if (existsSync(path)) {
          unlinkSync(path);
          debugLog("Cleaned up stdout spill file", { path });
        }
      } catch (e) {
        const errorMsg = `Failed to cleanup stdout spill file ${path}: ${e}`;
        errors.push(errorMsg);
        debugLog(errorMsg);
      }

      try {
        if (existsSync(stderrPath)) {
          unlinkSync(stderrPath);
          debugLog("Cleaned up stderr spill file", { stderrPath });
        }
      } catch (e) {
        const errorMsg = `Failed to cleanup stderr spill file ${stderrPath}: ${e}`;
        errors.push(errorMsg);
        debugLog(errorMsg);
      }

      if (errors.length > 0) {
        debugLog("Spill file cleanup completed with errors", { errors });
      }
    }
  };
}

export function detectMimeType(content: string): string {
   // Enhanced MIME type detection based on content
   const trimmed = content.trim();

   // JSON detection
   if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
     try {
       JSON.parse(content);
       return "application/json";
     } catch {
       // Not valid JSON, continue with other checks
     }
   }

   // XML detection
   if (trimmed.startsWith('<') && trimmed.includes('</')) {
     return "application/xml";
   }

   // HTML detection
   if (trimmed.startsWith('<!DOCTYPE html') || trimmed.startsWith('<html')) {
     return "text/html";
   }

   // CSV detection (simple heuristic)
   const firstLine = trimmed.split('\n')[0];
   if (trimmed.includes(',') && firstLine && firstLine.split(',').length > 2) {
     return "text/csv";
   }

   // YAML detection (simple heuristic)
   if ((trimmed.startsWith('- ') || trimmed.match(/^\s*\w+:\s/)) && !trimmed.includes(';')) {
     return "application/x-yaml";
   }

   // Default to plain text
   return "text/plain";
 }

export function countLines(content: string): number {
  return content.split('\n').length;
}

export async function readFileRange(filePath: string, start: number, end: number): Promise<string> {
   // Handle edge case where end <= start to avoid ERR_OUT_OF_RANGE
   if (end <= start) {
     return Promise.resolve('');
   }

   // Use createReadStream to read only the requested byte range
   return new Promise<string>((resolve, reject) => {
     const chunks: Buffer[] = [];
     let totalBytesRead = 0;

     const stream = createReadStream(filePath, { start, end: end - 1 });

     stream.on('data', (chunk: any) => {
       chunks.push(Buffer.from(chunk));
       totalBytesRead += Buffer.from(chunk).length;
     });

     stream.on('end', () => {
       const buffer = Buffer.concat(chunks);
       resolve(buffer.toString('utf8'));
     });

     stream.on('error', (error) => {
       reject(error);
     });
   });
 }

export function getFileSizeSync(filePath: string): number {
  return statSync(filePath).size;
}
