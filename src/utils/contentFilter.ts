/*
 * File: contentFilter.ts
 * Strips Qwen's internal <think>/<thinking> tags. Preserves intentional <thought> tags.
 * Separates Qwen's thinking into reasoning_content for OpenAI API compatibility.
 */

/**
 * Result of filtering content for thinking/reasoning patterns.
 */
export interface FilterResult {
  cleanText: string;
  thinking: string;
}

const THINKING_COMBINED_PATTERN = new RegExp(
  '^(' + [
    'Thinking:',
    'I am (?:evaluating|examining|assessing|analyzing|verifying|checking|reviewing|determining|considering|processing|testing|investigating|exploring|inspecting|validating)',
    "I(?:'m| am) (?:going to|about to|trying to|planning to) ",
    '(?:The|Each|This) (?:approach|process|test|evaluation|assessment|analysis|method|strategy) ',
    '(?:Let me|I will|I\'ll) (?:think|consider|analyze|evaluate|assess|review|check|verify|examine|test|try|start|begin|proceed|continue|now) ',
    '(?:First|Next|Then|Finally),? (?:I|we|let) ',
    'OK,? (?:I|let) ',
    '(?:My|The) (?:approach|plan|strategy|goal|intention) (?:is|was) ',
    'To (?:achieve|accomplish|determine|verify|ensure|check|test|evaluate) ',
    'The (?:focus|goal|objective|purpose|aim|intent) (?:is|was) ',
    'I (?:need|want|should|must|have) to ',
    '(?:Based on|Given|According to) (?:the|my|this) (?:analysis|evaluation|assessment|findings) ',
    'After (?:analyzing|evaluating|examining|reviewing|checking|considering) ',
    '(?:It|This) (?:appears|seems|looks|sounds) (?:like|that) ',
    'From (?:the|this|my) (?:analysis|assessment|observation|perspective) ',
    '(?:In|Upon) (?:summary|conclusion|review|analysis|reflection) ',
    'The (?:file|command|output|result|tool|search) (?:contains|returned|shows|found|produced)',
    '(?:Here|Above|Below) (?:is|are) (?:the|what) (?:result|output|content|file|data)',
  ].join('|') + ')',
  'i'
);

function isThinkingLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return THINKING_COMBINED_PATTERN.test(trimmed);
}

const QWEN_THINK_TAG_PATTERN = /<\/?(?:think|thinking|thought|tool_call|tool_use|function_call|tool)(?:\s[^>]{0,100})?\/?>/gi;
const QWEN_THINK_BLOCK_START = /<(?:think(?:ing)?|thought|tool_call|tool_use|function_call|tool)[\s>]/i;

/**
 * Filters content to remove thinking/reasoning text and XML tags.
 * Captures thinking text for use as reasoning_content.
 * 
 * Strategy:
 * 1. First pass: strip all XML tags (<think>, </think>, etc.) and capture content between them as thinking
 * 2. Second pass: line-by-line check for thinking patterns in remaining text
 * 3. Multi-line thinking block detection: if 2+ consecutive lines are thinking, and they form a coherent block, capture all
 */
