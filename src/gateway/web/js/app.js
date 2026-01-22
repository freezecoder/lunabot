/**
 * LocalBot Dashboard - Main Application
 * Uses Preact + HTM via CDN for a lightweight, no-build setup
 */

import { html, render, Component } from 'https://esm.sh/htm/preact/standalone';
import {
  subscribe,
  getState,
  setState,
  setTheme,
  toggleTheme,
  setView,
  setFilter,
} from './state.js';
import {
  fetchAll,
  fetchHealth,
  fetchActivity,
  fetchCron,
  fetchEvents,
  fetchEventTypes,
  fetchDbSessions,
  fetchSessionMessages,
  fetchMemoryStatus,
  fetchMemoryHistory,
  triggerMemorySync,
  fetchWorkspace,
  connectWebSocket,
  startService,
  stopService,
  restartService,
  startChatSession,
  loadChatSession,
  sendChatMessage,
  clearChat,
  fetchChatModels,
} from './api.js';
import {
  formatBytes,
  formatDuration,
  formatRelativeTime,
  formatPercent,
  formatNumber,
  truncate,
  activityIcons,
  sourceLabels,
  getProgressColor,
  debounce,
} from './utils.js';

// ============================================
// Header Component
// ============================================
function Header({ connected, theme }) {
  return html`
    <header class="header">
      <div class="header-left">
        <div class="logo">
          <span class="logo-icon">🤖</span>
          <span>LocalBot</span>
        </div>
      </div>
      <div class="header-right">
        <div class="connection-status">
          <span class="status-dot ${connected ? 'connected' : ''}"></span>
          <span>${connected ? 'Connected' : 'Disconnected'}</span>
        </div>
        <button class="theme-toggle" onclick=${toggleTheme}>
          ${theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>
    </header>
  `;
}

// ============================================
// Sidebar Component
// ============================================
function Sidebar({ view }) {
  const navItems = [
    { id: 'dashboard', icon: '📊', label: 'Dashboard' },
    { id: 'chat', icon: '🤖', label: 'Chat' },
    { id: 'workspace', icon: '📄', label: 'Workspace' },
    { id: 'events', icon: '📋', label: 'Events' },
    { id: 'sessions', icon: '💬', label: 'Sessions' },
    { id: 'memory', icon: '🧠', label: 'Memory' },
    { id: 'activity', icon: '📜', label: 'Activity' },
    { id: 'tools', icon: '🔧', label: 'Tools' },
    { id: 'cron', icon: '⏰', label: 'Cron Jobs' },
    { id: 'metrics', icon: '📈', label: 'Metrics' },
  ];

  return html`
    <aside class="sidebar">
      <nav class="nav-section">
        <div class="nav-section-title">Navigation</div>
        ${navItems.map(
          (item) => html`
            <div
              class="nav-item ${view === item.id ? 'active' : ''}"
              onclick=${() => setView(item.id)}
            >
              <span class="nav-icon">${item.icon}</span>
              <span>${item.label}</span>
            </div>
          `
        )}
      </nav>
    </aside>
  `;
}

// ============================================
// Stat Card Component
// ============================================
function StatCard({ icon, value, label, subtext, progress, progressColor }) {
  return html`
    <div class="card stat-card">
      <div class="stat-icon">${icon}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-label">${label}</div>
      ${subtext && html`<div class="stat-change">${subtext}</div>`}
      ${progress !== undefined &&
      html`
        <div class="progress-bar">
          <div
            class="progress-fill ${progressColor || ''}"
            style="width: ${Math.min(progress, 100)}%"
          ></div>
        </div>
      `}
    </div>
  `;
}

// ============================================
// Service Card Component
// ============================================
function ServiceCard({ service }) {
  const statusClass =
    service.status === 'running'
      ? 'running'
      : service.status === 'error'
      ? 'error'
      : 'stopped';

  const handleAction = async (action) => {
    try {
      if (action === 'start') await startService(service.name);
      else if (action === 'stop') await stopService(service.name);
      else if (action === 'restart') await restartService(service.name);
      fetchHealth();
    } catch (error) {
      console.error(`Service ${action} failed:`, error);
    }
  };

  return html`
    <div class="service-card">
      <div class="service-status ${statusClass}"></div>
      <div class="service-info">
        <div class="service-name">${service.name}</div>
        <div class="service-meta">
          ${service.status}
          ${service.uptime ? ` • ${formatDuration(service.uptime)}` : ''}
        </div>
      </div>
      ${service.status === 'running'
        ? html`<button
            class="btn btn-sm btn-secondary"
            onclick=${() => handleAction('restart')}
          >
            ↻
          </button>`
        : html`<button
            class="btn btn-sm btn-primary"
            onclick=${() => handleAction('start')}
          >
            ▶
          </button>`}
    </div>
  `;
}

// ============================================
// Activity Item Component
// ============================================
function ActivityItem({ entry }) {
  const icon = activityIcons[entry.type] || '📝';
  const source = sourceLabels[entry.source] || entry.source;

  return html`
    <div class="activity-item">
      <div class="activity-icon">${icon}</div>
      <div class="activity-content">
        <div class="activity-title">${entry.type}</div>
        <div class="activity-preview">${truncate(entry.content, 80)}</div>
        <div class="activity-meta">
          ${source} • ${formatRelativeTime(entry.timestamp)}
        </div>
      </div>
    </div>
  `;
}

