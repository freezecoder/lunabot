/**
 * Unified Dashboard - Monitor both terminal and Telegram bot activity
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { readFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getSystemStats, getOllamaStats, formatBytes, formatUptime, getCompactStatus } from '../utils/system-monitor.js';
import { readActivityLog, getRecentActivity, type ActivityEntry } from '../utils/activity-tracker.js';
import 'dotenv/config';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://100.121.61.16:11434';
const REFRESH_INTERVAL = 2000; // 2 seconds

// Paths
const TERMINAL_SESSIONS_PATH = join(homedir(), '.localbot', 'sessions', 'sessions.json');
const TELEGRAM_SESSIONS_PATH = join(homedir(), '.localbot', 'telegram-sessions.json');
const ACTIVITY_PATH = join(homedir(), '.localbot', 'activity.json');
const BOT_LOG_PATH = join(homedir(), '.localbot', 'logs', 'bot.log');

// Colors
const colors = {
  header: chalk.bold.cyan,
  section: chalk.bold.white,
  label: chalk.gray,
  value: chalk.white,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  terminal: chalk.cyan,
  telegram: chalk.magenta,
  dim: chalk.dim,
};

interface SessionInfo {
  count: number;
  totalMessages: number;
  lastActivity?: Date;
}

/**
 * Read terminal sessions info
 */
function getTerminalSessionsInfo(): SessionInfo {
  try {
    if (!existsSync(TERMINAL_SESSIONS_PATH)) {
      return { count: 0, totalMessages: 0 };
    }
    const data = JSON.parse(readFileSync(TERMINAL_SESSIONS_PATH, 'utf-8'));
    const sessions = data.sessions || [];
    let totalMessages = 0;
    let lastActivity: Date | undefined;

    for (const session of sessions) {
      totalMessages += session.messages?.length || 0;
      const updated = new Date(session.updatedAt);
      if (!lastActivity || updated > lastActivity) {
        lastActivity = updated;
      }
    }

    return { count: sessions.length, totalMessages, lastActivity };
  } catch {
    return { count: 0, totalMessages: 0 };
  }
}

/**
 * Read telegram sessions info
 */
function getTelegramSessionsInfo(): SessionInfo {
  try {
    if (!existsSync(TELEGRAM_SESSIONS_PATH)) {
      return { count: 0, totalMessages: 0 };
    }
    const sessions = JSON.parse(readFileSync(TELEGRAM_SESSIONS_PATH, 'utf-8'));
    let totalMessages = 0;
    let lastActivity: Date | undefined;

    for (const session of sessions) {
      totalMessages += session.messages?.length || 0;
      const updated = new Date(session.updatedAt);
      if (!lastActivity || updated > lastActivity) {
        lastActivity = updated;
      }
    }

    return { count: sessions.length, totalMessages, lastActivity };
  } catch {
    return { count: 0, totalMessages: 0 };
  }
}

/**
 * Get last N lines from bot log
 */
function getBotLogTail(lines: number = 5): string[] {
  try {
    if (!existsSync(BOT_LOG_PATH)) {
      return ['(no log file)'];
    }
    const content = readFileSync(BOT_LOG_PATH, 'utf-8');
    const allLines = content.trim().split('\n');
    return allLines.slice(-lines);
  } catch {
    return ['(error reading log)'];
  }
}

/**
 * Format relative time
 */
function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Format activity entry
 */
function formatActivity(entry: ActivityEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const source = entry.source === 'terminal'
    ? colors.terminal('TUI')
    : entry.source === 'cron'
    ? colors.dim('CRON')
    : colors.telegram('TG ');

  const typeIcon = {
    message: '💬',
    tool_call: '🔧',
    error: '❌',
    session: '👤',
    status: 'ℹ️',
    reminder: '🔔',
    attachment: '📎',
  }[entry.type] || '•';

  const content = entry.content.slice(0, 50) + (entry.content.length > 50 ? '...' : '');

  return `${colors.dim(time)} ${source} ${typeIcon} ${content}`;
}

/**
 * Render the dashboard
 */
