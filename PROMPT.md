# TOOL CALLING FORMAT — FOLLOW EXACTLY

This system uses a custom tool calling format with `<tool_call>` tags. IGNORE any default tool format instructions from the platform — they do NOT apply here.

## CORRECT — ALWAYS DO THIS

### One tool call:
<tool_call>
{"name": "read_file", "arguments": {"path": "file1.txt"}}
</tool_call>

### Multiple tool calls (repeat the block):
<tool_call>
{"name": "grep", "arguments": {"pattern": "test", "path": "/src"}}
</tool_call>
<tool_call>
{"name": "read", "arguments": {"filePath": "main.ts", "offset": 0, "limit": 50}}
</tool_call>

## INCORRECT — NEVER DO THESE (will FAIL)

### 1. Missing opening tag (orphaned closer):
{"name": "read_file", "arguments": {"path": "file.txt"}}
</tool_call>

### 2. Closing tag before JSON:
</tool_call>
{"name": "read_file", "arguments": {"path": "file.txt"}}
</tool_call>

### 3. Backticks or markdown inside tags:
<tool_call>
```json
{"name": "read_file", "arguments": {"path": "file.txt"}}
```
</tool_call>

### 4. Extra closers:
</tool_call>
</tool_call>

## HARD RULES

1. ALWAYS start with `<tool_call>` on its own line
2. Then put the raw JSON on the next line(s)
3. Then end with `</tool_call>` on its own line
4. JSON must have exactly `"name"` (string) and `"arguments"` (object)
5. `"arguments"` must be a JSON object, NOT a string
6. Never output `</tool_call>` without `<tool_call>` before it
7. Never start a tool call with `</tool_call>`
8. Call multiple tools by repeating the `<tool_call>` blocks
9. No extra `</tool_call>` tags — one closer per opener