// ============================================
// Dashboard View
// ============================================
function DashboardView({ state }) {
  const { health, services, sessions, activity, ollama, metrics } = state;

  const memoryPercent = health?.system?.memory?.percent || 0;
  const cpuArr = health?.system?.cpu || [];
  const cpuLoad = Array.isArray(cpuArr) ? (cpuArr[0] || 0) : (cpuArr || 0);
  const uptime = health?.uptime || 0;

  const totalMessages =
    (sessions?.terminal?.messages || 0) + (sessions?.telegram?.messages || 0);
  const totalToolCalls =
    (sessions?.terminal?.toolCalls || 0) + (sessions?.telegram?.toolCalls || 0);

  return html`
    <div>
      <div class="page-header">
        <h1 class="page-title">Dashboard</h1>
        <p class="page-subtitle">LocalBot system overview</p>
      </div>

      <!-- Stats Grid -->
      <div class="grid grid-4 mb-lg">
        <${StatCard}
          icon="🧠"
          value="${formatPercent(memoryPercent, 0)}"
          label="Memory Usage"
          subtext="${formatBytes(health?.system?.memory?.used || 0)} / ${formatBytes(
            health?.system?.memory?.total || 0
          )}"
          progress=${memoryPercent}
          progressColor=${getProgressColor(memoryPercent)}
        />
        <${StatCard}
          icon="⚡"
          value="${cpuLoad.toFixed(1)}%"
          label="CPU Load"
          progress=${cpuLoad}
          progressColor=${getProgressColor(cpuLoad)}
        />
        <${StatCard}
          icon="⏱️"
          value="${formatDuration(uptime)}"
          label="Uptime"
          subtext="Gateway running"
        />
        <${StatCard}
          icon="💬"
          value="${formatNumber(totalMessages)}"
          label="Total Messages"
          subtext="${formatNumber(totalToolCalls)} tool calls"
        />
      </div>

      <!-- Services and Ollama -->
      <div class="grid grid-2 mb-lg">
        <div class="card">
          <div class="card-header">
            <span class="card-title">Services</span>
          </div>
          <div class="card-body">
            <div class="service-grid">
              ${services.map((s) => html`<${ServiceCard} service=${s} />`)}
              ${services.length === 0 &&
              html`<div class="empty-state text-sm">No services</div>`}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Ollama</span>
            <span class="badge ${ollama?.running ? 'badge-success' : 'badge-error'}">
              ${ollama?.running ? 'Running' : 'Offline'}
            </span>
          </div>
          <div class="card-body">
            ${ollama?.running
              ? html`
                  <div class="flex flex-col gap-sm">
                    <div class="flex justify-between">
                      <span class="text-muted text-sm">Models Loaded</span>
                      <span class="text-sm">${ollama?.modelsLoaded || 0}</span>
                    </div>
                    ${ollama?.vram &&
                    html`
                      <div class="flex justify-between">
                        <span class="text-muted text-sm">VRAM Used</span>
                        <span class="text-sm">${formatBytes(ollama.vram.used)}</span>
                      </div>
                      <div class="progress-bar">
                        <div
                          class="progress-fill ${getProgressColor(
                            (ollama.vram.used / ollama.vram.total) * 100
                          )}"
                          style="width: ${(ollama.vram.used / ollama.vram.total) * 100}%"
                        ></div>
                      </div>
                    `}
                    ${ollama?.version &&
                    html`
                      <div class="flex justify-between mt-sm">
                        <span class="text-muted text-sm">Version</span>
                        <span class="text-sm font-mono">${ollama.version}</span>
                      </div>
                    `}
                  </div>
                `
              : html`
                  <div class="empty-state">
                    <div class="empty-icon">🔌</div>
                    <p>Ollama is not running</p>
                  </div>
                `}
          </div>
        </div>
      </div>

      <!-- Recent Activity -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Recent Activity</span>
          <button class="btn btn-sm btn-secondary" onclick=${() => setView('activity')}>
            View All
          </button>
        </div>
        <div class="card-body" style="padding: 0;">
          <div class="activity-list">
            ${(activity?.entries || []).slice(0, 5).map(
              (entry) => html`<${ActivityItem} entry=${entry} />`
            )}
            ${(!activity?.entries || activity.entries.length === 0) &&
            html`
              <div class="empty-state">
                <p>No recent activity</p>
              </div>
            `}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============================================
// Activity View
// ============================================
function ActivityView({ state }) {
  const { activity, filters } = state;

  const handleSourceChange = (source) => {
    setFilter('activitySource', source);
    fetchActivity(filters.activityLimit, source);
  };

  return html`
    <div>
      <div class="page-header">
        <h1 class="page-title">Activity Log</h1>
        <p class="page-subtitle">All bot activity and interactions</p>
      </div>

      <!-- Filters -->
      <div class="tabs">
        <button
          class="tab ${!filters.activitySource ? 'active' : ''}"
          onclick=${() => handleSourceChange(null)}
        >
          All
        </button>
        <button
          class="tab ${filters.activitySource === 'terminal' ? 'active' : ''}"
          onclick=${() => handleSourceChange('terminal')}
        >
          Terminal
        </button>
        <button
          class="tab ${filters.activitySource === 'telegram' ? 'active' : ''}"
          onclick=${() => handleSourceChange('telegram')}
        >
          Telegram
        </button>
      </div>

      <!-- Stats Summary -->
      <div class="grid grid-4 mb-lg">
        <${StatCard}
          icon="💬"
          value="${formatNumber(activity?.stats?.terminal?.messages || 0)}"
          label="Terminal Messages"
        />
        <${StatCard}
          icon="📱"
          value="${formatNumber(activity?.stats?.telegram?.messages || 0)}"
          label="Telegram Messages"
        />
        <${StatCard}
          icon="🔧"
          value="${formatNumber(
            (activity?.stats?.terminal?.toolCalls || 0) +
              (activity?.stats?.telegram?.toolCalls || 0)
          )}"
          label="Tool Calls"
        />
        <${StatCard}
          icon="❌"
          value="${formatNumber(
            (activity?.stats?.terminal?.errors || 0) +
              (activity?.stats?.telegram?.errors || 0)
          )}"
          label="Errors"
        />
      </div>

      <!-- Activity List -->
      <div class="card">
        <div class="card-body" style="padding: 0;">
          <div class="activity-list">
            ${(activity?.entries || []).map(
              (entry) => html`<${ActivityItem} entry=${entry} />`
            )}
            ${(!activity?.entries || activity.entries.length === 0) &&
            html`
              <div class="empty-state">
                <div class="empty-icon">📭</div>
                <p>No activity found</p>
              </div>
            `}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============================================