async function render(): Promise<void> {
  console.clear();

  // Header
  console.log(colors.header(`
╔══════════════════════════════════════════════════════════════╗
║                    📊 LocalBot Dashboard                     ║
╚══════════════════════════════════════════════════════════════╝
`));

  // System Stats
  const sysStats = getSystemStats();
  const ollamaStats = await getOllamaStats(OLLAMA_HOST);

  console.log(colors.section('System'));
  console.log(`  ${colors.label('Memory:')} ${formatBytes(sysStats.memoryUsed)} / ${formatBytes(sysStats.memoryTotal)} (${sysStats.memoryPercent.toFixed(0)}%)`);
  console.log(`  ${colors.label('CPU:')} Load ${sysStats.cpuLoad[0].toFixed(2)} | ${sysStats.cpuCount} cores`);
  console.log(`  ${colors.label('Uptime:')} ${formatUptime(sysStats.uptime)}`);
  console.log();

  // Ollama Status
  console.log(colors.section('Ollama'));
  if (ollamaStats.running) {
    console.log(`  ${colors.label('Status:')} ${colors.success('● Running')} at ${OLLAMA_HOST}`);
    if (ollamaStats.activeModel) {
      console.log(`  ${colors.label('Active:')} ${ollamaStats.activeModel}`);
    }
    if (ollamaStats.vram) {
      console.log(`  ${colors.label('VRAM:')} ${formatBytes(ollamaStats.vram)}`);
    }
    console.log(`  ${colors.label('Models:')} ${ollamaStats.models?.length || 0} available`);
  } else {
    console.log(`  ${colors.label('Status:')} ${colors.error('● Not responding')}`);
  }
  console.log();

  // Sessions
  const terminalInfo = getTerminalSessionsInfo();
  const telegramInfo = getTelegramSessionsInfo();

  console.log(colors.section('Sessions'));
  console.log(`  ${colors.terminal('Terminal:')} ${terminalInfo.count} session(s), ${terminalInfo.totalMessages} messages` +
    (terminalInfo.lastActivity ? ` (${formatRelativeTime(terminalInfo.lastActivity)})` : ''));
  console.log(`  ${colors.telegram('Telegram:')} ${telegramInfo.count} session(s), ${telegramInfo.totalMessages} messages` +
    (telegramInfo.lastActivity ? ` (${formatRelativeTime(telegramInfo.lastActivity)})` : ''));
  console.log();

  // Activity Stats
  const activityLog = readActivityLog();
  console.log(colors.section('Activity Stats'));
  console.log(`  ${colors.terminal('Terminal:')} ${activityLog.stats.terminal.messages} msgs, ${activityLog.stats.terminal.toolCalls} tools, ${activityLog.stats.terminal.errors} errors`);
  console.log(`  ${colors.telegram('Telegram:')} ${activityLog.stats.telegram.messages} msgs, ${activityLog.stats.telegram.toolCalls} tools, ${activityLog.stats.telegram.errors} errors`);
  console.log();

  // Recent Activity
  const recentActivity = getRecentActivity(8);
  console.log(colors.section('Recent Activity'));
  if (recentActivity.length === 0) {
    console.log(colors.dim('  No recent activity'));
  } else {
    for (const entry of recentActivity) {
      console.log(`  ${formatActivity(entry)}`);
    }
  }
  console.log();

  // Bot Log Tail
  console.log(colors.section('Bot Log (tail)'));
  const logLines = getBotLogTail(4);
  for (const line of logLines) {
    console.log(colors.dim(`  ${line.slice(0, 70)}`));
  }
  console.log();

  // Footer
  console.log(chalk.gray('─'.repeat(64)));
  console.log(colors.dim(`  Refreshing every ${REFRESH_INTERVAL / 1000}s | Press 'q' to quit, 'r' to refresh, 'c' to clear activity`));
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Initial render
  await render();

  // Set up auto-refresh
  const refreshTimer = setInterval(render, REFRESH_INTERVAL);

  // Set up keyboard input
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  process.stdin.on('keypress', async (str, key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      clearInterval(refreshTimer);
      console.clear();
      console.log('👋 Dashboard closed');
      process.exit(0);
    }

    if (key.name === 'r') {
      await render();
    }

    if (key.name === 'c') {
      const { clearActivityLog } = await import('../utils/activity-tracker.js');
      clearActivityLog();
      await render();
    }
  });

  // Handle SIGINT
  process.on('SIGINT', () => {
    clearInterval(refreshTimer);
    console.clear();
    console.log('👋 Dashboard closed');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Dashboard error:', err);
  process.exit(1);
});
