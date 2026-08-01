/* ── Uptime tracking ── */
var uptimeSeconds = 0;
var uptimeBase = 0;
function updateUptime() {
  if (uptimeBase === 0) return;
  var elapsed = uptimeSeconds + Math.floor((Date.now() - uptimeBase) / 1000);
  var str = fmtDuration(elapsed);
  setText('kpiUptime', str);
  setText('kpiUptimeSub', '');
  setText('headerUptime', str);
}
/* ── KPI + Health ── */
async function refreshHealth() {
  var data = await apiFetch('/health');
  if (!data) return;
  var accts = data.accounts || {};
  var total = accts.total != null ? accts.total : 0;
  var avail = accts.available != null ? accts.available : 0;
  setText('kpiTotalAccounts', total);
  setText('kpiTotalAccountsSub', avail + ' available');
  var pct = total > 0 ? Math.round((avail / total) * 100) : 0;
  setText('kpiAuthenticatedSub', pct + '% available');
  if (data.uptime != null) {
    uptimeSeconds = data.uptime;
    uptimeBase = Date.now();
    updateUptime();
  }
  var acctData = await apiFetch('/accounts');
  if (Array.isArray(acctData)) {
    var authed = 0;
    var totalReqs = 0;
    for (var i = 0; i < acctData.length; i++) {
      if (acctData[i].authenticated) authed++;
      totalReqs += acctData[i].totalRequests || 0;
    }
    setText('kpiAuthenticated', authed);
    var authPct = total > 0 ? Math.round((authed / total) * 100) : 0;
    setText('kpiAuthenticatedSub', authPct + '% of ' + total);
    setText('kpiTotalRequests', totalReqs);
  }
}
/* ── Pool Stats ── */
async function refreshPool() {
  var data = await apiFetch('/pool/stats');
  if (!data) return;
  var inUse = data.inUse || 0;
  var wait = data.waiting || 0;
  var avail = data.available || 0;
  var total = data.total || 0;
  setText('poolActive', inUse);
  setText('poolWaiting', wait);
  setText('poolAvailable', avail);
  setText('poolTotal', total);
  setText('kpiActiveSessions', inUse);
  setText('kpiActiveSessionsSub', 'of ' + total + ' sessions');
  setText('kpiQueue', wait);
  setText('kpiQueueSub', 'queued');
  var pct = total > 0 ? Math.min(100, Math.round((inUse / total) * 100)) : 0;
  var bar = document.getElementById('poolBarFill');
  bar.style.width = pct + '%';
  bar.style.background = pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warning)' : 'var(--accent)';
  // Non-pool providers (deepseek) surface as pool-style stats
  var ds = data.providers && data.providers.deepseek;
  if (ds) {
    setText('poolDsActive', ds.inUse || 0);
    setText('poolDsWaiting', ds.waiting || 0);
    setText('poolDsAvailable', ds.available || 0);
    setText('poolDsTotal', ds.total || 0);
    var dsPct = ds.total > 0 ? Math.min(100, Math.round(((ds.inUse || 0) / ds.total) * 100)) : 0;
    var dsBar = document.getElementById('poolDsBarFill');
    dsBar.style.width = dsPct + '%';
    dsBar.style.background = dsPct > 80 ? 'var(--danger)' : dsPct > 50 ? 'var(--warning)' : 'var(--accent)';
  }
}
/* ── Model Health ── */
async function refreshModelHealth() {
  var data = await apiFetch('/metrics/model-health');
  var tbody = document.getElementById('modelBody');
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">No model activity recorded</div></td></tr>';
    return;
  }
  var keys = Object.keys(data).sort();
  var rows = '';
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i],
      m = data[k];
    var total = (m.successCount || 0) + (m.errorCount || 0);
    var rate = total > 0 ? Math.round(((m.successCount || 0) / total) * 100) : 0;
    var rateClass = rate >= 95 ? 'badge-success' : rate >= 80 ? 'badge-warning' : 'badge-danger';
    rows +=
      '<tr>' +
      '<td>' +
      escHtml(k) +
      '</td>' +
      '<td>' +
      (m.successCount || 0) +
      '</td>' +
      '<td>' +
      (m.errorCount || 0) +
      '</td>' +
      '<td><span class="badge ' +
      rateClass +
      '">' +
      rate +
      '%</span></td>' +
      '<td>' +
      fmtTime(m.lastActivity) +
      '</td>' +
      '</tr>';
  }
  tbody.innerHTML = rows;
}
/* ── System Logs ── */
var _lastSysLogId = '';
async function refreshSysLogs() {
  var data = await apiFetch('/system/logs');
  var container = document.getElementById('sysLogsContainer');
  var empty = document.getElementById('sysLogsEmpty');
  if (!data || !Array.isArray(data) || data.length === 0) return;
  empty.style.display = 'none';
  var html = '';
  var maxId = _lastSysLogId;
  for (var i = 0; i < data.length; i++) {
    var l = data[i];
    if (!l.id || l.id <= _lastSysLogId) continue;
    var lvl = (l.level || 'info').toLowerCase();
    var cls = lvl === 'debug' ? 'log-debug' : lvl === 'warn' || lvl === 'warning' ? 'log-warn' : lvl === 'error' ? 'log-error' : 'log-info';
    html +=
      '<div class="sys-log-entry">' +
      '<span class="sys-log-ts">' +
      fmtTime(l.timestamp) +
      '</span>' +
      '<span class="sys-log-level ' +
      cls +
      '">' +
      escHtml(lvl) +
      '</span>' +
      '<span class="sys-log-cat">' +
      escHtml(l.category || '') +
      '</span>' +
      '<span class="sys-log-msg">' +
      escHtml(l.message || '') +
      '</span>' +
      '</div>';
    if (lvl === 'error' || lvl === 'warn') {
      showNotif(lvl, l.category || '', l.message || '');
    }
    if (l.id > maxId) maxId = l.id;
  }
  if (!html) return;
  container.insertAdjacentHTML('afterbegin', html);
  _lastSysLogId = maxId;
}
function showNotif(level, category, message) {
  var container = document.getElementById('notifContainer') || document.body;
  var notifs = container.querySelectorAll('.notif');
  while (notifs.length >= 5) {
    notifs[0].remove();
    notifs = container.querySelectorAll('.notif');
  }
  var el = document.createElement('div');
  el.className = 'notif notif-' + level;
  el.innerHTML =
    '<strong>' +
    escHtml(level.toUpperCase()) +
    '</strong>' +
    (category ? ' [' + escHtml(category) + ']' : '') +
    ' ' +
    escHtml(message.length > 120 ? message.substring(0, 120) + '...' : message);
  container.appendChild(el);
  setTimeout(function () {
    if (el.parentNode) el.remove();
  }, 6000);
}
/* ── Init ── */
function init() {
  refreshHealth();
  refreshPool();
  refreshModelHealth();
  refreshSysLogs();
  createPoller(refreshHealth, 2000);
  createPoller(refreshPool, 2000);
  createPoller(refreshSysLogs, 2000);
  createPoller(refreshModelHealth, 3000);
  setInterval(updateUptime, 1000);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
