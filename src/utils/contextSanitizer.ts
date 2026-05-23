/*
 * File: contextSanitizer.ts
 * Inspired by Luna-Proxy's overflowSanitizer.
 * Cleans noisy messages from agentic conversation contexts.
 */

export interface Message {
  role: string;
  content: any;
}

export interface SanitizedContextResult {
  cleanedMessages: Message[];
  ignoredReasons: { messageIndex: number; reason: string }[];
  activeTaskHint?: string;
}

const THINKING_PATTERN = /<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi;
const CLIENT_TOOL_SIGNATURES = [
  '## execute_command', '## read_file', '## write_to_file', '## replace_in_file',
  '## attempt_completion', '## plan_mode_respond', '## ask_followup_question',
  'execute_command', 'read_file', 'write_to_file', 'replace_in_file',
  'attempt_completion', 'plan_mode_respond', 'ask_followup_question',
  'Tool Use Guidelines',
];

const AUTOMATED_ERROR_PATTERNS = [
  /^\[ERROR]\s+You did not use a tool/i,
  /^\[ERROR]\s+You did not use a tool in your previous response/i,
  /# task_progress\s+RECOMMENDED/i,
  /^(Checkpoint|Compare|Restore)$/i,
  /^Tool \w+ does not (?:exist|exists)/i,
  /^The user denied this operation/i,
  /^Something went wrong/i,
];

const CONTAINER_CONFUSION_PATTERNS = [
  /overflow context/i,
  /sanitized overflow/i,
  /this file is .*overflow/i,
  /not a software project/i,
  /đây không phải là mã nguồn/i,
  /ngữ cảnh tràn bộ đệm/i,
  /không thể xác định.*project/i,
  /file chỉ chứa thông tin siêu dữ liệu/i,
  /ngữ cảnh tràn bộ nhớ/i,
  /không chứa mã nguồn/i,
  /không chứa.*cấu trúc thư mục/i,
];

const FAILURE_ECHO_PATTERNS = [
  /Tool \w+ does not (?:exist|exists)/i,
  /Something went wrong/i,
  /The user denied this operation/i,
  /^Tool \w+ is not (?:accessible|available)/i,
];

export function stripThinkingBlocks(text: string): string {
  return text.replace(THINKING_PATTERN, '').trim();
}

export function isAutomatedError(text: string): boolean {
  return AUTOMATED_ERROR_PATTERNS.some(p => p.test(text.trim()));
}

export function isContainerConfusion(text: string): boolean {
  return CONTAINER_CONFUSION_PATTERNS.some(p => p.test(text));
}

export function isAssistantFailureEcho(text: string): boolean {
  return FAILURE_ECHO_PATTERNS.some(p => p.test(text));
}

export function isRetryReminder(text: string): boolean {
  return /You did not use a tool in your previous response/i.test(text) ||
    /please retry with a tool use/i.test(text);
}

export function isToolResultLike(text: string): boolean {
  const cleaned = text.trim();
  return (
    /^\[[\w_]+\s*(?:for\s+['"][^'"]+['"])?\s*\]\s*Result:/i.test(cleaned) ||
    /^##\s+\w+[\s\S]*?Result:/i.test(cleaned.slice(0, 200)) ||
    /^Tool\s+\w+\s+(?:completed|finished|succeeded)/i.test(cleaned) ||
    /^Here['']s the (?:content|result) of/i.test(cleaned)
  );
}

export function extractMessageText(msg: Message): string {
  const content = msg?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => typeof p === 'string' ? p : p?.text || '').join('\n');
  }
  if (content && typeof content === 'object') {
    return typeof content.text === 'string' ? content.text : typeof content.content === 'string' ? content.content : JSON.stringify(content);
  }
  return String(content ?? '');
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(THINKING_PATTERN, '')
    .replace(/<task>[\s\S]*?<\/task>/gi, '')
    .replace(/<\/?[a-zA-Z_][\w]*>/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !/^\d+$/.test(t));
}

export function messageSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

