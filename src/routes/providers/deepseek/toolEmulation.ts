/**
 * Tool-call emulation for the DeepSeek web chat backend.
 *
 * chat.deepseek.com's /api/v0/chat/completion is prompt-based and has NO
 * native function-calling engine (verified live: a `tools` field in the body
 * is accepted but silently ignored — the model answers in plain text). To make
 * deepseek usable with OpenAI-style tool-calling clients (Hermes, etc.) we
 * emulate:
 *
 *   1. Inject the tool schemas into the prompt with a strict output contract.
 *   2. Parse the model's text output for JSON tool-call object(s).
 *   3. Synthesize a structured `tool_calls` message + finish_reason "tool_calls".
 *
 * Supports PARALLEL tool calls: the output contract asks for a JSON array,
 * and parseToolCalls() returns every call the model emitted in one turn
 * (Hermes agent issues multiple tool_calls simultaneously). Multi-turn tool
 * history (assistant tool_calls + role:tool results) is serialized by
 * pipeline.messagesToPrompt so agentic loops keep the full context.
 *
 * IMPORTANT: buildToolSystemPrompt() output is APPENDED at the END of the
 * prompt (after the conversation), never prepended. DeepSeek web models have a
 * huge system prompt from agents like Hermes (20K+ tokens); a contract buried
 * at position 0 is ignored and the model answers in plain text. Placing the
 * contract last maximizes recency bias: the model generates immediately after
 * reading it, so it follows the JSON array format far more reliably.
 *
 * This is heuristic: deepseek follows the JSON contract reliably, but if the
 * output cannot be parsed we fall back to plain text (no tool call).
 */

/** Render one OpenAI tools[] entry into a single prompt line. */
function describeTool(tool: any): string {
  const fn = tool?.function ?? tool;
  const name = fn?.name || 'unnamed';
  const description = fn?.description || '';
  const params = fn?.parameters ? JSON.stringify(fn.parameters) : '{}';
  return `- ${name}: ${description} (parameters JSON schema: ${params})`;
}

/**
 * Detect whether the declared tools include a web-search tool. When present,
 * the pipeline enables DeepSeek's native web search (search_enabled: true) —
 * this is how chat.deepseek.com models "search the web" in the web UI.
 */
export function hasWebSearchTool(tools: any[]): boolean {
  return (tools || []).some((t) => {
    const fn = t?.function ?? t;
    const name = (fn?.name || '').toLowerCase().replace(/-/g, '_');
    return name === 'web_search' || name === 'search' || name === 'websearch' || name.endsWith('_web_search');
  });
}

/**
 * Build the tool-call instruction block. Designed to be APPENDED at the very
 * END of the prompt so the model generates immediately after reading it.
 *
 * The contract asks for a JSON ARRAY (parallel calls supported). It is written
 * for agentic coding workflows (Hermes-style): when a task requires reading,
 * writing, searching, or running commands, the model MUST emit a tool call
 * instead of describing what it would do.
 *
 * Returns '' when there is nothing to inject.
 */
export function buildToolSystemPrompt(tools: any[], toolChoice?: any): string {
  if (!tools || tools.length === 0) return '';

  const lines = tools.map(describeTool);
  const contract = [
    'Available functions:',
    ...lines,
    '',
    'OUTPUT FORMAT — STRICT:',
    'You are an autonomous coding agent operating through function calls. When the task requires reading, writing, searching, listing, editing, executing, or fetching anything, you MUST emit a function call — never describe what you would do.',
    '',
    'Your entire response must be EXACTLY ONE of:',
    '  (A) a JSON array of tool-call objects — when you want to call one or more functions, or',
    '  (B) plain text — only when no function is needed and you are answering directly.',
    '',
    'Each tool-call object has exactly this shape:',
    '{"function": "name_of_function", "arguments": {"param1": "value1", "param2": "value2"}}',
    '',
    'Examples of valid responses:',
    '[{"function": "read_file", "arguments": {"path": "package.json"}}, {"function": "search_files", "arguments": {"pattern": "export const"}}]',
    '[{"function": "terminal", "arguments": {"command": "bun test"}}]',
    '',
    'Rules:',
    '- Respond with ONLY the JSON array — no markdown, no code fences, no commentary, no explanations before or after.',
    '- The array must be valid JSON. Each element MUST have a "function" (string name) and an "arguments" object.',
    '- When several independent operations are needed, put ALL of them in one array (parallel calls).',
    '- The "arguments" values must match the function\'s parameter schema exactly.',
    '- Never invent a function name that is not in the Available functions list above.',
  ];

  if (toolChoice === 'required') {
    contract.splice(contract.length - 4, 0, '- You MUST call one or more functions in every response. Never answer in plain text.');
  } else if (typeof toolChoice === 'object' && toolChoice?.function?.name) {
    contract.splice(
      contract.length - 4,
      0,
      `- You MUST call the function "${toolChoice.function.name}" with appropriate arguments in every response.`,
    );
  }

  return '\n<system>TOOL CALLING PROTOCOL (read carefully — you must follow this exactly)\n' + contract.join('\n') + '</system>\n';
}

