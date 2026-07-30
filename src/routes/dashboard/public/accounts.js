function fmtTTL(ms) {
  if (ms == null || ms < 0) return '\u2014';
  var m = Math.floor(ms / 60000),
    h = Math.floor(m / 60);
  m %= 60;
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function showToast(message, type) {
  var container = document.getElementById('toastContainer');
  var toasts = container.querySelectorAll('.toast');
  while (toasts.length >= 5) {
    toasts[0].remove();
    toasts = container.querySelectorAll('.toast');
  }
  var toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function () {
    if (toast.parentNode) toast.remove();
  }, 3500);
}

function setError(msg) {
  var box = document.getElementById('errorBox');
  if (msg) {
    box.textContent = msg;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
}

/* ── Accounts Table ── */
function getAuthStatus(acct) {
  if (acct.startupStatus === 'connecting') return 'connecting';
  if (acct.startupStatus === 'initializing' || acct.startupStatus === 'pending') {
    return 'pending';
  }
  if (acct.throttled) return 'throttled';
  if (acct.authenticated) return 'live';
  if (acct.tokenExpiresInMs != null && acct.tokenExpiresInMs < 0) return 'expired';
  return 'unknown';
}

function getAuthLabel(status) {
  if (status === 'live') return 'Authenticated';
  if (status === 'pending') return 'Starting...';
  if (status === 'connecting') return 'Connecting...';
  if (status === 'expired') return 'Expired';
  if (status === 'throttled') return 'Throttled';
  return 'Not authenticated';
}

function makeThrottleBadge(acct) {
  if (acct.throttled) {
    var label = 'Throttled';
    if (acct.throttledUnlockAt) {
      var unlockTime = new Date(acct.throttledUnlockAt);
      var timeStr = unlockTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      label += ' until ' + timeStr;
    } else if (acct.throttledRemainingMs != null) {
      label += ' ' + fmtTTL(acct.throttledRemainingMs);
    }
    return '<span class="badge badge-warning">' + label + '</span>';
  }
  return '<span class="badge badge-neutral">OK</span>';
}

function renderAccountsTable(accts) {
  if (!Array.isArray(accts) || accts.length === 0) {
    document.getElementById('acctBody').innerHTML = '';
    document.getElementById('emptyState').style.display = '';
    setText('acctCount', '');
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  setText('acctCount', accts.length + ' total');
  var rows = '';
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    var status = getAuthStatus(a);
    var label = getAuthLabel(status);
    var hideLogin = status === 'live' ? ' style="display:none"' : '';
    rows +=
      '<tr>' +
      '<td>' +
      escHtml(a.email) +
      '</td>' +
      '<td><div class="auth-status"><span class="auth-dot ' +
      status +
      '"></span>' +
      label +
      '</div></td>' +
      '<td>' +
      (a.inFlight || 0) +
      '</td>' +
      '<td>' +
      (a.totalRequests || 0) +
      '</td>' +
      '<td>' +
      makeThrottleBadge(a) +
      '</td>' +
      '<td style="font-family:var(--mono);font-size:0.75rem">' +
      fmtTTL(a.tokenExpiresInMs) +
      '</td>' +
      '<td>' +
      '<span class="toggle-trigger" onclick="handleToggleDisabled(event,\'' +
      escHtml(a.email) +
      "'," +
      a.disabled +
      ')">' +
      '<span class="toggle-track' +
      (a.disabled ? ' active' : '') +
      '">' +
      '<span class="toggle-thumb"></span>' +
      '</span></span>' +
      '</td>' +
      '<td><div class="action-cell">' +
      '<button class="account-btn small danger" data-email="' +
      escHtml(a.email) +
      '" data-action="remove">Remove</button>' +
      '<button class="account-btn small primary" data-email="' +
      escHtml(a.email) +
      '" data-action="login"' +
      hideLogin +
      '>Login</button>' +
      '</div></td></tr>';
  }
  document.getElementById('acctBody').innerHTML = rows;
}

/* ── Load Accounts ── */
async function loadAccounts() {
  var data = await apiFetch('/accounts');
  renderAccountsTable(data);
}

/* ── Add Account ── */
function handleAdd(email, password) {
  var btn = document.getElementById('addBtn');
  btn.disabled = true;
  btn.textContent = 'Adding...';
  setError(null);
  (async function () {
    try {
      var res = await fetch('/api/accounts', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ email: email, password: password }),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(
          result && result.error && result.error.message ? result.error.message : 'Failed to add account (' + res.status + ')',
        );
      }
      if (result.loginSucceeded) {
        showToast('Account added and logged in: ' + email, 'success');
        pollAuth(email, 15);
      } else {
        showToast(result.loginError || 'Account added but login failed. Click Login to open browser.', 'warning');
        pollAuth(email, 15);
      }
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add Account';
    }
  })();
}

