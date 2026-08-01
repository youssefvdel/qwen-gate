import { sidebarHtml } from './sidebar.ts';

export const overviewHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenGate — Dashboard Overview</title>
  <link rel="stylesheet" href="/dashboard/static/shared.css">
  <link rel="stylesheet" href="/dashboard/static/overview.css">


</head>
<body>
<div class="dashboard-layout">
${sidebarHtml('overview')}
  <main class="main-content">
    <div class="page-header">
      <h1>Dashboard Overview</h1>
      <div class="page-header-right">
        <span class="uptime-text">Uptime: <span id="headerUptime">—</span></span>
      </div>
    </div>

    <div class="overview-grid">
      <div class="overview-left">

        <!-- KPI Grid -->
        <div class="kpi-grid" id="kpiGrid">
          <div class="kpi-card"><span class="kpi-label">Total Accounts</span><span class="kpi-value" id="kpiTotalAccounts">—</span><span class="kpi-sub" id="kpiTotalAccountsSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Authenticated</span><span class="kpi-value" id="kpiAuthenticated">—</span><span class="kpi-sub" id="kpiAuthenticatedSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Active Sessions</span><span class="kpi-value" id="kpiActiveSessions">—</span><span class="kpi-sub" id="kpiActiveSessionsSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Queue</span><span class="kpi-value" id="kpiQueue">—</span><span class="kpi-sub" id="kpiQueueSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Total Requests</span><span class="kpi-value" id="kpiTotalRequests">—</span><span class="kpi-sub" id="kpiTotalRequestsSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Uptime</span><span class="kpi-value" id="kpiUptime">—</span><span class="kpi-sub" id="kpiUptimeSub"></span></div>
        </div>

        <!-- Session Pool -->
        <div class="panel">
          <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Session Pool</span><span class="panel-chevron">▼</span></div>
          <div class="panel-body open">
            <div class="panel-content">
              <div class="pool-grid" id="poolGrid">
                <div class="pool-stat"><div class="pool-stat-value" id="poolActive">—</div><div class="pool-stat-label">Active</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolWaiting">—</div><div class="pool-stat-label">Waiting</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolAvailable">—</div><div class="pool-stat-label">Available</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolTotal">—</div><div class="pool-stat-label">Total</div></div>
              </div>
              <div class="pool-bar"><div class="pool-bar-fill" id="poolBarFill" style="width:0%"></div></div>
              <div class="pool-provider-divider">DeepSeek</div>
              <div class="pool-grid" id="poolDsGrid">
                <div class="pool-stat"><div class="pool-stat-value" id="poolDsActive">—</div><div class="pool-stat-label">Active Requests</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolDsWaiting">—</div><div class="pool-stat-label">Waiting</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolDsAvailable">—</div><div class="pool-stat-label">Available</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolDsTotal">—</div><div class="pool-stat-label">Accounts</div></div>
              </div>
              <div class="pool-bar"><div class="pool-bar-fill" id="poolDsBarFill" style="width:0%"></div></div>
            </div>
          </div>
        </div>

        <!-- Model Health -->
        <div class="panel">
          <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Model Health</span><span class="panel-chevron">▼</span></div>
          <div class="panel-body open">
            <div class="panel-content">
              <div class="tbl-wrap">
                <table id="modelTable">
                  <thead><tr><th>Model</th><th>Success</th><th>Errors</th><th>Rate</th><th>Last Activity</th></tr></thead>
                  <tbody id="modelBody"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

      </div>
      <div class="overview-right">

        <!-- System Logs -->
        <div class="panel">
          <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">System Logs</span><span class="panel-chevron">▼</span></div>
          <div class="panel-body open">
            <div class="panel-content" id="sysLogsContainer">
              <div class="empty-state" id="sysLogsEmpty">No system logs yet</div>
            </div>
          </div>
        </div>

      </div>
    </div>
</main>

<div id="notifContainer"></div>



  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/overview.js"></script>
</body>
</html>`;
