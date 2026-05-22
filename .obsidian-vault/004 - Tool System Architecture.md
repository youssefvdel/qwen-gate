# Tool System Architecture

The proxy supports function/tool calling — Qwen doesn't natively support this, so it's implemented via **prompt injection + tag parsing**.

## How Tool Calling Works

```
Client ──→ Proxy ──→ Qwen
  │                    │
  │ tools: [...]       │
  │────────────────────►│ Qwen doesn't understand native tool format
  │                    │
  │                    │ Instead: tools are serialized into system prompt
  │                    │ as text: "You have access to: [...]. Output
  │                    │ <tool_call>{"name":"X","arguments":{...}}</tool_call>"
  │                    │
  │                    │ Qwen outputs the tool call as literal text
  │                    │
  │◄───────────────────│ <tool_call>{"name":"read_file","arguments":...}</tool_call>
  │                    │
  │ Parse tag, execute │
  │ tool, get result   │
  │                    │
  │ Send result back   │
  │ as "Tool Response" │
  │────────────────────►│ Qwen sees it as continuation of conversation
```

## Components

### Registry (`tools/registry.ts`)

```typescript
const registry = new ToolRegistry();
registry.register(
  name: string,
  description: string,
  parameters: JsonSchema,
  handler: ToolHandler,
  strict?: boolean
);
```

Features:
- OpenAI-compatible schema export via `toOpenAITools()`
- Schema validation before execution (strict mode: `additionalProperties: false`)
- Singleton instance shared app-wide

### Schema Validator (`tools/schema.ts`)

Hand-written JSON Schema validator (no external dependency). Validates:
- Object properties + required check
- Array items + min/max items
- String minLength, maxLength, pattern, enum
- Number min/max, integer check, enum
- Boolean type check
- `nullable` support
- `additionalProperties` enforcement
- Default values for missing properties

### Streaming Parser (`tools/parser.ts`)

Parses `<tool_call>` tags from a streaming response:

```typescript
class StreamingToolParser {
  feed(chunk: string): ParserResult;
  flush(): ParserResult;
  getEmittedToolCallCount(): number;
  isInsideTool(): boolean;
}
```

Handles:
- Tag-split-across-chunks (streaming friendly)
- Multiple tools in array format: `[{"name":"a"},{"name":"b"}]`
- Malformed JSON via `robustParseJSON`
- `flush()` to extract tool from incomplete stream

### Execution Loop (`tools/executor.ts`)

```typescript
async function runExecutionLoop(
  sendToLLM: LLMSendFunction,
  messages: unknown[],
  model: string,
  config: ExecutionLoopConfig
): Promise<string>
```

Complete agentic loop:
1. Send messages → get LLM response
2. Parse response for tool calls
3. Execute all tools in **parallel** (`Promise.all`)
4. Append tool results to message history
5. Re-send to LLM
6. Repeat until no more tool calls or max turns reached

Max turns: 10 by default. Throws on exceeding.

## Tool Call Format

### Input (what Qwen outputs)
```xml
<tool_call>
{"name": "calculator", "arguments": {"expr": "2+2"}}
</tool_call>
```

### Multiple tools
```xml
<tool_call>
[
  {"name": "read_file", "arguments": {"path": "a.txt"}},
  {"name": "read_file", "arguments": {"path": "b.txt"}}
]
</tool_call>
```

### Output (OpenAI format)
```json
{
  "tool_calls": [{
    "id": "call_uuid",
    "type": "function",
    "function": {
      "name": "calculator",
      "arguments": "{\"expr\": \"2+2\"}"
    }
  }]
}
```

## Key Observations

- **No native tool support** — Qwen doesn't have tool capabilities like GPT-4. The `<tool_call>` tag approach is a pure prompt injection hack.
- **The tool definitions must be in the prompt** — every request includes the full tool schema, making it less efficient for repeated calls.
- **`robustParseJSON` is essential** — Qwen often produces malformed JSON in tool calls (unquoted keys, double keys, truncated braces). The 198-line JSON repair function handles real LLM output pathology.