/* ── Remove Account ── */
function handleRemove(email) {
  document.getElementById('confirmEmail').textContent = email;
  document.getElementById('confirmOverlay').classList.add('open');
  document.getElementById('confirmYes').onclick = async function () {
    document.getElementById('confirmOverlay').classList.remove('open');
    setError(null);
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
        method: 'DELETE',
        headers: authHeaders(),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(
          result && result.error && result.error.message ? result.error.message : 'Failed to remove account (' + res.status + ')',
        );
      }
      showToast('Account removed: ' + email, 'success');
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    }
  };
  document.getElementById('confirmNo').onclick = function () {
    document.getElementById('confirmOverlay').classList.remove('open');
  };
}

/* ── Manual Login (Embedded Browser) ── */
var activeScreencastWs = null;
var activeScreencastEmail = null;

function handleManualLogin(email) {
  var btn = document.querySelector('button[data-email="' + escHtml(email) + '"][data-action="login"]');
  if (btn) {
    btn.textContent = 'Authorizing...';
    btn.disabled = true;
  }
  setError(null);

  /* Fetch password then open embedded browser view */
  (async function () {
    try {
      var pwRes = await fetch('/api/accounts/' + encodeURIComponent(email) + '/password', {
        method: 'GET',
        headers: authHeaders(),
      });
      var pwData;
      try { pwData = await pwRes.json(); } catch { pwData = null; }
      if (!pwRes.ok || !pwData || !pwData.password) {
        throw new Error(pwData && pwData.error && pwData.error.message ? pwData.error.message : 'Could not retrieve password');
      }
      openBrowserView(email, pwData.password);
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Login';
      }
    }
  })();
}

/* ── Screencast (Embedded Browser View) ── */
function openBrowserView(email, password) {
  var overlay = document.getElementById('browserOverlay');
  var canvas = document.getElementById('browserCanvas');
  var ctx = canvas.getContext('2d');
  var loading = document.getElementById('browserLoading');
  var status = document.getElementById('browserStatus');
  var title = document.getElementById('browserTitle');

  title.textContent = 'Browser Login — ' + email;
  status.textContent = 'Connecting...';
  loading.classList.remove('hidden');
  overlay.classList.add('open');

  /* Close existing connection */
  if (activeScreencastWs) {
    activeScreencastWs.send(JSON.stringify({ type: 'close' }));
    activeScreencastWs.close();
    activeScreencastWs = null;
  }

  /* Step 1: POST to get WebSocket token */
  fetch('/api/screencast/launch', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ email: email, password: password }),
  })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.error) throw new Error(data.error);

      /* Step 2: Connect WebSocket with token */
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var wsUrl = proto + '//' + location.host + data.wsUrl;
      var ws = new WebSocket(wsUrl);
      activeScreencastWs = ws;
      activeScreencastEmail = email;

      ws.onopen = function () {
        status.textContent = 'Connected — loading browser...';
      };

      ws.onmessage = function (evt) {
        var msg;
        try { msg = JSON.parse(evt.data); } catch { return; }

        if (msg.type === 'frame') {
          /* Render JPEG frame on canvas */
          loading.classList.add('hidden');
          status.textContent = 'Live — ' + (msg.width || 1280) + 'x' + (msg.height || 800);
          var img = new Image();
          img.onload = function () {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
          };
          img.src = 'data:image/jpeg;base64,' + msg.data;
        } else if (msg.type === 'login_complete') {
          status.textContent = 'Login complete!';
          showToast('Login completed for ' + email, 'success');
          setTimeout(function () { closeBrowserView(); }, 1500);
          pollAuth(email, 5);
          loadAccounts();
        } else if (msg.type === 'browser_closed') {
          status.textContent = 'Browser closed';
          setTimeout(closeBrowserView, 1000);
        } else if (msg.type === 'session_closed') {
          status.textContent = 'Session ended';
          setTimeout(closeBrowserView, 1000);
        } else if (msg.type === 'error') {
          status.textContent = 'Error: ' + msg.message;
          showToast(msg.message, 'error');
        }
      };

      ws.onerror = function () {
        status.textContent = 'Connection error';
        showToast('WebSocket connection failed', 'error');
      };

      ws.onclose = function () {
        if (activeScreencastWs === ws) activeScreencastWs = null;
      };

      /* Step 3: Wire up canvas input events → send to browser */
      setupCanvasInput(canvas, ws);
    })
    .catch(function (e) {
      status.textContent = 'Error: ' + e.message;
      showToast(e.message, 'error');
    });
}

