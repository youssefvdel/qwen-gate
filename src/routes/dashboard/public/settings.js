var settingsData = {};
var originalData = {};

var SETTINGS_SECTIONS = [
  {
    title: 'Server',
    desc: 'Port, security, and browser engine settings.',
    fields: [
      { key: 'PORT', label: 'PORT', type: 'number', restartRequired: true },
      { key: 'API_KEY', label: 'API_KEY', type: 'password' },
    ],
  },
  {
    title: 'Pipeline',
    desc: 'Output transformation, streaming mode, and tool-call behaviour.',
    fields: [
      { key: 'TOOL_CALLING', label: 'TOOL_CALLING', type: 'checkbox' },
      { key: 'CLEAN_OUTPUT', label: 'CLEAN_OUTPUT', type: 'checkbox' },
      {
        key: 'STREAMING_MODE',
        label: 'STREAMING_MODE',
        type: 'select',
        options: [
          { value: 'auto', label: 'Auto (respect client)' },
          { value: 'stream', label: 'Always stream' },
          { value: 'non-stream', label: 'Never stream' },
        ],
      },
      {
        key: 'THINKING_MODE',
        label: 'THINKING_MODE',
        type: 'select',
        options: [
          { value: 'auto', label: 'Auto (follow client)' },
          { value: 'off', label: 'Off (no thinking)' },
          { value: 'summary', label: 'Summary (compact thinking)' },
          { value: 'full', label: 'Full (deep reasoning)' },
        ],
      },
      { key: 'MAX_TOOL_CALLS_PER_RESPONSE', label: 'MAX_TOOL_CALLS_PER_RESPONSE', type: 'number' },
      {
        key: 'FAST_TRANSPORT',
        label: 'FAST_TRANSPORT',
        type: 'checkbox',
        desc: 'Fast plain-HTTP transport (native fetch + SSXMOD cookie, falls back to wreq on WAF)',
      },
      {
        key: 'LOCAL_MCP_MAX_CHARS',
        label: 'LOCAL_MCP_MAX_CHARS (tool schema budget, ~127KB Qwen limit)',
        type: 'number',
        desc: 'Shrinks the longest tool descriptions until local_mcp fits. Qwen returns empty responses when this exceeds ~127KB.',
      },
      {
        key: 'CAPTCHA_SOLVER',
        label: 'CAPTCHA_SOLVER (interactive anti-bot CAPTCHA solving)',
        type: 'checkbox',
        desc: 'Opens a visible browser window with the account profile when Qwen hits FAIL_SYS_USER_VALIDATE, so the CAPTCHA can be solved on screen. Falls back to throttling+switching when off or on timeout.',
      },
      {
        key: 'CAPTCHA_SOLVE_TIMEOUT_MS',
        label: 'CAPTCHA_SOLVE_TIMEOUT_MS (ms to wait for manual solve)',
        type: 'number',
        desc: 'How long to keep the visible solver window open before giving up and switching accounts.',
      },
    ],
  },
  {
    title: 'Session & Auth',
    desc: 'Token lifetimes, refresh windows, and session cleanup.',
    fields: [
      { key: 'QWEN_FETCH_TIMEOUT_MS', label: 'QWEN_FETCH_TIMEOUT_MS', type: 'number' },
      { key: 'AUTH_TOKEN_MAX_AGE_MS', label: 'AUTH_TOKEN_MAX_AGE_MS', type: 'number' },
      { key: 'AUTH_REFRESH_BEFORE_MS', label: 'AUTH_REFRESH_BEFORE_MS', type: 'number' },
      { key: 'DELETE_SESSION', label: 'DELETE_SESSION', type: 'checkbox' },
      { key: 'SESSION_POOL_SIZE', label: 'SESSION_POOL_SIZE (empty chats per account)', type: 'number' },
      { key: 'SESSION_POOL_IDLE_TTL_MS', label: 'SESSION_POOL_IDLE_TTL_MS', type: 'number' },
    ],
  },
  {
    title: 'Rate Limiting',
    desc: 'Cooldowns and throttling to prevent account bans.',
    fields: [{ key: 'RATE_LIMIT_COOLDOWN_MS', label: 'RATE_LIMIT_COOLDOWN_MS', type: 'number' }],
  },
  {
    title: 'Retry & Startup',
    desc: 'Retry logic, backoff, and auto-open dashboard settings.',
    fields: [
      { key: 'RETRY_ENABLED', label: 'RETRY_ENABLED', type: 'checkbox' },
      { key: 'RETRY_MAX_ATTEMPTS', label: 'RETRY_MAX_ATTEMPTS', type: 'number' },
      { key: 'RETRY_BASE_DELAY_MS', label: 'RETRY_BASE_DELAY_MS', type: 'number' },
      { key: 'RETRY_MAX_DELAY_MS', label: 'RETRY_MAX_DELAY_MS', type: 'number' },
      { key: 'RETRY_BACKOFF_MULTIPLIER', label: 'RETRY_BACKOFF_MULTIPLIER', type: 'number', step: '0.1' },
      { key: 'OPEN_DASHBOARD_ON_START', label: 'OPEN_DASHBOARD_ON_START', type: 'checkbox', restartRequired: true },
    ],
  },
  {
    title: 'Logging',
    desc: 'Per-request log storage and retention.',
    fields: [
      { key: 'SAVE_REQUEST_LOGS', label: 'SAVE_REQUEST_LOGS', type: 'checkbox' },
      { key: 'MAX_LOGS', label: 'MAX_LOGS', type: 'number' },
    ],
  },
  {
    title: 'Claude Code',
    desc: 'Auto-configure qwen-gate as a Claude Code proxy. Creates .claude/settings.json in the project root.',
    fields: [{ key: 'CLAUDE_CODE_PROXY', label: 'CLAUDE_CODE_PROXY', type: 'checkbox' }],
  },
  {
    title: 'System & Accounts',
    desc: 'System prompts and account management actions.',
    fields: [
      { key: 'USE_CUSTOM_INSTRUCTION', label: 'USE_CUSTOM_INSTRUCTION', type: 'checkbox' },
      { key: 'CUSTOM_INSTRUCTION', label: 'CUSTOM_INSTRUCTION', type: 'text' },
    ],
  },
];

