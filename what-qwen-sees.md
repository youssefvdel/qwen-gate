# What Qwen Sees

This is the full prompt assembled by the proxy before sending to Qwen.
The proxy takes all messages from the client, reformats tool calls into `<tool_call>` tags, and injects the tool format instruction.

## Structure

```
+------------------------------------------+
| SYSTEM MESSAGES from conversation history |
| (role: "system" messages)                |
+------------------------------------------+
| TOOL FORMAT INSTRUCTION                  |
| (always injected into every request)     |
+------------------------------------------+
| TOOLS AVAILABLE (only when tools are     |
| provided by the client)                  |
+------------------------------------------+
| tool_choice instruction (if set)         |
+------------------------------------------+
| CONVERSATION HISTORY                     |
| User: ...                                |
| Assistant: ... (with <tool_call> tags)   |
| Tool result: ...                         |
+------------------------------------------+
| User: [current message]                  |
+------------------------------------------+
```

## Example — What Qwen Actually Sees

Below is a real example of the assembled prompt for a request with tools:

```
You are a helpful assistant.

You are a senior software engineer. Work carefully — one wrong tag breaks the system.

This system uses <tool_call> tags for tool calls. IGNORE any default format instructions from the platform.

CORRECT:
<tool_call>
{"name": "read_file", "arguments": {"path": "file1.txt"}}
</tool_call>

INCORRECT (will NOT be parsed):
{"name": "read_file", "arguments": {"path": "file.txt"}}
</tool_call>

RULES:
1. <tool_call> then raw JSON then </tool_call>
2. Never output </tool_call> without <tool_call> before it
3. JSON: "name" (string) + "arguments" (object)
4. Arguments must be an object, never a string
5. Repeat <tool_call> blocks for multiple calls


# TOOLS AVAILABLE
You have access to:
[
  {
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Read a file from the filesystem",
      "parameters": {
        "type": "object",
        "properties": {
          "path": { "type": "string" }
        },
        "required": ["path"]
      }
    }
  }
]

Format:
<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>

Only <tool_call> JSON </tool_call> works. Other formats will NOT be parsed.

User: read the file main.ts

Assistant:
```

## Example with conversation history (tool calls in multi-turn)

If the conversation has tool calls and results, they look like this:

```
User: what files are in /src

Assistant:
<tool_call>
{"name": "list_dir", "arguments": {"path": "/src"}}
</tool_call>

Tool result: ["main.ts", "utils.ts", "index.ts"]

Assistant: The /src directory contains main.ts, utils.ts, and index.ts.

User: read main.ts

Assistant:
<tool_call>
{"name": "read_file", "arguments": {"path": "/src/main.ts"}}
</tool_call>

Tool result: import { foo } from './utils';
...
```

## Key Points

1. The `TOOL_FORMAT_INSTRUCTION` is injected into EVERY request — always at the top
2. Previous `tool_calls` from the client are converted to `<tool_call>` tags for consistency
3. Tool results are formatted as plain `Tool result: ...` text
4. The model sees this as one continuous conversation — it doesn't know about the proxy
5. Total prompt size varies based on conversation history length