// Tools View
// ============================================
function ToolsView({ state }) {
  const { tools, filters } = state;

  const filteredTools = tools.filter(
    (tool) =>
      !filters.toolSearch ||
      tool.name.toLowerCase().includes(filters.toolSearch.toLowerCase()) ||
      tool.description?.toLowerCase().includes(filters.toolSearch.toLowerCase())
  );

  const handleSearch = debounce((e) => {
    setFilter('toolSearch', e.target.value);
  }, 200);

  return html`
    <div>
      <div class="page-header">
        <h1 class="page-title">Tools</h1>
        <p class="page-subtitle">${tools.length} registered tools</p>
      </div>

      <div class="search-box mb-lg">
        <span class="search-icon">🔍</span>
        <input
          type="text"
          class="input"
          placeholder="Search tools..."
          oninput=${handleSearch}
        />
      </div>

      <div class="grid grid-3">
        ${filteredTools.map(
          (tool) => html`
            <div class="card tool-card">
              <div class="tool-name">${tool.name}</div>
              <div class="tool-description">${tool.description || 'No description'}</div>
            </div>
          `
        )}
        ${filteredTools.length === 0 &&
        html`
          <div class="empty-state" style="grid-column: 1 / -1;">
            <div class="empty-icon">🔧</div>
            <p>${tools.length === 0 ? 'No tools registered' : 'No matching tools'}</p>
          </div>
        `}
      </div>
    </div>
  `;
}