/* ── Render ── */
function renderSettingsForm() {
  var container = document.getElementById('settingsSections');
  var html = '';
  for (var s = 0; s < SETTINGS_SECTIONS.length; s++) {
    var section = SETTINGS_SECTIONS[s];
    html +=
      '<fieldset class="settings-section">' +
      '<div class="settings-section-title">' +
      escHtml(section.title) +
      '</div>' +
      '<p class="settings-section-desc">' +
      escHtml(section.desc) +
      '</p>' +
      '<div class="settings-fields">';
    for (var f = 0; f < section.fields.length; f++) {
      var field = section.fields[f];
      var val = settingsData[field.key] !== undefined ? settingsData[field.key] : '';
      html += renderSettingsField(field, val);
    }
    html += '</div></fieldset>';
  }
  container.innerHTML = html + renderDeleteAllChatsSection() + renderClaudeCodeInfo();
}

function renderDeleteAllChatsSection() {
  return (
    '<div class="settings-section" style="border-color:var(--danger);margin-top:24px">' +
    '<div class="settings-section-title" style="color:var(--danger)">Danger Zone</div>' +
    '<p class="settings-section-desc" style="color:var(--text-secondary)">Irreversible account-wide actions. Proceed with caution.</p>' +
    '<button class="delete-all-btn" onclick="handleDeleteAllChats()">Delete All Chats</button></div>'
  );
}

function renderClaudeCodeInfo() {
  if (!settingsData['CLAUDE_CODE_PROXY'] || settingsData['CLAUDE_CODE_PROXY'] !== 'true') return '';
  var host = settingsData['HOST'] || 'localhost';
  var port = settingsData['PORT'] || '26405';
  var baseUrl = 'http://' + host + ':' + port;
  return (
    '<div class="settings-section" style="margin-top:24px">' +
    '<div class="settings-section-title">Claude Code Proxy Active</div>' +
    '<p class="settings-section-desc">qwen-gate is configured as a Claude Code proxy. ' +
    'Set these environment variables when running Claude Code, or the <code>.claude/settings.json</code> file has been auto-configured for you.</p>' +
    '<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;margin-top:8px">' +
    '<code style="display:block;padding:4px 0">ANTHROPIC_BASE_URL=' +
    baseUrl +
    '</code>' +
    '<code style="display:block;padding:4px 0">ANTHROPIC_AUTH_TOKEN=unused</code>' +
    '</div>' +
    '<p style="margin-top:8px;font-size:0.85em;color:var(--text-secondary)">' +
    'The <code>.claude/settings.json</code> file is auto-created in the project root when this toggle is on, ' +
    'and cleaned up when toggled off.' +
    '</p></div>'
  );
}

