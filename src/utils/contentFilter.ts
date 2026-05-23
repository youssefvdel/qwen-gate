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
    '[A-Z][a-z]+ing:',
    '(?:Step|Phase|Stage) \\d',
  ].join('|') + ')',
  'i'
);

function isThinkingLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return THINKING_COMBINED_PATTERN.test(trimmed);
}

const QWEN_THINK_TAG_PATTERN = /<\/?(?:think|thinking|thought|tool_call|tool_use|function_call)(?:\s[^>]{0,100})?\/?>/gi;
const QWEN_THINK_BLOCK_START = /<(?:think(?:ing)?|thought|tool_call|tool_use|function_call)[\s>]/i;

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

  return {
    cleanText: text,
    thinking: capturedThinking.filter(t => t.length > 0).join('\n'),
  };
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
