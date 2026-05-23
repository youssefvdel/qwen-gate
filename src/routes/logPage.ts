/*
 * File: logPage.ts
 * HTML template for the /log dashboard — auto-updates via SSE
 */

export const logHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate Log</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { font-size: 1.5rem; margin-bottom: 20px; color: #58a6ff; display: flex; align-items: center; gap: 12px; }
  h1 small { font-size: 0.8rem; color: #8b949e; font-weight: normal; }
  .stats { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 16px; font-size: 0.85rem; }
  .stat span { color: #8b949e; }
  .stat strong { color: #f0f6fc; }

  .entry { background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
  .entry-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: #1c2128; border-bottom: 1px solid #30363d; cursor: pointer; }
  .entry-header:hover { background: #21262d; }
  .entry-header .model { font-weight: 600; color: #58a6ff; }
  .entry-header .time { font-size: 0.8rem; color: #8b949e; }
  .entry-header .badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
  .badge-tools { background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb66; }
  .badge-stream { background: #23863633; color: #3fb950; border: 1px solid #23863666; }
  .badge-errors { background: #da363333; color: #f85149; border: 1px solid #da363366; }

  .entry-body { padding: 12px 16px; display: none; }
  .entry.open .entry-body { display: block; }

  .section { margin-bottom: 12px; }
  .section-title { font-size: 0.8rem; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .section-content { font-size: 0.85rem; line-height: 1.5; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 0.85rem; }
  .kv dt { color: #8b949e; }
  .kv dd { color: #f0f6fc; }

  pre { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 8px; font-size: 0.8rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; }
  .chunk { background: #0d1117; border-left: 3px solid #d29922; margin: 4px 0; padding: 6px 8px; font-size: 0.8rem; font-family: monospace; white-space: pre-wrap; word-break: break-all; }
  .chunk.tool-call { border-left-color: #58a6ff; }
  .chunk.error { border-left-color: #f85149; }

  .tool-call-item { background: #1c2128; border: 1px solid #30363d; border-radius: 4px; padding: 6px 10px; margin: 4px 0; font-size: 0.85rem; }
  .tool-call-item .name { color: #58a6ff; font-weight: 600; }
  .tool-call-item .args { color: #f0f6fc; font-family: monospace; font-size: 0.8rem; }

  .error-item { color: #f85149; padding: 4px 0; font-size: 0.85rem; }
  .finish-tool_calls { color: #3fb950; }
  .finish-stop { color: #8b949e; }

  .empty { color: #484f58; font-style: italic; font-size: 0.85rem; }

  .truncated { color: #d29922; font-size: 0.75rem; }
  .side-by-side { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 800px) { .side-by-side { grid-template-columns: 1fr; } }
  .raw-output { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 8px; font-size: 0.8rem; font-family: monospace; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; }
  .proc-output { background: #0d1117; border: 1px solid #23863666; border-radius: 4px; padding: 8px; font-size: 0.8rem; font-family: monospace; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; }
  .raw-label { background: #d2992233; color: #d29922; font-size: 0.7rem; padding: 2px 8px; border-radius: 4px; display: inline-block; margin-bottom: 4px; }
  .proc-label { background: #23863633; color: #3fb950; font-size: 0.7rem; padding: 2px 8px; border-radius: 4px; display: inline-block; margin-bottom: 4px; }

  .highlight { background: #d2992233; border: 1px solid #d2992266; border-radius: 4px; padding: 8px; margin: 6px 0; }
  .highlight-tool { background: #1f6feb33; border: 1px solid #1f6feb66; }
  .highlight-err { background: #da363333; border: 1px solid #da363366; }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  .entry-new { animation: fadeIn 0.3s ease-out; }
</style>
</head>
<body>
<h1>
  Qwen Gate Log
  <small>auto-refresh · last 50 entries</small>
</h1>
<div class="stats" id="stats">
  <div class="stat"><span>entries:</span> <strong id="count">0</strong></div>
  <div class="stat"><span>tool calls:</span> <strong id="toolCount">0</strong></div>
  <div class="stat"><span>errors:</span> <strong id="errorCount">0</strong></div>
</div>
<div id="entries"></div>

<script>
const entriesEl = document.getElementById('entries');
const countEl = document.getElementById('count');
const toolCountEl = document.getElementById('toolCount');
const errorCountEl = document.getElementById('errorCount');
let totalToolCalls = 0;
let totalErrors = 0;
let entryCount = 0;

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderEntry(entry, isNew) {
  const hasTools = entry.parsedToolCalls && entry.parsedToolCalls.length > 0;
  const hasErrors = entry.errors && entry.errors.length > 0;
  const hasChunks = entry.qwenRawChunks && entry.qwenRawChunks.length > 0;

  let html = '<div class="entry' + (isNew ? ' entry-new' : '') + '" data-id="' + entry.id + '">';
  
  // Header — click handler via JS listener, not inline onclick (avoids quote escaping issues)
  html += '<div class="entry-header" data-toggle="open">';
  html += '<div><span class="model">' + escapeHtml(entry.model) + '</span>';
  if (hasTools) html += '<span class="badge badge-tools">' + entry.parsedToolCalls.length + ' tool' + (entry.parsedToolCalls.length > 1 ? 's' : '') + '</span>';
  if (hasErrors) html += '<span class="badge badge-errors">' + entry.errors.length + ' error' + (entry.errors.length > 1 ? 's' : '') + '</span>';
  if (entry.stream) html += '<span class="badge badge-stream">stream</span>';
  html += '</div>';
  html += '<span class="time">' + escapeHtml(entry.timestamp ? entry.timestamp.slice(11, 19) : '') + '</span>';
  html += '</div>';

  // Body
  html += '<div class="entry-body">';

  // Client Request
  html += '<div class="section"><div class="section-title">Client → Proxy</div>';
  html += '<div class="kv">';
  html += '<dt>messages</dt><dd>' + entry.clientRequest.messageCount + ' (' + (entry.clientRequest.roles || []).join(', ') + ')</dd>';
  html += '<dt>tools</dt><dd>' + (entry.clientRequest.hasTools ? (entry.clientRequest.toolNames || []).join(', ') : 'none') + '</dd>';
  html += '<dt>tool_choice</dt><dd>' + (entry.clientRequest.tool_choice || 'auto') + '</dd>';
  html += '<dt>last msg</dt><dd>' + escapeHtml(entry.clientRequest.lastMessage || '') + '</dd>';
  html += '</div></div>';

  // Prompt to Qwen
  if (entry.promptToQwen) {
    html += '<div class="section"><div class="section-title">Proxy → Qwen (prompt, ' + entry.promptToQwen.totalLength + ' chars)</div>';
    html += '<pre>' + escapeHtml(entry.promptToQwen.preview) + '</pre>';
    html += '</div>';
  }

  // Side-by-side: raw Qwen output vs processed output  
  if (entry.rawFullContent || hasChunks) {
    html += '<div class="section"><div class="section-title">Qwen Output: RAW (left) vs PROCESSED (right)</div>';
    html += '<div class="side-by-side">';
    
    // Left: raw output
    const rawContent = entry.rawFullContent || (entry.qwenRawChunks || []).join('');
    html += '<div><div class="raw-label">RAW — before filtering</div><div class="raw-output">';
    html += escapeHtml(rawContent.length > 2000 ? rawContent.slice(0, 2000) + '\\n... [truncated]' : rawContent);
    html += '</div></div>';
    
    // Right: processed output (tool calls + remaining text)
    html += '<div><div class="proc-label">PROCESSED — after parsing</div><div class="proc-output">';
    if (entry.parsedToolCalls && entry.parsedToolCalls.length > 0) {
      for (const tc of entry.parsedToolCalls) {
        html += '<span style="color:#58a6ff;font-weight:600;">→ Tool call:</span> ' + escapeHtml(tc.name) + '(' + escapeHtml(tc.args ? tc.args.slice(0, 300) : '') + ')\\n';
      }
    }
    if (entry.remainingText) {
      html += escapeHtml(entry.remainingText.slice(0, 1000));
    }
    if ((!entry.parsedToolCalls || entry.parsedToolCalls.length === 0) && !entry.remainingText) {
      html += '<span class="empty">(no tool calls or remaining content captured)</span>';
    }
    html += '</div></div>';
    
    html += '</div></div>';
  }

  // Parsed tool calls
  if (hasTools) {
    html += '<div class="section"><div class="section-title">Parsed Tool Calls</div>';
    for (const tc of entry.parsedToolCalls) {
      html += '<div class="tool-call-item"><span class="name">' + escapeHtml(tc.name) + '</span>(' + escapeHtml(tc.args ? tc.args.slice(0, 200) : '') + ')</div>';
    }
    html += '</div>';
  }

  // Remaining text
  if (entry.remainingText) {
    html += '<div class="section"><div class="section-title">Remaining Text</div>';
    html += '<pre>' + escapeHtml(entry.remainingText.slice(0, 500)) + '</pre>';
    html += '</div>';
  }

  // Final response
  if (entry.finalResponse) {
    html += '<div class="section"><div class="section-title">Proxy → Client</div>';
    html += '<div class="kv">';
    html += '<dt>finish_reason</dt><dd class="finish-' + entry.finalResponse.finishReason + '">' + entry.finalResponse.finishReason + '</dd>';
    html += '<dt>tool calls</dt><dd>' + entry.finalResponse.toolCallCount + '</dd>';
    html += '<dt>content</dt><dd>' + escapeHtml(entry.finalResponse.contentPreview ? entry.finalResponse.contentPreview.slice(0, 200) : '') + '</dd>';
    html += '</div></div>';
  }

  // Errors
  if (hasErrors) {
    html += '<div class="section"><div class="section-title">Errors</div>';
    for (const err of entry.errors) {
      html += '<div class="error-item">' + escapeHtml(err) + '</div>';
    }
    html += '</div>';
  }

  html += '</div></div>';
  return html;
}

// Click handler for expanding entries (delegated, avoids inline onclick escaping issues)
document.addEventListener('click', function(e) {
  const header = e.target.closest('[data-toggle="open"]');
  if (header) header.parentElement.classList.toggle('open');
});

// Connect to SSE stream for live updates
const evtSource = new EventSource('/log/stream');
evtSource.onmessage = function(e) {
  try {
    const entry = JSON.parse(e.data);
    const existing = document.querySelector('[data-id="' + entry.id + '"]');
    let isNew = false;
    if (existing) {
      existing.outerHTML = renderEntry(entry, false);
    } else {
      entriesEl.insertAdjacentHTML('afterbegin', renderEntry(entry, true));
      entryCount++;
      isNew = true;
      while (entriesEl.children.length > 50) {
        entriesEl.removeChild(entriesEl.lastChild);
      }
    }
    if (isNew) {
      totalToolCalls += (entry.parsedToolCalls || []).length;
      totalErrors += (entry.errors || []).length;
    }
    countEl.textContent = entryCount;
    toolCountEl.textContent = totalToolCalls;
    errorCountEl.textContent = totalErrors;
  } catch(e) {}
};

// Load initial entries
fetch('/log/json').then(r => r.json()).then(entries => {
  entriesEl.innerHTML = entries.reverse().map(e => renderEntry(e, false)).join('');
  entryCount = entries.length;
  countEl.textContent = entryCount;
});
</script>
</body>
</html>`;