async function handleDeleteAllChats() {
  var bodyHtml =
    '<p style="margin:0 0 12px">This will permanently <strong>delete all conversations</strong> from every Qwen account.</p>' +
    '<p style="margin:0;color:var(--danger)"><strong>This action cannot be undone.</strong></p>';
  var footerHtml =
    '<button class="modal-btn modal-btn-secondary" onclick="hideModal()">Cancel</button>' +
    '<button class="modal-btn modal-btn-primary" id="confirmDeleteBtn" onclick="executeDeleteAllChats()">Yes, delete all</button>';
  showModal('Delete All Chats', bodyHtml, footerHtml);
}

function renderSettingsField(field, val) {
  var restartBadge = field.restartRequired
    ? '<span class="restart-badge" title="This setting only takes effect after a server restart">Restart required</span>'
    : '';
  if (field.type === 'action') {
    return (
      '<div class="settings-field" style="grid-column:span 2">' +
      '<label>' +
      escHtml(field.label) +
      '</label>' +
      '<p style="font-size:0.75rem;color:var(--text-secondary);margin:0 0 8px">' +
      escHtml(field.desc || '') +
      '</p>' +
      '<button class="save-btn" style="background:var(--danger)" onclick="handleSettingsAction(\'' +
      field.action +
      '\')">' +
      escHtml(field.label) +
      '</button></div>'
    );
  }
  if (field.type === 'checkbox') {
    var checked = val === 'true';
    var trackClass = checked ? ' toggle-track active' : ' toggle-track';
    return (
      '<div class="settings-toggle" data-key="' +
      field.key +
      '" onclick="onToggleClick(this)">' +
      '<span class="' +
      trackClass +
      '">' +
      '<span class="toggle-thumb"></span>' +
      '</span>' +
      '<span class="toggle-label">' +
      escHtml(field.label) +
      '</span>' +
      (field.restartRequired ? '<span class="restart-badge-wrap" id="rb-' + field.key + '">' + restartBadge + '</span>' : '') +
      '</div>'
    );
  }
  if (field.key === 'CUSTOM_INSTRUCTION') {
    return (
      '<div class="settings-field" style="grid-column:span 2">' +
      '<label for="cfg-CUSTOM_INSTRUCTION">' +
      escHtml(field.label) +
      '</label>' +
      (field.restartRequired ? '<span class="restart-badge-wrap" id="rb-' + field.key + '">' + restartBadge + '</span>' : '') +
      '<textarea id="cfg-CUSTOM_INSTRUCTION" data-key="CUSTOM_INSTRUCTION" rows="4" oninput="onFieldChange(this)">' +
      escHtml(val) +
      '</textarea></div>'
    );
  }
  if (field.type === 'select') {
    var opts = '';
    for (var o = 0; o < field.options.length; o++) {
      var opt = field.options[o];
      var sel = opt.value === val ? ' selected' : '';
      opts += '<option value="' + escHtml(opt.value) + '"' + sel + '>' + escHtml(opt.label) + '</option>';
    }
    return (
      '<div class="settings-field">' +
      '<label for="cfg-' +
      field.key +
      '">' +
      escHtml(field.label) +
      '</label>' +
      (field.restartRequired ? '<span class="restart-badge-wrap" id="rb-' + field.key + '">' + restartBadge + '</span>' : '') +
      '<select id="cfg-' +
      field.key +
      '" data-key="' +
      field.key +
      '" onchange="onFieldChange(this)">' +
      opts +
      '</select></div>'
    );
  }
  var inputType = field.type || 'text';
  var stepAttr = field.step ? ' step="' + field.step + '"' : '';
  return (
    '<div class="settings-field">' +
    '<label for="cfg-' +
    field.key +
    '">' +
    escHtml(field.label) +
    '</label>' +
    (field.restartRequired ? '<span class="restart-badge-wrap" id="rb-' + field.key + '">' + restartBadge + '</span>' : '') +
    '<input type="' +
    inputType +
    '" id="cfg-' +
    field.key +
    '" data-key="' +
    field.key +
    '" value="' +
    escHtml(val) +
    '"' +
    stepAttr +
    ' oninput="onFieldChange(this)"></div>'
  );
}

/* ── Change tracking ── */
/* ponytail: toggle is a div with inline onclick, no hidden checkbox/label confusion */
function onToggleClick(container) {
  var key = container.getAttribute('data-key');
  var track = container.querySelector('.toggle-track');
  settingsData[key] = track.classList.contains('active') ? 'false' : 'true';
  track.classList.toggle('active');
  updateRestartBadge(key);
}
function onFieldChange(el) {
  settingsData[el.getAttribute('data-key')] = el.value;
  updateRestartBadge(el.getAttribute('data-key'));
}