// ============================================
// Cron View
// ============================================
function CronView({ state }) {
  const { cron } = state;

  return html`
    <div>
      <div class="page-header">
        <h1 class="page-title">Cron Jobs</h1>
        <p class="page-subtitle">Scheduled tasks and reminders</p>
      </div>

      <div class="card">
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Schedule</th>
                <th>Next Run</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${cron.map(
                (job) => html`
                  <tr>
                    <td>${job.name || job.id}</td>
                    <td class="font-mono text-sm">${job.schedule || job.expression || '-'}</td>
                    <td>${job.nextRun ? formatRelativeTime(job.nextRun) : '-'}</td>
                    <td>
                      <span
                        class="badge ${job.enabled !== false ? 'badge-success' : 'badge-warning'}"
                      >
                        ${job.enabled !== false ? 'Active' : 'Paused'}
                      </span>
                    </td>
                  </tr>
                `
              )}
              ${cron.length === 0 &&
              html`
                <tr>
                  <td colspan="4" class="text-center text-muted">No scheduled jobs</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// ============================================
// Metrics View
// ============================================
function MetricsView({ state }) {
  const { metrics } = state;

  const tools = metrics?.tools || {};
  const conversations = metrics?.conversations || {};
  const models = metrics?.models || [];

  return html`
    <div>
      <div class="page-header">
        <h1 class="page-title">Metrics</h1>
        <p class="page-subtitle">Tool usage and conversation statistics</p>
      </div>

      <!-- Tool Stats -->
      <div class="grid grid-4 mb-lg">
        <${StatCard}
          icon="🔧"
          value="${formatNumber(tools.totalToolCalls || 0)}"
          label="Total Tool Calls"
        />
        <${StatCard}
          icon="✅"
          value="${formatNumber(tools.successfulCalls || 0)}"
          label="Successful"
        />
        <${StatCard}
          icon="❌"
          value="${formatNumber(tools.failedCalls || 0)}"
          label="Failed"
        />
        <${StatCard}
          icon="⏱️"
          value="${tools.averageDuration ? tools.averageDuration.toFixed(0) + 'ms' : '-'}"
          label="Avg Duration"
        />
      </div>

      <!-- Conversation Stats -->
      <div class="grid grid-3 mb-lg">
        <${StatCard}
          icon="💬"
          value="${formatNumber(conversations.total || 0)}"
          label="Conversations"
        />
        <${StatCard}
          icon="📝"
          value="${(conversations.avgMessageCount || 0).toFixed(1)}"
          label="Avg Messages"
        />
        <${StatCard}
          icon="🛠️"
          value="${(conversations.avgToolCalls || 0).toFixed(1)}"
          label="Avg Tool Calls"
        />
      </div>

      <!-- Tool Breakdown -->
      <div class="card mb-lg">
        <div class="card-header">
          <span class="card-title">Tool Usage Breakdown</span>
        </div>
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Calls</th>
                <th>Success</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              ${Object.entries(tools.toolBreakdown || {}).map(
                ([tool, stats]) => html`
                  <tr>
                    <td class="font-mono text-sm">${tool}</td>
                    <td>${formatNumber(stats.calls || 0)}</td>
                    <td class="text-success">${formatNumber(stats.success || 0)}</td>
                    <td class="text-error">${formatNumber(stats.failed || 0)}</td>
                  </tr>
                `
              )}
              ${Object.keys(tools.toolBreakdown || {}).length === 0 &&
              html`
                <tr>
                  <td colspan="4" class="text-center text-muted">No tool usage data</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Recent Invocations -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Recent Tool Invocations</span>
        </div>
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              ${(metrics?.recentInvocations || []).slice(0, 10).map(
                (inv) => html`
                  <tr>
                    <td class="font-mono text-sm">${inv.tool}</td>
                    <td>
                      <span class="badge ${inv.success ? 'badge-success' : 'badge-error'}">
                        ${inv.success ? 'OK' : 'Error'}
                      </span>
                    </td>
                    <td>${inv.duration ? inv.duration + 'ms' : '-'}</td>
                    <td class="text-sm text-muted">${formatRelativeTime(inv.timestamp)}</td>
                  </tr>
                `
              )}
              ${(!metrics?.recentInvocations || metrics.recentInvocations.length === 0) &&
              html`
                <tr>
                  <td colspan="4" class="text-center text-muted">No recent invocations</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// ============================================
// Workspace View (SOUL, MEMORY, etc.)
// ============================================
function WorkspaceView({ state }) {
  const { workspace, selectedWorkspaceFile, loading } = state;

  const files = workspace?.files || [];
  const workspaceDir = workspace?.workspaceDir || '';

  const handleFileClick = (file) => {
    setState({ selectedWorkspaceFile: file });
  };

  const closeFileDetail = () => {
    setState({ selectedWorkspaceFile: null });
  };

  const categoryColors = {
    'Identity': 'badge-info',
    'Memory': 'badge-success',
    'Tools': 'badge-warning',
    'User': 'badge-secondary',
    'Agent': 'badge-info',
    'Heartbeat': 'badge-warning',
    'Bootstrap': 'badge-secondary',
    'Other': 'badge-secondary',
  };

  return html`
    <div>
      <div class="page-header">
        <h1 class="page-title">Workspace</h1>
        <p class="page-subtitle">Agent identity and context files</p>
      </div>

      <!-- Workspace Info -->
      <div class="card mb-lg">
        <div class="card-body">
          <div class="flex justify-between items-center">
            <div>
              <span class="text-muted text-sm">Workspace Directory:</span>
              <span class="font-mono text-sm ml-sm">${workspaceDir}</span>
            </div>
            <button class="btn btn-secondary" onclick=${() => fetchWorkspace()}>
              Refresh
            </button>
          </div>
        </div>
      </div>

      <!-- Files Grid -->
      <div class="grid grid-2">
        ${files.map(
          (file) => html`
            <div
              class="card workspace-file-card"
              style="cursor: pointer"
              onclick=${() => handleFileClick(file)}
            >
              <div class="card-header">
                <span class="card-title">${file.name}</span>
                <span class="badge ${categoryColors[file.category] || 'badge-secondary'}">
                  ${file.category}
                </span>
              </div>
              <div class="card-body">
                <div class="text-sm text-muted mb-sm font-mono">${file.path}</div>
                <div class="text-sm workspace-preview">${file.contentPreview}</div>
                <div class="text-xs text-muted mt-sm">
                  ${formatNumber(file.contentLength)} characters
                </div>
              </div>
            </div>
          `
        )}
        ${files.length === 0 &&
        html`
          <div class="empty-state" style="grid-column: 1 / -1;">
            <div class="empty-icon">📄</div>
            <p>${loading.workspace ? 'Loading workspace files...' : 'No workspace files found'}</p>
          </div>
        `}
      </div>

      <!-- File Detail Modal -->
      ${selectedWorkspaceFile &&
      html`
        <div class="modal-overlay" onclick=${closeFileDetail}>
          <div class="modal modal-large" onclick=${(e) => e.stopPropagation()}>
            <div class="modal-header">
              <div>
                <h2>${selectedWorkspaceFile.name}</h2>
                <div class="text-sm text-muted font-mono">${selectedWorkspaceFile.path}</div>
              </div>
              <button class="btn btn-sm" onclick=${closeFileDetail}>✕</button>
            </div>
            <div class="modal-body">
              <pre class="workspace-content">${selectedWorkspaceFile.fullContent}</pre>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

// ============================================
// Events View (Database Logs)
// ============================================
function EventsView({ state }) {
  const { events, eventTypes, filters, loading } = state;

  const handleChannelChange = (channel) => {
    setFilter('eventChannel', channel || null);
    fetchEvents({
      channel,
      type: filters.eventType,
      level: filters.eventLevel,
      limit: filters.eventLimit,
    });
  };

  const handleTypeChange = (type) => {
    setFilter('eventType', type || null);
    fetchEvents({
      channel: filters.eventChannel,
      type,
      level: filters.eventLevel,
      limit: filters.eventLimit,
    });
  };

  const handleLevelChange = (level) => {
    setFilter('eventLevel', level || null);
    fetchEvents({
      channel: filters.eventChannel,
      type: filters.eventType,
      level,
      limit: filters.eventLimit,
    });
  };

  const levelColors = {
    error: 'badge-error',
    warn: 'badge-warning',
    info: 'badge-info',
    debug: 'badge-secondary',
  };

  return html`
    <div>
      <div class="page-header">
        <h1 class="page-title">Events</h1>
        <p class="page-subtitle">Database event log with filtering</p>
      </div>

      <!-- Filters -->
      <div class="card mb-lg">
        <div class="card-body">
          <div class="flex gap-md flex-wrap">
            <select
              class="input"
              style="width: auto"
              onchange=${(e) => handleChannelChange(e.target.value)}
            >
              <option value="">All Channels</option>
              ${(eventTypes?.channels || []).map(
                (ch) => html`<option value=${ch}>${ch}</option>`
              )}
            </select>
            <select
              class="input"
              style="width: auto"
              onchange=${(e) => handleTypeChange(e.target.value)}
            >
              <option value="">All Types</option>
              ${(eventTypes?.eventTypes || []).map(
                (t) => html`<option value=${t}>${t}</option>`
              )}
            </select>
            <select
              class="input"
              style="width: auto"
              onchange=${(e) => handleLevelChange(e.target.value)}
            >
              <option value="">All Levels</option>
              ${(eventTypes?.levels || []).map(
                (l) => html`<option value=${l}>${l}</option>`
              )}
            </select>
            <button
              class="btn btn-secondary"
              onclick=${() =>
                fetchEvents({
                  channel: filters.eventChannel,
                  type: filters.eventType,
                  level: filters.eventLevel,
                  limit: filters.eventLimit,
                })}
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      <!-- Events Table -->
      <div class="card">
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Level</th>
                <th>Type</th>
                <th>Channel</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              ${events.map(
                (event) => html`
                  <tr>
                    <td class="text-sm text-muted">${formatRelativeTime(event.timestamp)}</td>
                    <td>
                      <span class="badge ${levelColors[event.level] || 'badge-secondary'}">
                        ${event.level}
                      </span>
                    </td>
                    <td class="font-mono text-sm">${event.eventType}</td>
                    <td>${event.channel || '-'}</td>
                    <td class="text-sm">${truncate(event.message, 80)}</td>
                  </tr>
                `
              )}
              ${events.length === 0 &&
              html`
                <tr>
                  <td colspan="5" class="text-center text-muted">
                    ${loading.events ? 'Loading...' : 'No events found'}
                  </td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// ============================================
// Enhanced Sessions View with Drill-down
// ============================================
function SessionsView({ state }) {
  const { sessions, dbSessions, selectedSession, filters, loading } = state;

  const handleChannelFilter = (channel) => {
    setFilter('sessionChannel', channel || null);
    fetchDbSessions({ channel, limit: 50 });
  };

  const handleSessionClick = (sessionId) => {
    fetchSessionMessages(sessionId);
  };

  const closeSessionDetail = () => {
    setState({ selectedSession: null });
  };

  const handleSyncSession = async (sessionId) => {
    try {
      await triggerMemorySync(sessionId);
      alert('Session synced to memory!');
    } catch (error) {
      alert('Sync failed: ' + error.message);
    }
  };

  return html`
    <div>
      <div class="page-header">
        <h1 class="page-title">Sessions</h1>
        <p class="page-subtitle">Active conversation sessions</p>
      </div>

      <!-- Summary Stats -->
      <div class="grid grid-2 mb-lg">
        <div class="card">
          <div class="card-header">
            <span class="card-title">Terminal Sessions</span>
          </div>
          <div class="card-body">
            <div class="flex flex-col gap-md">
              <div class="flex justify-between">
                <span class="text-muted">Messages</span>
                <span>${formatNumber(sessions?.terminal?.messages || 0)}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted">Tool Calls</span>
                <span>${formatNumber(sessions?.terminal?.toolCalls || 0)}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted">Errors</span>
                <span class="text-error">${formatNumber(sessions?.terminal?.errors || 0)}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Telegram Sessions</span>
          </div>
          <div class="card-body">
            <div class="flex flex-col gap-md">
              <div class="flex justify-between">
                <span class="text-muted">Messages</span>
                <span>${formatNumber(sessions?.telegram?.messages || 0)}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted">Tool Calls</span>
                <span>${formatNumber(sessions?.telegram?.toolCalls || 0)}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted">Errors</span>
                <span class="text-error">${formatNumber(sessions?.telegram?.errors || 0)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Session List from Database -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Recent Sessions</span>
          <select
            class="input"
            style="width: auto; margin-left: auto"
            onchange=${(e) => handleChannelFilter(e.target.value)}
          >
            <option value="">All Channels</option>
            <option value="terminal">Terminal</option>
            <option value="telegram">Telegram</option>
          </select>
        </div>
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Session</th>
                <th>User</th>
                <th>Channel</th>
                <th>Model</th>
                <th>Messages</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${dbSessions.map(
                (session) => html`
                  <tr
                    style="cursor: pointer"
                    onclick=${() => handleSessionClick(session.id)}
                  >
                    <td class="font-mono text-sm">${session.id.slice(0, 8)}...</td>
                    <td>${session.user_id || '-'}</td>
                    <td>
                      <span class="badge">${session.channel}</span>
                    </td>
                    <td class="text-sm">${session.model || '-'}</td>
                    <td>${session.message_count || 0}</td>
                    <td class="text-sm text-muted">
                      ${formatRelativeTime(session.updated_at)}
                    </td>
                    <td>
                      <button
                        class="btn btn-sm btn-secondary"
                        onclick=${(e) => {
                          e.stopPropagation();
                          handleSyncSession(session.id);
                        }}
                        title="Sync to memory"
                      >
                        🧠
                      </button>
                    </td>
                  </tr>
                `
              )}
              ${dbSessions.length === 0 &&
              html`
                <tr>
                  <td colspan="7" class="text-center text-muted">
                    ${loading.dbSessions ? 'Loading...' : 'No sessions found'}
                  </td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Session Detail Modal -->
      ${selectedSession &&
      html`
        <div class="modal-overlay" onclick=${closeSessionDetail}>
          <div class="modal" onclick=${(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Session: ${selectedSession.id.slice(0, 12)}...</h2>
              <button class="btn btn-sm" onclick=${closeSessionDetail}>✕</button>
            </div>
            <div class="modal-body">
              <div class="flex gap-md mb-md text-sm">
                <span><strong>User:</strong> ${selectedSession.userId}</span>
                <span><strong>Channel:</strong> ${selectedSession.channel}</span>
                <span><strong>Model:</strong> ${selectedSession.model}</span>
              </div>
              <div class="conversation">
                ${(selectedSession.messages || []).map(
                  (msg) => html`
                    <div class="message message-${msg.role}">
                      <div class="message-role">${msg.role}</div>
                      <div class="message-content">
                        ${msg.content.length > 500
                          ? msg.content.slice(0, 500) + '...'
                          : msg.content}
                      </div>
                      ${msg.toolCalls &&
                      html`
                        <div class="message-tools">
                          Tools: ${msg.toolCalls.map((tc) => tc.function?.name).join(', ')}
                        </div>
                      `}
                    </div>
                  `
                )}
                ${(!selectedSession.messages || selectedSession.messages.length === 0) &&
                html`<div class="text-muted text-center">No messages</div>`}
              </div>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

// ============================================
// Memory View
// ============================================
function MemoryView({ state }) {
  const { memory, memoryHistory, loading } = state;

  const handleSync = async () => {
    try {
      await triggerMemorySync();
      alert('Memory sync triggered!');
    } catch (error) {
      alert('Sync failed: ' + error.message);
    }
  };

  const memStatus = memory?.memory || {};
  const syncStatus = memory?.sync || {};
  const serviceStats = syncStatus.service || {};

  return html`
    <div>
      <div class="page-header">
        <h1 class="page-title">Memory</h1>
        <p class="page-subtitle">Session-to-memory sync and status</p>
      </div>

      <!-- Memory Stats -->
      <div class="grid grid-4 mb-lg">
        <${StatCard}
          icon="📁"
          value="${memStatus.fileCount || 0}"
          label="Indexed Files"
        />
        <${StatCard}
          icon="📝"
          value="${memStatus.chunkCount || 0}"
          label="Memory Chunks"
        />
        <${StatCard}
          icon="🔄"
          value="${syncStatus.total || 0}"
          label="Sessions Synced"
        />
        <${StatCard}
          icon="⏱️"
          value="${syncStatus.lastSync ? formatRelativeTime(syncStatus.lastSync) : 'Never'}"
          label="Last Sync"
        />
      </div>

      <!-- Sync Controls -->
      <div class="card mb-lg">
        <div class="card-header">
          <span class="card-title">Memory Sync Service</span>
          <span class="badge ${serviceStats.running ? 'badge-success' : 'badge-warning'}">
            ${serviceStats.running ? 'Running' : 'Stopped'}
          </span>
        </div>
        <div class="card-body">
          <div class="flex gap-md flex-wrap">
            <div class="flex flex-col gap-sm">
              <span class="text-muted text-sm">Sync Interval</span>
              <span>${formatDuration(serviceStats.intervalMs || 0)}</span>
            </div>
            <div class="flex flex-col gap-sm">
              <span class="text-muted text-sm">Min Idle Time</span>
              <span>${formatDuration(serviceStats.minIdleMs || 0)}</span>
            </div>
            <div class="flex flex-col gap-sm">
              <span class="text-muted text-sm">Channels</span>
              <span>${(serviceStats.channels || []).join(', ') || '-'}</span>
            </div>
            <div style="margin-left: auto">
              <button class="btn btn-primary" onclick=${handleSync}>
                🔄 Trigger Sync
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Sync by Channel -->
      <div class="grid grid-2 mb-lg">
        ${Object.entries(syncStatus.byChannel || {}).map(
          ([channel, count]) => html`
            <div class="card">
              <div class="card-body">
                <div class="flex justify-between">
                  <span class="text-muted">${channel}</span>
                  <span class="text-lg font-bold">${count} synced</span>
                </div>
              </div>
            </div>
          `
        )}
      </div>

      <!-- Memory Files -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Recent Memory Files</span>
        </div>
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>File</th>
                <th>Chunks</th>
                <th>Last Modified</th>
              </tr>
            </thead>
            <tbody>
              ${(memStatus.files || []).map(
                (file) => html`
                  <tr>
                    <td class="font-mono text-sm">${file.path}</td>
                    <td>${file.chunks}</td>
                    <td class="text-sm text-muted">
                      ${formatRelativeTime(file.lastModified)}
                    </td>
                  </tr>
                `
              )}
              ${(!memStatus.files || memStatus.files.length === 0) &&
              html`
                <tr>
                  <td colspan="3" class="text-center text-muted">No memory files indexed</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// ============================================
// Chat View (Interactive conversation)
// ============================================
class ChatView extends Component {
  constructor(props) {
    super(props);
    this.inputRef = null;
    this.messagesEndRef = null;
    this.localState = {
      inputValue: '',
      models: [],
      selectedModel: null,
    };
  }

  async componentDidMount() {
    // Fetch available models
    const models = await fetchChatModels();
    this.localState.models = models;
    this.forceUpdate();

    // Auto-scroll to bottom when messages change
    this.scrollToBottom();
  }

  componentDidUpdate() {
    this.scrollToBottom();
  }

  scrollToBottom() {
    if (this.messagesEndRef) {
      this.messagesEndRef.scrollIntoView({ behavior: 'smooth' });
    }
  }

  handleStartSession = async () => {
    try {
      await startChatSession(this.localState.selectedModel);
      if (this.inputRef) {
        this.inputRef.focus();
      }
    } catch (error) {
      console.error('Failed to start session:', error);
    }
  };

  handleSendMessage = async (e) => {
    e.preventDefault();
    const content = this.localState.inputValue.trim();
    if (!content) return;

    this.localState.inputValue = '';
    this.forceUpdate();

    try {
      await sendChatMessage(content);
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  };

  handleInputChange = (e) => {
    this.localState.inputValue = e.target.value;
    this.forceUpdate();
  };

  handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleSendMessage(e);
    }
  };

  handleModelChange = (e) => {
    this.localState.selectedModel = e.target.value || null;
    this.forceUpdate();
  };

  handleNewChat = () => {
    clearChat();
  };

  handleLoadSession = async (sessionId) => {
    try {
      await loadChatSession(sessionId);
    } catch (error) {
      console.error('Failed to load session:', error);
    }
  };

  render() {
    const { state } = this.props;
    const { chat, dbSessions, loading } = state;
    const { models, inputValue, selectedModel } = this.localState;

    const hasSession = !!chat.sessionId;
    const isStreaming = chat.streaming;

    return html`
      <div class="chat-container">
        <div class="page-header">
          <h1 class="page-title">Chat</h1>
          <p class="page-subtitle">Interactive conversation with the agent</p>
        </div>

        <div class="chat-layout">
          <!-- Sidebar with session list -->
          <div class="chat-sidebar">
            <div class="card">
              <div class="card-header">
                <span class="card-title">Sessions</span>
              </div>
              <div class="card-body" style="padding: 0; max-height: 300px; overflow-y: auto;">
                ${(dbSessions || []).slice(0, 10).map(
                  (session) => html`
                    <div
                      class="chat-session-item ${chat.sessionId === session.id ? 'active' : ''}"
                      onclick=${() => this.handleLoadSession(session.id)}
                    >
                      <div class="chat-session-id">${session.id.slice(0, 8)}...</div>
                      <div class="chat-session-meta">
                        ${session.message_count || 0} msgs • ${formatRelativeTime(session.updated_at)}
                      </div>
                    </div>
                  `
                )}
                ${(!dbSessions || dbSessions.length === 0) &&
                html`<div class="text-muted text-sm p-md">No sessions</div>`}
              </div>
            </div>

            <!-- Model selection -->
            <div class="card mt-md">
              <div class="card-header">
                <span class="card-title">Model</span>
              </div>
              <div class="card-body">
                <select
                  class="input"
                  value=${selectedModel || ''}
                  onchange=${this.handleModelChange}
                  disabled=${hasSession}
                >
                  <option value="">Default</option>
                  ${models.map(
                    (model) => html`<option value=${model.name}>${model.name}</option>`
                  )}
                </select>
                ${chat.model && html`
                  <div class="text-sm text-muted mt-sm">
                    Current: ${chat.model}
                  </div>
                `}
              </div>
            </div>
          </div>

          <!-- Main chat area -->
          <div class="chat-main">
            ${!hasSession
              ? html`
                  <!-- No session - show start button -->
                  <div class="chat-empty">
                    <div class="empty-icon">💬</div>
                    <h3>Start a Conversation</h3>
                    <p class="text-muted">Select a model and start chatting with the agent</p>
                    <button
                      class="btn btn-primary btn-lg mt-md"
                      onclick=${this.handleStartSession}
                      disabled=${loading.chat}
                    >
                      ${loading.chat ? 'Starting...' : 'New Chat'}
                    </button>
                  </div>
                `
              : html`
                  <!-- Active session -->
                  <div class="chat-messages">
                    ${chat.messages.map(
                      (msg) => html`
                        <div class="chat-message chat-message-${msg.role}">
                          <div class="chat-message-role">${msg.role}</div>
                          <div class="chat-message-content">
                            ${msg.role === 'tool'
                              ? html`<div class="tool-result">
                                  <strong>${msg.name}</strong>
                                  <pre>${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}</pre>
                                </div>`
                              : msg.content}
                          </div>
                          ${msg.toolCalls &&
                          msg.toolCalls.length > 0 &&
                          html`
                            <div class="chat-message-tools">
                              Tools: ${msg.toolCalls.map((tc) => tc.function?.name).join(', ')}
                            </div>
                          `}
                        </div>
                      `
                    )}

                    <!-- Streaming response -->
                    ${isStreaming &&
                    html`
                      <div class="chat-message chat-message-assistant">
                        <div class="chat-message-role">assistant</div>
                        <div class="chat-message-content">
                          ${chat.streamingContent || html`<span class="typing-indicator">...</span>`}
                        </div>
                      </div>
                    `}

                    <!-- Error display -->
                    ${chat.error &&
                    html`
                      <div class="chat-error">
                        Error: ${chat.error}
                      </div>
                    `}

                    <div ref=${(el) => (this.messagesEndRef = el)}></div>
                  </div>

                  <!-- Input area -->
                  <form class="chat-input-area" onsubmit=${this.handleSendMessage}>
                    <div class="chat-input-container">
                      <textarea
                        ref=${(el) => (this.inputRef = el)}
                        class="chat-input"
                        placeholder="Type a message..."
                        value=${inputValue}
                        oninput=${this.handleInputChange}
                        onkeydown=${this.handleKeyDown}
                        disabled=${isStreaming}
                        rows="1"
                      ></textarea>
                      <button
                        type="submit"
                        class="btn btn-primary chat-send-btn"
                        disabled=${isStreaming || !inputValue.trim()}
                      >
                        ${isStreaming ? '...' : '→'}
                      </button>
                    </div>
                    <div class="chat-input-actions">
                      <button
                        type="button"
                        class="btn btn-sm btn-secondary"
                        onclick=${this.handleNewChat}
                      >
                        New Chat
                      </button>
                      <span class="text-sm text-muted">
                        Session: ${chat.sessionId?.slice(0, 8)}...
                      </span>
                    </div>
                  </form>
                `}
          </div>
        </div>
      </div>
    `;
  }
}

// ============================================
// Main App Component
// ============================================
class App extends Component {
  constructor() {
    super();
    this.state = getState();
  }

  componentDidMount() {
    // Subscribe to state changes
    this.unsubscribe = subscribe((state) => {
      this.setState(state);
    });

    // Initial data fetch
    fetchAll();

    // Fetch new dashboard data
    fetchEvents({ limit: 100 });
    fetchEventTypes();
    fetchDbSessions({ limit: 50 });
    fetchMemoryStatus();
    fetchWorkspace();

    // Connect WebSocket
    connectWebSocket();

    // Periodic refresh
    this.refreshInterval = setInterval(() => {
      fetchHealth();
    }, 30000);
  }

  componentWillUnmount() {
    if (this.unsubscribe) this.unsubscribe();
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }

  renderView() {
    const { view } = this.state;

    switch (view) {
      case 'chat':
        return html`<${ChatView} state=${this.state} />`;
      case 'workspace':
        return html`<${WorkspaceView} state=${this.state} />`;
      case 'events':
        return html`<${EventsView} state=${this.state} />`;
      case 'sessions':
        return html`<${SessionsView} state=${this.state} />`;
      case 'memory':
        return html`<${MemoryView} state=${this.state} />`;
      case 'activity':
        return html`<${ActivityView} state=${this.state} />`;
      case 'tools':
        return html`<${ToolsView} state=${this.state} />`;
      case 'cron':
        return html`<${CronView} state=${this.state} />`;
      case 'metrics':
        return html`<${MetricsView} state=${this.state} />`;
      case 'dashboard':
      default:
        return html`<${DashboardView} state=${this.state} />`;
    }
  }

  render() {
    const { connected, theme, view } = this.state;

    return html`
      <${Header} connected=${connected} theme=${theme} />
      <div class="app-container">
        <${Sidebar} view=${view} />
        <main class="main-content">${this.renderView()}</main>
      </div>
    `;
  }
}

// ============================================
// Mount Application
// ============================================
render(html`<${App} />`, document.getElementById('app'));