function setupCanvasInput(canvas, ws) {
  var mouseIsDown = false;

  function getCanvasCoords(e) {
    var rect = canvas.getBoundingClientRect();
    var scaleX = canvas.width / rect.width;
    var scaleY = canvas.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  }

  canvas.addEventListener('click', function (e) {
    var coords = getCanvasCoords(e);
    ws.send(JSON.stringify({ type: 'input', event: { type: 'click', x: coords.x, y: coords.y, button: e.button } }));
  });

  canvas.addEventListener('mousemove', function (e) {
    var coords = getCanvasCoords(e);
    ws.send(JSON.stringify({ type: 'input', event: { type: 'mousemove', x: coords.x, y: coords.y, button: e.button } }));
  });

  canvas.addEventListener('mousedown', function (e) {
    e.preventDefault();
    mouseIsDown = true;
    canvas.focus();
    var coords = getCanvasCoords(e);
    ws.send(JSON.stringify({ type: 'input', event: { type: 'mousedown', x: coords.x, y: coords.y, button: e.button } }));
  });

  canvas.addEventListener('mouseup', function (e) {
    mouseIsDown = false;
    var coords = getCanvasCoords(e);
    ws.send(JSON.stringify({ type: 'input', event: { type: 'mouseup', x: coords.x, y: coords.y, button: e.button } }));
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var coords = getCanvasCoords(e);
    /* deltaY > 0 = scroll down, < 0 = scroll up. Send actual delta direction. */
    var dir = e.deltaY > 0 ? 1 : (e.deltaY < 0 ? -1 : 0);
    ws.send(JSON.stringify({ type: 'input', event: { type: 'scroll', x: coords.x, y: coords.y, deltaY: dir } }));
  }, { passive: false });

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* Keyboard — focus canvas first, then capture keys */
  canvas.setAttribute('tabindex', '0');
  canvas.style.outline = 'none';
  canvas.focus();

  canvas.addEventListener('keydown', function (e) {
    e.preventDefault();
    ws.send(JSON.stringify({
      type: 'input',
      event: { type: 'keydown', key: e.key, code: e.code, text: e.key.length === 1 ? e.key : '' },
    }));
  });

  canvas.addEventListener('keyup', function (e) {
    e.preventDefault();
    ws.send(JSON.stringify({
      type: 'input',
      event: { type: 'keyup', key: e.key, code: e.code },
    }));
  });

  canvas.addEventListener('keypress', function (e) {
    e.preventDefault();
    ws.send(JSON.stringify({
      type: 'input',
      event: { type: 'keypress', key: e.key, code: e.code, text: e.key },
    }));
  });
}

function closeBrowserView() {
  var overlay = document.getElementById('browserOverlay');
  overlay.classList.remove('open');
  if (activeScreencastWs) {
    activeScreencastWs.send(JSON.stringify({ type: 'close' }));
    activeScreencastWs.close();
    activeScreencastWs = null;
  }
  activeScreencastEmail = null;
  /* Re-enable login buttons */
  document.querySelectorAll('button[data-action="login"]').forEach(function (btn) {
    btn.disabled = false;
    btn.textContent = 'Login';
  });
}

/* ── Poll Auth ── */
var activePollTimers = {};
function pollAuth(email, maxAttempts) {
  if (activePollTimers[email]) {
    clearInterval(activePollTimers[email]);
    delete activePollTimers[email];
  }
  var attempt = 0;
  var timer = setInterval(async function () {
    attempt++;
    try {
      var data = await apiFetch('/accounts');
      if (!Array.isArray(data)) {
        clearInterval(timer);
        delete activePollTimers[email];
        return;
      }
      for (var i = 0; i < data.length; i++) {
        if (data[i].email === email && data[i].authenticated) {
          clearInterval(timer);
          delete activePollTimers[email];
          showToast('Login completed for ' + email, 'success');
          loadAccounts();
          return;
        }
      }
    } catch {
      clearInterval(timer);
      delete activePollTimers[email];
    }
    if (attempt >= maxAttempts) {
      clearInterval(timer);
      delete activePollTimers[email];
      loadAccounts();
    }
  }, 2000);
  activePollTimers[email] = timer;
}

/* ── Toggle Disabled ── */
async function handleToggleDisabled(event, email, currentlyDisabled) {
  event.stopPropagation();
  var newDisabled = !currentlyDisabled;
  var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ disabled: newDisabled }),
  });
  if (res.ok) {
    showToast(email + ' ' + (newDisabled ? 'disabled' : 'enabled'), 'success');
    loadAccounts();
  } else {
    var err = await res.json().catch(function () {
      return { error: 'Failed' };
    });
    showToast(err.error || 'Failed to toggle', 'error');
  }
}

/* ── Init ── */
function init() {
  /* Load on start */
  loadAccounts();

  /* Auto-poll every 2 seconds */
  createPoller(loadAccounts, 2000);

  /* Add form submit */
  document.getElementById('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('emailInput').value.trim();
    var password = document.getElementById('passwordInput').value;
    if (!email || !password) {
      showToast('Email and password are required', 'error');
      return;
    }
    handleAdd(email, password);
    this.reset();
  });

  /* Table button delegation */
  document.getElementById('acctTable').addEventListener('click', function (e) {
    var btn = e.target;
    if (btn.tagName !== 'BUTTON') return;
    var email = btn.getAttribute('data-email');
    var action = btn.getAttribute('data-action');
    if (!email || !action) return;
    if (action === 'login') handleManualLogin(email);
    else if (action === 'remove') handleRemove(email);
  });

  /* Close modal on overlay click */
  document.getElementById('confirmOverlay').addEventListener('click', function (e) {
    if (e.target === this) this.classList.remove('open');
  });

  /* Close browser view */
  document.getElementById('browserClose').addEventListener('click', closeBrowserView);
  document.getElementById('browserOverlay').addEventListener('click', function (e) {
    if (e.target === this) closeBrowserView();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