/* ── Restart badge: only show when value changed AND field requires restart ── */
function updateRestartBadge(key) {
  var wrap = document.getElementById('rb-' + key);
  if (!wrap) return;
  var badge = wrap.querySelector('.restart-badge');
  var changed = String(settingsData[key]) !== String(originalData[key]);
  if (changed) {
    if (!badge) {
      var el = document.createElement('span');
      el.className = 'restart-badge';
      el.title = 'This setting only takes effect after a server restart';
      el.textContent = 'Restart required';
      wrap.appendChild(el);
    }
  } else {
    if (badge) badge.remove();
  }
}

/* ── Load ── */
async function loadSettings() {
  try {
    var res = await fetch('/api/config');
    if (res.ok) {
      var data = await res.json();
      if (data && data.config) {
        settingsData = {};
        originalData = {};
        var keys = Object.keys(data.config);
        for (var i = 0; i < keys.length; i++) {
          var v = data.config[keys[i]];
          settingsData[keys[i]] = v;
          originalData[keys[i]] = v;
        }
      }
    }
  } catch (e) {
    console.error('Settings load error:', e);
  }
  renderSettingsForm();
  // Hide restart badges for fields where value hasn't changed
  setTimeout(function () {
    for (var s = 0; s < SETTINGS_SECTIONS.length; s++) {
      var section = SETTINGS_SECTIONS[s];
      for (var f = 0; f < section.fields.length; f++) {
        if (section.fields[f].restartRequired) {
          updateRestartBadge(section.fields[f].key);
        }
      }
    }
  }, 0);
}

