# Shell MCP Pagination and Large Output Handling Specification

This document describes an extension to the `shell_exec` MCP tool that enables reliable handling of large outputs, avoiding token overflow errors in LLMs (e.g., Claude, Codex, Gemini).

---

## 🧩 Overview

The problem: many shell commands produce massive outputs that exceed model token limits (25,000+).  
The solution: **structured pagination and spillover mechanisms** so agents can fetch, summarize, and reason over large results safely.

---

## 🚀 Core Design

### Request Schema (shell_exec)

```jsonc
{
  "cmd": "aws",
  "args": ["logs", "get-log-events", "..."],
  "cwd": "/path/opt",
  "env": {"AWS_REGION": "eu-north-1"},
  "page": {
    "cursor": "bytes:0",         // opaque position marker
    "limit_bytes": 65536,        // default: 64 KB
    "limit_lines": 2000          // optional: stops on whichever hits first
  },
  "on_large_output": "spill"     // "spill" | "truncate" | "error"
}
```

### Response Schema

```jsonc
{
  "exit_code": 0,
  "stdout_chunk": "first 64k of data...",
  "stderr_chunk": "",
  "bytes_start": 0,
  "bytes_end": 65535,
  "total_bytes": 58112234,
  "truncated": false,
  "next_cursor": "bytes:65536",   // omit if end reached
  "spill_uri": null,              // URI of temp file if spill mode engaged
  "mime": "text/plain",
  "line_count": 1780,
  "stderr_count": 0
}
```

---

## 📦 Spill Mode (Automatic File Storage)

When command output exceeds limits or when `on_large_output` is set to `"spill"`, output is written to a file.  
A secondary tool `read_file_chunk` is used to fetch it in small, token-safe chunks.

### read_file_chunk Request

```jsonc
{
  "uri": "mcp://tmp/exec-abc123.out",
  "cursor": "bytes:0",
  "limit_bytes": 65536
}
```

### read_file_chunk Response

```jsonc
{
  "data": "…",
  "bytes_start": 0,
  "bytes_end": 65535,
  "total_bytes": 58112234,
  "next_cursor": "bytes:65536",
  "mime": "text/plain"
}
```

---

## 🧠 Agent Behavior Hints

LLMs can automatically paginate when you expose standard keys:

- Always include `next_cursor` if more data exists.
- Use `truncated` or `spill_uri` to indicate large results.
- Provide small previews (`head_preview`, `tail_preview`) for guidance.

### Example Loop (pseudo)

```python
res = shell_exec(cmd="ls", args=["-la"], page={"limit_bytes": 65536})
while res.get("next_cursor"):
    res = shell_exec(cmd="ls", args=["-la"], page={"cursor": res["next_cursor"]})
```

### Example for Spill Handling

```python
res = shell_exec(cmd="cat", args=["huge.log"])
if res["spill_uri"]:
    chunk = read_file_chunk(uri=res["spill_uri"], limit_bytes=65536)
    while chunk.get("next_cursor"):
        chunk = read_file_chunk(uri=res["spill_uri"], cursor=chunk["next_cursor"])
```

---

## 🧰 Optional Enhancements

| Feature | Description | Benefit |
|----------|--------------|----------|
| `json_path` | JMESPath-like filter for JSON output | Model retrieves only needed subset |
| `grep` | Built-in regex filtering server-side | Safer and faster search in long outputs |
| `zip` | Option to gzip large outputs before spill | Useful for binary or log-heavy commands |
| `mime` detection | Automatic MIME type tagging | Helps agent reason about structure |
| `summary` | Auto-generated line/error count | Lets model decide if more pages are needed |

---

## ⚙️ Recommended Defaults

| Field | Default | Notes |
|--------|----------|--------|
| `limit_bytes` | 65536 | ~8–16k tokens of safe output |
| `limit_lines` | 2000 | Line safety fallback |
| `on_large_output` | "spill" | Always spill rather than truncate |
| `ansi_strip` | true | Remove color codes |
| `newline` | "\n" | Normalize to LF |

---

## 🧩 Example Tool Descriptions (for AGENTS.md / CLAUDE.md)

### shell_exec

> Executes shell commands in a controlled environment.  
> Supports pagination via `limit_bytes` and `next_cursor`.  
> Automatically spills large outputs to file with `spill_uri`.

### read_file_chunk

> Reads paginated data from a spilled file.  
> Accepts `cursor` and `limit_bytes` to safely stream contents.

---

## ✅ Implementation Checklist

- [ ] Add `limit_bytes` / `limit_lines` enforcement  
- [ ] Return `next_cursor` when partial results are returned  
- [ ] Support `spill_uri` to temp directory with file cleanup policy  
- [ ] Add companion `read_file_chunk` tool  
- [ ] Return metadata: `total_bytes`, `truncated`, `mime`, `line_count`  
- [ ] Add brief examples to your project’s `AGENTS.md` or `CLAUDE.md`  

---

## 🧪 Testing Commands

| Scenario | Command | Expected |
|-----------|----------|-----------|
| Small output | `shell_exec echo 'hi'` | returns full stdout |
| Paged | `shell_exec ls -R /usr` | returns first 64KB + `next_cursor` |
| Spill | `shell_exec cat huge.log` | returns `spill_uri` |
| File paging | `read_file_chunk` with `next_cursor` | returns subsequent chunks |

---

## 💡 Tip

Include `--page-size` or similar flags in the `args` array when CLI supports native pagination (AWS CLI, gh, kubectl, etc.). This keeps both model and shell output token-safe.

---

**Author:** Generated by ChatGPT GPT-5  
**Date:** 2025-10-09  