/** Find every balanced JSON object in a string, in order (skips fences/prose). */
function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let idx = 0;
  while (idx < text.length) {
    const start = text.indexOf('{', idx);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    out.push(text.slice(start, end + 1));
    idx = end + 1;
  }
  return out;
}

/**
 * Normalize one parsed JSON object into a tool call. Accepts {function,
 * arguments}, {function: {name, arguments}} (object-form name), {name,
 * arguments}, {tool, parameters}, {function_name, params}, or the natural
 * deepseek shape {"tool": "...", "parameters": {...}}. Returns null when no
 * usable call (missing name, etc.).
 */
function normalizeCall(obj: any): { name: string; argsJson: string } | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  let name = obj.function ?? obj.name ?? obj.tool ?? obj.function_name;
  let rawArgs = obj.arguments ?? obj.parameters ?? obj.params ?? obj.args;
  // Some models emit {"function": {"name": "x", "arguments": {...}}} where
  // `function` is an object rather than the contract's name string.
  if (typeof name === 'object' && name !== null) {
    rawArgs = rawArgs ?? name.arguments;
    name = name.name;
  }
  if (typeof name !== 'string' || !name.trim()) return null;
  let argsJson: string;
  if (typeof rawArgs === 'string') argsJson = rawArgs;
  else if (rawArgs && typeof rawArgs === 'object') argsJson = JSON.stringify(rawArgs);
  else argsJson = '{}';
  return { name: name.trim(), argsJson };
}

/**
 * Parse the model's text output into zero or more emulated tool calls.
 * Handles: a JSON array of calls (parallel), a single call object, prose
 * wrapped around JSON, and ```json fences. Returns [] for plain-text answers.
 */
export function parseToolCalls(text: string): Array<{ name: string; argsJson: string }> {
  if (!text || !text.trim()) return [];
  let cleaned = text.trim();
  // Strip ```json ... ``` fences (the model loves wrapping JSON in them)
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();

  // Fast path: the whole text is JSON (array of calls, or a single call).
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeCall).filter((c): c is { name: string; argsJson: string } => c !== null);
    }
    const single = normalizeCall(parsed);
    return single ? [single] : [];
  } catch {
    /* not clean JSON — fall through to scanner */
  }

  // Slow path: scan for balanced objects (prose around JSON, multiple calls).
  const results: Array<{ name: string; argsJson: string }> = [];
  for (const slice of extractJsonObjects(cleaned)) {
    try {
      const call = normalizeCall(JSON.parse(slice));
      if (call) results.push(call);
    } catch {
      /* malformed object — skip */
    }
  }
  return results;
}

/**
 * Build the OpenAI tool_calls entry (id stable across message + stream delta).
 * Streaming deltas require a per-call `index` (0, 1, 2... for parallel calls);
 * a completed message's tool_calls array does not (pass forMessage=true to
 * omit it).
 */
export function makeToolCallEntry(call: { name: string; argsJson: string }, id: string, forMessage = false, index = 0): any {
  const entry: any = {
    index,
    id,
    type: 'function',
    function: { name: call.name, arguments: call.argsJson },
  };
  if (forMessage) delete entry.index;
  return entry;
}