export function filterContent(raw: string): FilterResult {
  if (!raw) return { cleanText: '', thinking: '' };

  let text = raw;
  const capturedThinking: string[] = [];

  // ── Pass 1: Extract content from XML think blocks ──────────────────
  // Handle <think>content</think> and <thinking>content</thinking>
  while (true) {
    const startMatch = text.match(QWEN_THINK_BLOCK_START);
    if (!startMatch) break;
    
    const startIdx = startMatch.index!;
    const startTagEnd = text.indexOf('>', startIdx) + 1;
    
    // Find matching end tag
    const endTagName = text.substring(startIdx + 1, text.indexOf('>', startIdx));
    const endPattern = new RegExp(`</${endTagName.replace(/[\s>].*/, '')}>`, 'i');
    const endMatch = text.substring(startTagEnd).match(endPattern);
    
    if (endMatch) {
      const endIdx = startTagEnd + endMatch.index!;
      const thinkContent = text.substring(startTagEnd, endIdx);
      if (thinkContent.trim()) {
        capturedThinking.push(thinkContent.trim());
      }
      const before = text.substring(0, startIdx);
      const after = text.substring(endIdx + endMatch[0].length);
      const needsSpace = before.length > 0 && !/[\s\n]$/.test(before) && after.length > 0 && !/^[\s\n]/.test(after);
      text = before + (needsSpace ? ' ' : '') + after;
    } else {
      capturedThinking.push(text.substring(startTagEnd).trim());
      const before = text.substring(0, startIdx);
      text = before + (before.length > 0 && !/[\s\n]$/.test(before) ? ' ' : '');
      break;
    }
  }

  text = text.replace(QWEN_THINK_TAG_PATTERN, ' ');
  text = text.replace(/ {2,}/g, ' ');

  const paragraphs = text.split(/\n\s*\n/);
  const cleanParagraphs: string[] = [];

  for (const para of paragraphs) {
    const paraLines = para.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (paraLines.length === 0) {
      cleanParagraphs.push('');
      continue;
    }

    const thinkingCount = paraLines.filter(l => isThinkingLine(l)).length;
    const startsWithThinking = isThinkingLine(paraLines[0]);
    const isStrongThinkingStart = /^Thinking:/i.test(paraLines[0]) || /^I am (evaluating|examining|assessing|analyzing)/i.test(paraLines[0]);

    // Clear content markers — lines that indicate actual answer content
    const hasContentMarker = paraLines.some(l =>
      /^[#]{1,4}\s/.test(l) ||      // Markdown headings
      /^\$\s/.test(l) ||            // Shell commands
      /^[|+-]{2,}/.test(l) ||       // Table borders
      /^\|.*\|/.test(l) ||          // Table rows
      /^[\[{"]/.test(l) ||          // JSON/array start
      /^[✓✗✔✘✅❌]/.test(l) ||      // Checkboxes
      /^[A-Z][a-z]+ [a-z]+:/.test(l) // "Tool Status:" etc
    );

    if (isStrongThinkingStart && !hasContentMarker) {
      // Paragraph starts with strong thinking → whole paragraph is thinking
      capturedThinking.push(paraLines.join('\n'));
    } else if (thinkingCount >= 2 && !hasContentMarker) {
      // Multiple thinking lines → whole paragraph is thinking
      capturedThinking.push(paraLines.join('\n'));
    } else if (startsWithThinking && thinkingCount === 1 && paraLines.length === 1) {
      // Single thinking line as its own paragraph — could be a heading, keep as content
      cleanParagraphs.push(para);
    } else {
      cleanParagraphs.push(para);
    }
  }

  text = cleanParagraphs.join('\n\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  // ── Pass 3: Strip any remaining tool call JSON and Tool Response echoes ──
  text = stripToolCallArtifacts(text);

  return {
    cleanText: text,
    thinking: capturedThinking.filter(t => t.length > 0).join('\n'),
  };
}

/**
 * Strips raw JSON tool call artifacts from text — catches any tool call JSON that
 * the StreamingToolParser missed or that leaked through in the non-streaming path.
 * Also removes "Tool Response (name): ..." echoes that the model may reproduce
 * from the message history, preventing context window bloat on the client side.
 */
export function stripToolCallArtifacts(text: string): string {
  if (!text) return '';

  // ── Pass 1: Strip raw JSON tool calls: {"name":"...","arguments":{...}} ─
  let result = '';
  let remaining = text;

  while (remaining.length > 0) {
    // Find potential tool call start: {"name" or {"function"
    const toolCallStart = remaining.search(/\{\s*"(?:name|function)"\s*:/);
    if (toolCallStart === -1) {
      result += remaining;
      break;
    }

    // Emit text before the potential tool call
    result += remaining.substring(0, toolCallStart);

    // Find the opening brace for scanning
    const braceIdx = remaining.indexOf('{', toolCallStart);
    if (braceIdx === -1) {
      result += remaining.substring(toolCallStart);
      break;
    }

    // Scan for balanced closing brace
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let endIdx = braceIdx;

    for (; endIdx < remaining.length; endIdx++) {
      const c = remaining[endIdx];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          endIdx++; // include the closing brace
          break;
        }
      }
    }

    if (depth !== 0) {
      // Unbalanced — emit everything and stop
      result += remaining.substring(braceIdx);
      break;
    }

    const jsonStr = remaining.substring(braceIdx, endIdx);

    // Quick check: does it look like a tool call?
    // Strip any JSON with a "name" field — even partial/malformed ones without "arguments".
    // This prevents tool-call JSON fragments from echoing back into the context window.
    const hasNameField = /"name"\s*:\s*"[^"]*"/.test(jsonStr);
    const hasArgsField = /\barguments\s*:/.test(jsonStr);
    if (hasNameField) {
      try {
        const parsed = JSON.parse(jsonStr);
        const name = parsed.name || parsed.function?.name;
        if (name && typeof name === 'string') {
          // Skip tool call + trailing whitespace/newline
          const after = remaining.substring(endIdx);
          const trailing = after.match(/^[\s\n]*/);
          const skipLen = trailing ? trailing[0].length : 0;
          remaining = after.substring(skipLen);
          continue;
        }
      } catch {
        // Malformed JSON but it LOOKS like a tool call (has "name":"...")
        // Strip it anyway to prevent context bloat from garbled tool call output.
        const after = remaining.substring(endIdx);
        const trailing = after.match(/^[\s\n]*/);
        const skipLen = trailing ? trailing[0].length : 0;
        remaining = after.substring(skipLen);
        continue;
      }
    }
    // Also strip JSON with arguments field even without name (incomplete tool calls)
    if (hasArgsField && jsonStr.includes('"function"')) {
      const after = remaining.substring(endIdx);
      const trailing = after.match(/^[\s\n]*/);
      const skipLen = trailing ? trailing[0].length : 0;
      remaining = after.substring(skipLen);
      continue;
    }

    // Not a tool call after all — emit the opening brace and continue
    result += '{';
    remaining = remaining.substring(braceIdx + 1);
  }

  text = result;

  // ── Pass 2: Strip "Tool Response (name): ..." echoes ────────────────
  // Model may echo back the tool result that was in the prompt.
  // These lines start with "Tool Response (toolName):" and contain the
  // tool result from the message history, which the client already has.
  // The continuation captures multi-line content until:
  // - a blank line (paragraph break)
  // - another "Tool Response" starting
  // - a tool call JSON `{"name...` starting
  // - end of text
  text = text.replace(/Tool Response \([^)]+\):[^\n]*(?:\n(?!\s*(?:\n|$)|Tool Response\s*\(|{"name)[^\n]*)*/g, '');

  // ── Pass 3: Strip trailing dangling tool call tails like `}]}}}` ──
  // These can appear when a tool call array gets partially rendered.
  text = text.replace(/^[\s]*[\]\}]+[\}\]\}]*\s*$/gm, '');

  // ── Pass 4: Strip any remaining XML-like tool wrapper tags ─────────
  // Safety net: if the model ever outputs ,>,
  // <tool_call>, or similar XML wrappers despite instructions, strip them
  // completely (including content between matching tags).
  const XML_TOOL_PATTERNS = [
    /<function_calls>[\s\S]*?<\/function_calls>/gi,
    /<tool_call>[\s\S]*?<\/tool_call>/gi,
    /<tool_use>[\s\S]*?<\/tool_use>/gi,
    /<tools?>[\s\S]*?<\/tools?>/gi,
    /<\/?(?:function_calls?|tool_call|tool_use|tools?)\s*>/gi,
  ];
  for (const pattern of XML_TOOL_PATTERNS) {
    text = text.replace(pattern, '');
  }

  // Clean up excess blank lines left by removals
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

/**
 * Lightweight version — only strips XML tags without line-level thinking detection.
 * Used as a fast pre-filter for content that doesn't need thinking separation.
 */
export function stripXmlTags(raw: string): string {
  if (!raw) return '';
  let text = raw;
  
  // Remove <think>content</think> blocks
  while (true) {
    const startMatch = text.match(QWEN_THINK_BLOCK_START);
    if (!startMatch) break;
    
    const startIdx = startMatch.index!;
    const startTagEnd = text.indexOf('>', startIdx) + 1;
    const endTagName = text.substring(startIdx + 1, text.indexOf('>', startIdx));
    const endPattern = new RegExp(`</${endTagName.replace(/[\s>].*/, '')}>`, 'i');
    const endMatch = text.substring(startTagEnd).match(endPattern);
    
    if (endMatch) {
      const endIdx = startTagEnd + endMatch.index!;
      const before = text.substring(0, startIdx);
      const after = text.substring(endIdx + endMatch[0].length);
      const needsSpace = before.length > 0 && !/[\s\n]$/.test(before) && after.length > 0 && !/^[\s\n]/.test(after);
      text = before + (needsSpace ? ' ' : '') + after;
    } else {
      const before = text.substring(0, startIdx);
      text = before + (before.length > 0 && !/[\s\n]$/.test(before) ? ' ' : '');
      break;
    }
  }
  
  text = text.replace(QWEN_THINK_TAG_PATTERN, ' ');
  text = text.replace(/ {2,}/g, ' ');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
