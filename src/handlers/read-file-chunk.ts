import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  parseCursor,
  detectMimeType,
  readFileRange,
  getFileSizeSync,
  DEFAULT_PAGE_LIMIT_BYTES,
  MAX_PAGE_LIMIT_BYTES,
} from "../lib/pagination.js";

export async function handleReadFileChunk(args: any) {
  const input = args as any;
  const uri = input.uri;
  const requestedLimit = input.limit_bytes ?? DEFAULT_PAGE_LIMIT_BYTES;
  const numericLimit = Number(requestedLimit);

  if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
    return {
      content: [{ type: "text", text: "Error: limit_bytes must be a positive number" }],
      isError: true,
    };
  }

  if (numericLimit > MAX_PAGE_LIMIT_BYTES) {
    return {
      content: [{ type: "text", text: `Error: limit_bytes must be <= ${MAX_PAGE_LIMIT_BYTES}` }],
      isError: true,
    };
  }

  const limitBytes = Math.min(Math.max(numericLimit, 1), MAX_PAGE_LIMIT_BYTES);

  // Validate cursor format
  try {
    const cursor = input.cursor || { cursor_type: "bytes", offset: 0 };
    parseCursor(cursor); // This will throw if format is invalid
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: Invalid cursor format: ${error.message}` }],
      isError: true,
    };
  }

  const cursor = input.cursor || { cursor_type: "bytes", offset: 0 };

  // Extract file path from URI
  if (!uri.startsWith("mcp://tmp/")) {
    return {
      content: [{ type: "text", text: `Error: Invalid URI format. Expected mcp://tmp/..., got: ${uri}` }],
      isError: true,
    };
  }

  const fileName = uri.substring("mcp://tmp/".length);
  const filePath = join(homedir(), ".shemcp", "tmp", fileName);

  if (!existsSync(filePath)) {
    return {
      content: [{ type: "text", text: `Error: Spill file not found: ${filePath}` }],
      isError: true,
    };
  }

  try {
     // Get file stats to determine total size without reading whole file
     const totalBytes = getFileSizeSync(filePath);

     const { offset } = parseCursor(cursor);
     const endPos = Math.min(offset + limitBytes, totalBytes);

     // Use range reader to avoid loading whole file into RAM
     const chunk = await readFileRange(filePath, offset, endPos);

     const nextCursor = endPos < totalBytes ? { cursor_type: "bytes", offset: endPos } : undefined;

     return {
       content: [{
         type: "resource",
         resource: {
           uri,
           text: JSON.stringify({
             data: chunk,
             bytes_start: offset,
             bytes_end: endPos,
             total_bytes: totalBytes,
             next_cursor: nextCursor,
             mime: detectMimeType(chunk)
           }, null, 2)
         }
       }]
     };
   } catch (error) {
     return {
       content: [{ type: "text", text: `Error reading spill file: ${error}` }],
       isError: true,
     };
   }
}