/* ── Save ── */
async function saveSettings() {
  var btn = document.getElementById('settingsSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  var msgEl = document.getElementById('settingsMessage');
  try {
    var headers = { 'Content-Type': 'application/json' };
    var res = await fetch('/api/config', {
      method: 'PUT',
      headers: headers,
      body: JSON.stringify(settingsData),
    });
    var result = await res.json();
    if (!res.ok) {
      msgEl.innerHTML = '<div class="settings-message error">' + escHtml(result.error || 'Save failed (' + res.status + ')') + '</div>';
    } else {
      if (result.config) {
        var keys = Object.keys(result.config);
        for (var i = 0; i < keys.length; i++) {
          settingsData[keys[i]] = result.config[keys[i]];
        }
        renderSettingsForm();
      }
      msgEl.innerHTML = '<div class="settings-message success">Settings saved successfully.</div>';
      setTimeout(function () {
        msgEl.innerHTML = '';
      }, 4000);
    }
  } catch (e) {
    msgEl.innerHTML = '<div class="settings-message error">' + escHtml(e.message) + '</div>';
  }
  btn.disabled = false;
  btn.textContent = 'Save Changes';
}

/* ── Modal ── */
function showModal(title, bodyHtml, footerHtml) {
  document.getElementById('modalHeader').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalFooter').innerHTML = footerHtml;
  document.getElementById('confirmModal').classList.remove('hidden');
}
function hideModal() {
  document.getElementById('confirmModal').classList.add('hidden');
}

/* ── Actions ── */
async function handleSettingsAction(action) {
  if (action === 'deleteAllChats') {
    var bodyHtml =
      '<p style="margin:0 0 12px">This will permanently <strong>delete all conversations</strong> from every Qwen account.</p>' +
      '<p style="margin:0;color:var(--danger)"><strong>This action cannot be undone.</strong></p>';
    var footerHtml =
      '<button class="modal-btn modal-btn-secondary" onclick="hideModal()">Cancel</button>' +
      '<button class="modal-btn modal-btn-primary" id="confirmDeleteBtn" onclick="executeDeleteAllChats()">Yes, delete all</button>';
    showModal('Delete All Chats', bodyHtml, footerHtml);
  }
}

async function executeDeleteAllChats() {
  var btn = document.getElementById('confirmDeleteBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Deleting...';
  }
  document.getElementById('modalFooter').innerHTML = '<span style="font-size:0.8125rem;color:var(--text-secondary)">Processing...</span>';
  var bodyEl = document.getElementById('modalBody');
  bodyEl.innerHTML = '<div id="deleteProgress"></div>';
  var progressEl = document.getElementById('deleteProgress');
  var doneCount = 0;
  var errorCount = 0;
  try {
    var res = await fetch('/dashboard/accounts/delete-all-chats', { method: 'POST', headers: authHeaders() });
    if (!res.ok) {
      var errBody = '';
      try {
        errBody = await res.text();
      } catch {}
      var errMsg = errBody || 'HTTP ' + res.status;
      try {
        var errJson = JSON.parse(errBody);
        if (errJson.error) errMsg = errJson.error;
      } catch {}
      progressEl.innerHTML = '<div style="color:var(--danger)">Error: ' + escHtml(errMsg) + '</div>';
      var footerHtml = '<button class="modal-btn modal-btn-secondary" onclick="hideModal()">Close</button>';
      document.getElementById('modalFooter').innerHTML = footerHtml;
      return;
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    while (true) {
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || !line.startsWith('data: ')) continue;
        try {
          var data = JSON.parse(line.slice(6));
          if (data.type === 'result') {
            progressEl.innerHTML +=
              '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);font-weight:600;color:var(--success)">[OK] Done: ' +
              data.deleted +
              ' / ' +
              data.total +
              ' accounts</div>';
            if (data.errors && data.errors.length > 0) {
              for (var ei = 0; ei < data.errors.length; ei++) {
                progressEl.innerHTML +=
                  '<div style="color:var(--danger);font-size:0.75rem;padding:2px 0">[FAIL] ' + escHtml(data.errors[ei]) + '</div>';
              }
            }
            var footerHtml = '<button class="modal-btn modal-btn-secondary" onclick="hideModal()">Close</button>';
            document.getElementById('modalFooter').innerHTML = footerHtml;
            return;
          }
          if (data.type === 'progress') {
            if (data.status === 'deleting') {
              progressEl.innerHTML +=
                '<div id="prog-' +
                escHtml(data.email.replace(/[@.]/g, '_')) +
                '" style="color:var(--text-secondary);padding:3px 0;font-size:0.75rem">\u2026 ' +
                escHtml(data.email) +
                '...</div>';
            } else if (data.status === 'done') {
              doneCount++;
              var progEl = document.getElementById('prog-' + escHtml(data.email.replace(/[@.]/g, '_')));
              if (progEl) {
                progEl.outerHTML =
                  '<div style="color:var(--success);padding:3px 0;font-size:0.75rem">[OK] ' + escHtml(data.email) + '</div>';
              } else {
                progressEl.innerHTML +=
                  '<div style="color:var(--success);padding:3px 0;font-size:0.75rem">[OK] ' + escHtml(data.email) + '</div>';
              }
            } else if (data.status === 'error') {
              errorCount++;
              var progEl = document.getElementById('prog-' + escHtml(data.email.replace(/[@.]/g, '_')));
              if (progEl) {
                progEl.outerHTML =
                  '<div style="color:var(--danger);padding:3px 0;font-size:0.75rem">[FAIL] ' +
                  escHtml(data.email) +
                  ': ' +
                  escHtml(data.error) +
                  '</div>';
              } else {
                progressEl.innerHTML +=
                  '<div style="color:var(--danger);padding:3px 0;font-size:0.75rem">[FAIL] ' +
                  escHtml(data.email) +
                  ': ' +
                  escHtml(data.error) +
                  '</div>';
              }
            }
            progressEl.scrollTop = progressEl.scrollHeight;
          }
        } catch {}
      }
    }
    /* If stream ended with no result event, show fallback */
    var footerHtml = '<button class="modal-btn modal-btn-secondary" onclick="hideModal()">Close</button>';
    document.getElementById('modalFooter').innerHTML = footerHtml;
    if (doneCount === 0 && errorCount === 0) {
      progressEl.innerHTML = '<div style="color:var(--text-secondary)">No accounts processed. The server may have returned an error.</div>';
    }
  } catch (e) {
    bodyEl.innerHTML = '<p style="color:var(--danger)">Error: ' + escHtml(e.message) + '</p>';
    var footerHtml = '<button class="modal-btn modal-btn-secondary" onclick="hideModal()">Close</button>';
    document.getElementById('modalFooter').innerHTML = footerHtml;
  }
}

function showToast(msg, type) {
  var container = document.getElementById('toastContainer') || document.body;
  var toasts = container.querySelectorAll('.toast');
  while (toasts.length >= 5) {
    toasts[0].remove();
    toasts = container.querySelectorAll('.toast');
  }
  var el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(function () {
    el.remove();
  }, 4000);
}

/* ── Init ── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadSettings);
} else {
  loadSettings();
}