export function sanitizeConversation(
  messages: Message[],
  options?: {
    maxAssistantMessages?: number;
    dedupeSimilarity?: number;
    stripClientProtocol?: boolean;
    stripAssistantThinking?: boolean;
    stripContainerConfusion?: boolean;
    stripFailureEcho?: boolean;
    maxUserMessages?: number;
  }
): SanitizedContextResult {
  const opts = {
    maxAssistantMessages: options?.maxAssistantMessages ?? 10,
    dedupeSimilarity: options?.dedupeSimilarity ?? 0.85,
    stripClientProtocol: options?.stripClientProtocol ?? true,
    stripAssistantThinking: options?.stripAssistantThinking ?? false,
    stripContainerConfusion: options?.stripContainerConfusion ?? true,
    stripFailureEcho: options?.stripFailureEcho ?? true,
    maxUserMessages: options?.maxUserMessages ?? 50,
  };

  const cleaned: Message[] = [];
  const ignored: { messageIndex: number; reason: string }[] = [];
  const recentAssistant: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const text = extractMessageText(msg);
    const cleanedText = opts.stripAssistantThinking ? stripThinkingBlocks(text) : text;

    if (msg.role === 'system') {
      if (opts.stripClientProtocol) {
        const sigCount = CLIENT_TOOL_SIGNATURES.filter(s => text.includes(s)).length;
        if (sigCount >= 3) {
          ignored.push({ messageIndex: i, reason: 'system prompt with heavy client tool protocol' });
          continue;
        }
      }
      cleaned.push(msg);
      continue;
    }

    if (msg.role === 'user') {
      if (!text.trim()) {
        ignored.push({ messageIndex: i, reason: 'empty user message' });
        continue;
      }
      if (isAutomatedError(text)) {
        ignored.push({ messageIndex: i, reason: 'automated client error/reminder' });
        continue;
      }
      if (cleaned.length >= opts.maxUserMessages) {
        ignored.push({ messageIndex: i, reason: `exceeds max user messages (${opts.maxUserMessages})` });
        continue;
      }
      cleaned.push(msg);
      continue;
    }

    if (msg.role === 'tool') {
      const toolText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (toolText.length > 50000) {
        cleaned.push({ ...msg, content: toolText.slice(0, 50000) + '\n[truncated]' });
      } else {
        cleaned.push(msg);
      }
      continue;
    }

    if (msg.role === 'assistant') {
      if (!text.trim()) {
        ignored.push({ messageIndex: i, reason: 'empty assistant message' });
        continue;
      }

      if (opts.stripFailureEcho && isAssistantFailureEcho(cleanedText)) {
        ignored.push({ messageIndex: i, reason: 'assistant tool failure echo' });
        continue;
      }

      if (opts.stripContainerConfusion && isContainerConfusion(cleanedText)) {
        ignored.push({ messageIndex: i, reason: 'assistant overflow container confusion' });
        continue;
      }

      if (/^(Checkpoint|Compare|Restore)$/i.test(cleanedText)) {
        ignored.push({ messageIndex: i, reason: 'UI control artifact' });
        continue;
      }

      const recentClean = recentAssistant[recentAssistant.length - 1] || '';
      if (opts.dedupeSimilarity > 0 && recentClean) {
        const sim = messageSimilarity(cleanedText, recentClean);
        if (sim >= opts.dedupeSimilarity) {
          ignored.push({ messageIndex: i, reason: `duplicate assistant message (similarity=${(sim * 100).toFixed(0)}%)` });
          continue;
        }
      }

      recentAssistant.push(cleanedText);
      if (recentAssistant.length > opts.maxAssistantMessages) {
        ignored.push({ messageIndex: i, reason: `exceeds max assistant messages (${opts.maxAssistantMessages})` });
        continue;
      }

      cleaned.push(msg);
      continue;
    }

    cleaned.push(msg);
  }

  let activeTaskHint: string | undefined;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const msg = cleaned[i];
    if (msg.role === 'user') {
      const text = extractMessageText(msg);
      const taskMatch = text.match(/<task>([\s\S]*?)<\/task>/i);
      if (taskMatch) { activeTaskHint = taskMatch[1].trim(); break; }
      const feedbackMatch = text.match(/<feedback>([\s\S]*?)<\/feedback>/i);
      if (feedbackMatch) { activeTaskHint = feedbackMatch[1].trim(); break; }
    }
  }

  return { cleanedMessages: cleaned, ignoredReasons: ignored, activeTaskHint };
}